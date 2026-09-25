import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  edgeSegmentCount, createVectorLines, createVectorStrokes, torusStrokes,
  projectedRadiusPx, farFade,
  GLOW_TIERS, CORE_WHITE, CREASE_DEG, FAR_MIN_OPACITY, FAR_FADE_PX, OCCLUDER_SHRINK,
  cylinderOccluder, hullOccluder, portOccluder, asteroidGeometry, asteroidStrokes, asteroidEdges,
  creaseEdges, frontFacingEdges, createCulledStrokes, ORDER_STRIDE,
} from '../src/render/vector';
import { BLOOM_STRENGTH, PHOSPHOR_DECAY } from '../src/render/post';

describe('vector strokes', () => {
  it('draws a cone as twelve spokes and a rim, not a fan of triangles', () => {
    const cone = new THREE.ConeGeometry(1.2, 5, 12);
    expect(edgeSegmentCount(cone)).toBe(24);
    expect(new THREE.WireframeGeometry(cone).getAttribute('position').count / 2).toBeGreaterThan(24);
    expect(CREASE_DEG).toBeGreaterThan(0);
  });

  it('draws a torus as hoops and longitudes, every one present', () => {
    const seg = torusStrokes(3, 0.18, 24, 6, 8, 48);
    expect(seg.length / 6).toBe(24 * 8 + 6 * 48);
    for (let i = 0; i < seg.length; i += 3) {
      const x = seg[i]!, y = seg[i + 1]!, z = seg[i + 2]!;
      expect(Math.hypot(Math.hypot(x, y) - 3, z)).toBeCloseTo(0.18, 5);
    }
  });
});

describe('hidden lines: every solid carries a depth-only occluder', () => {
  const extent = (g: THREE.BufferGeometry) => {
    g.computeBoundingSphere();
    return g.boundingSphere!.radius;
  };

  it('a mesh-derived stroke set gets its own geometry back, shrunk, writing depth and no colour', () => {
    const cone = new THREE.ConeGeometry(1.2, 5, 12);
    const s = createVectorLines(cone, 0x9fd9cc);
    expect(s.occluder).not.toBeNull();
    const m = s.occluder!.material as THREE.MeshBasicMaterial;
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.depthTest).toBe(true);
    expect(s.occluder!.renderOrder).toBeLessThan(Math.min(...s.tiers.map((t) => t.renderOrder)));
    expect(extent(s.occluder!.geometry)).toBeCloseTo(extent(cone) * OCCLUDER_SHRINK, 6);
    expect(OCCLUDER_SHRINK).toBeLessThan(1);
    expect(OCCLUDER_SHRINK).toBeGreaterThan(0.98); // a hair inside, not visibly smaller
    s.dispose();
  });

  it('parametric occluders sit just inside their strokes', () => {
    const cyl = cylinderOccluder(10, 20, 60);
    cyl.computeBoundingBox();
    const b = cyl.boundingBox!;
    expect(b.max.x).toBeCloseTo(10 * OCCLUDER_SHRINK, 5);
    expect(b.min.z).toBeGreaterThan(20);
    expect(b.max.z).toBeLessThan(60);
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(40, 6);

    const hull = hullOccluder([{ radius: 5, from: 0, to: 10 }, { radius: 8, from: 10, to: 30 }], new Set([1]));
    hull.computeBoundingBox();
    expect(hull.boundingBox!.max.x).toBeCloseTo(5 * OCCLUDER_SHRINK, 5); // section 1 skipped

    // the port's hole must stay a hole: no geometry inside the ring's inner radius at the plane
    const port = portOccluder(3, 0.18, 1.5);
    const p = port.getAttribute('position');
    let minInPlane = Infinity;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getZ(i)) < 0.2) minInPlane = Math.min(minInPlane, Math.hypot(p.getX(i), p.getY(i)));
    }
    expect(minInPlane).toBeGreaterThan(3 - 0.18 - 1e-6);

    // the rock's solid is the same rock its edges came from: same farthest point
    const solid = asteroidGeometry(10, 77);
    const edges = asteroidStrokes(10, 77);
    let maxEdge = 0, maxSolid = 0;
    for (let i = 0; i < edges.length; i += 3) maxEdge = Math.max(maxEdge, Math.hypot(edges[i]!, edges[i + 1]!, edges[i + 2]!));
    const sp = solid.getAttribute('position');
    for (let i = 0; i < sp.count; i++) maxSolid = Math.max(maxSolid, Math.hypot(sp.getX(i), sp.getY(i), sp.getZ(i)));
    expect(maxSolid).toBeCloseTo(maxEdge, 4);
  });
});

