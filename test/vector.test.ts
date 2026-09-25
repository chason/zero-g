import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  edgeSegmentCount, createVectorLines, createVectorStrokes, torusStrokes,
  projectedRadiusPx, farFade,
  GLOW_TIERS, CORE_WHITE, CREASE_DEG, FAR_MIN_OPACITY, FAR_FADE_PX, OCCLUDER_SHRINK,
  cylinderOccluder, hullOccluder, portOccluder, asteroidGeometry, asteroidStrokes,
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