describe('the glow is in the stroke, not a blur', () => {
  it('draws every stroke set in tiers: a core and wider, dimmer bands, all normal-blended', () => {
    const s = createVectorLines(new THREE.ConeGeometry(1, 2, 8), 0x9fd9cc);
    expect(s.tiers.length).toBe(GLOW_TIERS.length);
    expect(GLOW_TIERS.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < s.tiers.length; i++) {
      const m = s.tiers[i]!.material as any;
      expect(m.linewidth).toBe(GLOW_TIERS[i]![0]);
      expect(m.opacity).toBeCloseTo(GLOW_TIERS[i]![1], 9);
      // normal blending is the whole point: overlapping halos converge on the halo
      // colour instead of summing, so a pile of lines cannot become a sun
      expect(m.blending).toBe(THREE.NormalBlending);
      expect(m.depthWrite).toBe(false);
      if (i > 0) {
        expect(GLOW_TIERS[i]![0]).toBeGreaterThan(GLOW_TIERS[i - 1]![0]);
        expect(GLOW_TIERS[i]![1]).toBeLessThan(GLOW_TIERS[i - 1]![1]);
      }
    }
    // the core is pushed toward white; every band keeps the stroke colour
    const coreColor = (s.tiers[0]!.material as any).color as THREE.Color;
    const bandColor = (s.tiers[1]!.material as any).color as THREE.Color;
    expect(bandColor.getHex()).toBe(0x9fd9cc);
    expect(coreColor.r + coreColor.g + coreColor.b).toBeGreaterThan(bandColor.r + bandColor.g + bandColor.b);
    expect(CORE_WHITE).toBeGreaterThan(0);
    expect(CORE_WHITE).toBeLessThan(1);
    // one geometry shared by all tiers
    expect(new Set(s.tiers.map((t) => t.geometry)).size).toBe(1);
    // widest band drawn first, core last, so the core sits on its halo
    const orders = s.tiers.map((t) => t.renderOrder);
    expect(orders).toEqual([...orders].sort((a, b) => b - a));
    s.dispose();
  });

  it('stencils each tier so a joint blends once: no bead where two caps overlap', () => {
    const a = createVectorStrokes(torusStrokes(3, 0.18), 0xffb347);
    const b = createVectorLines(new THREE.ConeGeometry(1, 2, 8), 0x9fd9cc);
    const refs = (s: typeof a) => s.tiers.map((t) => (t.material as any).stencilRef as number);
    for (const set of [a, b]) {
      for (const t of set.tiers) {
        const m = t.material as any;
        expect(m.stencilWrite).toBe(true);
        expect(m.stencilFunc).toBe(THREE.NotEqualStencilFunc);
        expect(m.stencilZPass).toBe(THREE.ReplaceStencilOp);
      }
      // every tier of a set has its own reference value
      expect(new Set(refs(set)).size).toBe(GLOW_TIERS.length);
    }
    // and two sets never share one, so one object's halo cannot mask another's
    const all = [...refs(a), ...refs(b)];
    expect(new Set(all).size).toBe(all.length);
    expect(Math.max(...all)).toBeLessThan(256);
    a.dispose();
    b.dispose();
  });

  it('fades all tiers together and never below the floor for a distant object', () => {
    const s = createVectorStrokes(torusStrokes(3, 0.18), 0xffb347);
    s.setFade(0.5);
    s.tiers.forEach((t, i) => expect((t.material as any).opacity).toBeCloseTo(GLOW_TIERS[i]![1] * 0.5, 9));
    expect(farFade(1000)).toBe(1);
    expect(farFade(FAR_FADE_PX)).toBe(1);
    expect(farFade(0)).toBe(FAR_MIN_OPACITY);
    // continuous: no step anywhere in the range, so nothing pops on approach
    let prev = farFade(0);
    for (let px = 0; px <= FAR_FADE_PX + 5; px += 0.1) {
      const f = farFade(px);
      expect(f - prev).toBeGreaterThanOrEqual(0);
      expect(f - prev).toBeLessThan(0.02);
      prev = f;
    }
    s.dispose();
  });

  it('projects a 3 m ring at 400 m to a few pixels', () => {
    const far = projectedRadiusPx(3, 400, 70, 900);
    expect(far).toBeGreaterThan(3);
    expect(far).toBeLessThan(8);
    expect(projectedRadiusPx(3, 0, 70, 900)).toBe(Infinity);
  });

  it('keeps the screen-space bloom off by default and the persistence subtle', () => {
    expect(BLOOM_STRENGTH).toBe(0);
    expect(PHOSPHOR_DECAY).toBeGreaterThanOrEqual(0);
    expect(PHOSPHOR_DECAY).toBeLessThan(0.9);
  });
});

describe('whole-edge hidden-line removal (#49)', () => {
  const cube = () => new THREE.BoxGeometry(2, 2, 2);

  it('finds every crease edge of a cube with both of its face normals', () => {
    const edges = creaseEdges(cube(), 10);
    expect(edges.count).toBe(12);
    expect(edges.positions.length).toBe(72);
    expect(edges.normals.length).toBe(72);
    for (let e = 0; e < edges.count; e++) {
      const o = e * 6;
      const n0 = new THREE.Vector3(edges.normals[o], edges.normals[o + 1], edges.normals[o + 2]);
      const n1 = new THREE.Vector3(edges.normals[o + 3], edges.normals[o + 4], edges.normals[o + 5]);
      expect(n0.length()).toBeCloseTo(1, 6);
      expect(n1.length()).toBeCloseTo(1, 6);
      expect(Math.abs(n0.dot(n1))).toBeLessThan(1e-6); // a cube's edges join perpendicular faces
    }
  });

  it('matches EdgesGeometry on a rock, edge for edge', () => {
    const g = asteroidGeometry(10, 77);
    const reference = new THREE.EdgesGeometry(g, 6).getAttribute('position');
    const ours = creaseEdges(g, 6);
    expect(ours.count).toBe(reference.count / 2);
    const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    const segKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const want = new Set<string>();
    for (let i = 0; i < reference.count; i += 2) {
      want.add(segKey(key(reference.getX(i), reference.getY(i), reference.getZ(i)), key(reference.getX(i + 1), reference.getY(i + 1), reference.getZ(i + 1))));
    }
    for (let e = 0; e < ours.count; e++) {
      const o = e * 6;
      const k = segKey(key(ours.positions[o]!, ours.positions[o + 1]!, ours.positions[o + 2]!), key(ours.positions[o + 3]!, ours.positions[o + 4]!, ours.positions[o + 5]!));
      expect(want.has(k)).toBe(true);
    }
  });

  it('keeps only the edges of faces that face the eye, and keeps them whole', () => {
    const edges = creaseEdges(cube(), 10);
    const out = new Float32Array(edges.positions.length);
    // head-on: the four edges of the near face
    expect(frontFacingEdges(edges, new THREE.Vector3(0, 0, 10), out)).toBe(4);
    for (let i = 0; i < 4 * 6; i += 3) expect(out[i + 2]).toBeCloseTo(1, 6); // all at z = +1
    // from a corner: three faces, nine edges
    const n = frontFacingEdges(edges, new THREE.Vector3(5, 5, 5), out);
    expect(n).toBe(9);
    // every kept segment is one of the input edges, untouched
    const inputs = new Set<string>();
    for (let e = 0; e < edges.count; e++) inputs.add(Array.from(edges.positions.subarray(e * 6, e * 6 + 6)).join(','));
    for (let e = 0; e < n; e++) expect(inputs.has(Array.from(out.subarray(e * 6, e * 6 + 6)).join(','))).toBe(true);
  });

  it('never leaves a rock edge partial: what it draws is a subset of all edges', () => {
    const edges = asteroidEdges(10, 4242);
    const out = new Float32Array(edges.positions.length);
    const inputs = new Set<string>();
    for (let e = 0; e < edges.count; e++) inputs.add(Array.from(edges.positions.subarray(e * 6, e * 6 + 6)).join(','));
    for (const eye of [new THREE.Vector3(0, 0, 300), new THREE.Vector3(-40, 25, 60), new THREE.Vector3(12, -30, -8)]) {
      const n = frontFacingEdges(edges, eye, out);
      expect(n).toBeGreaterThan(edges.count * 0.3);
      expect(n).toBeLessThan(edges.count);
      for (let e = 0; e < n; e++) expect(inputs.has(Array.from(out.subarray(e * 6, e * 6 + 6)).join(','))).toBe(true);
    }
  });

  it('culled strokes draw only the culled count, in the set\'s own frame', () => {
    const set = createCulledStrokes(creaseEdges(cube(), 10), 0xffffff);
    const fat = set.tiers[0]!.geometry as THREE.InstancedBufferGeometry;
    expect(fat.instanceCount).toBe(12);
    set.group.position.set(100, 0, 0);
    expect(set.cull(new THREE.Vector3(100, 0, 10))).toBe(4); // head-on, once the offset is removed
    expect(fat.instanceCount).toBe(4);
    set.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4); // turn 45°: two faces now face +z
    expect(set.cull(new THREE.Vector3(100, 0, 10))).toBe(7);
    // every tier shares the one geometry, so the count applies to all of them
    for (const t of set.tiers) expect((t.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(7);
    set.dispose();
  });

  it('orders a set below its own solid, tiers widest first', () => {
    const set = createCulledStrokes(creaseEdges(cube(), 10), 0xffffff);
    set.setOccluder(cube());
    set.setOrder(-600);
    expect(set.tiers.map((t) => t.renderOrder)).toEqual([-596, -597, -598, -599, -600].slice(0, GLOW_TIERS.length));
    expect(set.occluder!.renderOrder).toBe(-600 + GLOW_TIERS.length);
    expect((set.occluder!.material as THREE.Material).transparent).toBe(true); // sorted with the strokes
    expect(ORDER_STRIDE).toBe(GLOW_TIERS.length + 1);
    // an unordered set keeps the old opaque, draw-first solid
    const plain = createCulledStrokes(creaseEdges(cube(), 10), 0xffffff);
    plain.setOccluder(cube());
    expect(plain.occluder!.renderOrder).toBe(-100);
    expect((plain.occluder!.material as THREE.Material).transparent).toBe(false);
    set.dispose(); plain.dispose();
  });
});
