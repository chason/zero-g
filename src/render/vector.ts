import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { rng } from '../core/random';

/**
 * Vector-monitor line rendering.
 *
 * A real vector display draws a bright thin stroke that the phosphor spreads into a
 * halo. WebGL's built-in lines are one device pixel wide and cannot be widened, so
 * strokes use the "fat line" addon (a screen-space quad per segment, width in CSS
 * pixels).
 *
 * The glow is PART OF THE STROKE, not a screen-space blur. Every stroke is drawn in
 * tiers — a bright core, then wider and dimmer bands — all with normal blending. Where
 * lines pile up (a ring far away, a tunnel's vanishing point) the halos converge on the
 * halo colour and stop; they cannot sum past it. A bloom pass cannot do this: it blurs
 * whatever is there, so density always becomes halo, and a distant ring becomes a sun.
 * Nor does this need level-of-detail switching, and so nothing pops. Issue #39.
 *
 * Fat lines draw each segment as its own quad with round caps, so at every joint two
 * caps overlap. A translucent band blended twice is brighter than once, which put a
 * bead at every vertex. Each tier therefore stencils itself: a pixel may be touched by
 * a given tier of a given stroke set once per frame and no more (#40). The render target
 * must carry a stencil buffer for this to do anything — see post.ts.
 *
 * Only silhouette and crease edges are drawn (EdgesGeometry), not triangle wireframes:
 * a cone is twelve spokes and a rim, not a fan of diagonals.
 */

/**
 * Glow tiers: [width in CSS px, opacity], core first. Widths grow, opacities fall,
 * roughly a gaussian sampled five times. The core is tinted toward white (CORE_WHITE)
 * and the bands carry the colour — that is what neon looks like: a white-hot centre in
 * a coloured glow.
 */
export const GLOW_TIERS: ReadonlyArray<readonly [number, number]> = [
  [1.5, 1.0],
  [3.5, 0.45],
  [6.5, 0.22],
  [11, 0.11],
  [18, 0.05],
];
/** How far the core tier is pushed toward white, 0..1. */
export const CORE_WHITE = 0.55;
/** Edges between faces meeting at less than this angle are not drawn (degrees). */
export const CREASE_DEG = 10;
/**
 * Hidden-line removal (#47). Every stroke set can carry an OCCLUDER: the object's solid
 * shape, drawn first, writing depth and no colour. Strokes behind that surface — the
 * far side of a hoop, a rock behind the hull, stars behind everything — fail the depth
 * test and vanish, so a wireframe reads as a solid drawn in lines. The occluder is
 * shrunk a hair inside the strokes so lines ON the near surface still win; polygon
 * offset would be the usual tool, but it does nothing under a logarithmic depth buffer.
 */
export const OCCLUDER_SHRINK = 0.992;

let occluderMaterial: THREE.MeshBasicMaterial | null = null;
function getOccluderMaterial(): THREE.MeshBasicMaterial {
  if (!occluderMaterial) {
    occluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: THREE.FrontSide });
  }
  return occluderMaterial;
}
// Same solid, but flagged transparent so it sorts into the blended queue with the strokes
// and obeys renderOrder against them: an ordered set draws its strokes, THEN its solid, so
// the solid hides only what comes later — never the set's own lines.
let orderedOccluderMaterial: THREE.MeshBasicMaterial | null = null;
function getOrderedOccluderMaterial(): THREE.MeshBasicMaterial {
  if (!orderedOccluderMaterial) {
    orderedOccluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: THREE.FrontSide, transparent: true });
  }
  return orderedOccluderMaterial;
}

/** Distant strokes fade toward this floor so a far target is a mark, not a glare. */
export const FAR_MIN_OPACITY = 0.5;
/** Fade begins below this projected radius (px) and reaches the floor at FAR_MIN_PX. */
export const FAR_FADE_PX = 12;
export const FAR_MIN_PX = 2;

const materials = new Set<LineMaterial>();
const resolution = new THREE.Vector2(1, 1);

/**
 * Stencil references. Each stroke set takes a block of GLOW_TIERS.length consecutive
 * values so its tiers never collide with each other or with another set's; the 8-bit
 * buffer wraps after ~50 sets, which only matters if two sets that far apart overlap
 * on screen in the same frame.
 */
let nextStencilBase = 1;
export function allocateStencilBase(): number {
  const base = nextStencilBase;
  nextStencilBase += GLOW_TIERS.length;
  if (nextStencilBase + GLOW_TIERS.length > 255) nextStencilBase = 1;
  return base;
}

/** Fat lines need the drawing-buffer size to scale their width; call on every resize. */
export function setVectorResolution(width: number, height: number): void {
  resolution.set(width, height);
  for (const m of materials) m.resolution.copy(resolution);
}

/** Number of edge segments EdgesGeometry will produce for `geometry` at the crease angle. */
export function edgeSegmentCount(geometry: THREE.BufferGeometry, creaseDeg = CREASE_DEG): number {
  const edges = new THREE.EdgesGeometry(geometry, creaseDeg);
  const n = edges.getAttribute('position').count / 2;
  edges.dispose();
  return n;
}

/** A tiered glowing stroke set. `group` is what you add to the scene. */
export interface VectorStrokes {
  group: THREE.Group;
  /** one LineSegments2 per glow tier, core first, sharing one geometry */
  tiers: LineSegments2[];
  /** the depth-only solid, if this set has one */
  occluder: THREE.Mesh | null;
  /** give the set a solid shape to hide what is behind it; geometry is taken as-is */
  setOccluder(geometry: THREE.BufferGeometry): void;
  /** scale every tier's opacity by 0..1 — used to fade distant objects; allocation-free */
  setFade(fade: number): void;
  /**
   * Place the whole set in the draw sequence: tiers at base..base+tiers-1 (widest first),
   * the solid right after, so the solid never tests this set's own strokes. Sets that
   * are ordered against each other should be given bases ORDER_STRIDE apart, nearest
   * first, and a base below every unordered stroke set (which draw at -tiers+1..0).
   */
  setOrder(base: number): void;
  dispose(): void;
}
/** renderOrder values one ordered set spans: its tiers plus its solid. */
export const ORDER_STRIDE = GLOW_TIERS.length + 1;

function buildTiers(fat: LineSegmentsGeometry, color: THREE.ColorRepresentation): VectorStrokes {
  const group = new THREE.Group();
  const tiers: LineSegments2[] = [];
  const base = new THREE.Color(color);
  const core = base.clone().lerp(new THREE.Color(0xffffff), CORE_WHITE);
  const stencilBase = allocateStencilBase();
  GLOW_TIERS.forEach(([width, opacity], i) => {
    const material = new LineMaterial({
      color: i === 0 ? core : base,
      linewidth: width,
      worldUnits: false,
      transparent: true,
      opacity,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    // Draw where the stencil is not yet this tier's value, then stamp it: one blend
    // per pixel per tier, so overlapping caps at a joint cannot double up.
    material.stencilWrite = true;
    material.stencilRef = stencilBase + i;
    material.stencilFunc = THREE.NotEqualStencilFunc;
    material.stencilFail = THREE.KeepStencilOp;
    material.stencilZFail = THREE.KeepStencilOp;
    material.stencilZPass = THREE.ReplaceStencilOp;
    material.resolution.copy(resolution);
    materials.add(material);
    const lines = new LineSegments2(fat, material);
    lines.computeLineDistances();
    // Widest band first, core last, so the core sits on top of its own halo.
    lines.renderOrder = -i;
    group.add(lines);
    tiers.push(lines);
  });
  let lastFade = 1;
  let orderBase: number | null = null;
  const set: VectorStrokes = {
    group,
    tiers,
    occluder: null,
    setOccluder(geometry) {
      if (set.occluder) {
        group.remove(set.occluder);
        set.occluder.geometry.dispose();
      }
      const mesh = new THREE.Mesh(geometry, orderBase === null ? getOccluderMaterial() : getOrderedOccluderMaterial());
      // Unordered: an opaque solid, drawn before every stroke so depth is there to test
      // against. Ordered: right after this set's own strokes.
      mesh.renderOrder = orderBase === null ? -100 : orderBase + GLOW_TIERS.length;
      group.add(mesh);
      set.occluder = mesh;
    },
    setOrder(base) {
      orderBase = base;
      tiers.forEach((t, i) => { t.renderOrder = base + (GLOW_TIERS.length - 1 - i); });
      if (set.occluder) {
        set.occluder.material = getOrderedOccluderMaterial();
        set.occluder.renderOrder = base + GLOW_TIERS.length;
      }
    },
    setFade(fade) {
      const f = Math.max(0, Math.min(1, fade));
      if (f === lastFade) return;
      lastFade = f;
      tiers.forEach((t, i) => {
        (t.material as LineMaterial).opacity = GLOW_TIERS[i]![1] * f;
      });
    },
    dispose() {
      for (const t of tiers) {
        const m = t.material as LineMaterial;
        materials.delete(m);
        m.dispose();
      }
      fat.dispose();
      if (set.occluder) set.occluder.geometry.dispose();
    },
  };
  return set;
}

/** Silhouette and crease edges of a mesh geometry, as glowing strokes. */
export function createVectorLines(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  creaseDeg = CREASE_DEG,
): VectorStrokes {
  const edges = new THREE.EdgesGeometry(geometry, creaseDeg);
  const fat = new LineSegmentsGeometry().fromEdgesGeometry(edges);
  edges.dispose();
  const set = buildTiers(fat, color);
  set.setOccluder(geometry.clone().scale(OCCLUDER_SHRINK, OCCLUDER_SHRINK, OCCLUDER_SHRINK));
  return set;
}

/** Glowing strokes from explicit segment pairs (flat xyz, two points per segment). */
export function createVectorStrokes(segments: Float32Array, color: THREE.ColorRepresentation): VectorStrokes {
  const fat = new LineSegmentsGeometry();
  fat.setPositions(segments);
  return buildTiers(fat, color);
}

/**
 * The edges EdgesGeometry would keep, plus what it throws away: the normals of the two
 * faces each edge joins. `positions` is flat xyz pairs, `normals` the matching pair of
 * unit normals per edge (a boundary edge repeats its one face). That pair is what
 * whole-edge visibility needs — see `frontFacingEdges`.
 */
export interface CreaseEdges {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
}

export function creaseEdges(geometry: THREE.BufferGeometry, creaseDeg = CREASE_DEG): CreaseEdges {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = flat.getAttribute('position');
  const thresholdDot = Math.cos((creaseDeg * Math.PI) / 180);
  const precision = 1e4;
  const keyOf = (i: number) =>
    `${Math.round(pos.getX(i) * precision)},${Math.round(pos.getY(i) * precision)},${Math.round(pos.getZ(i) * precision)}`;
  interface Edge { a: number; b: number; n0: THREE.Vector3; n1: THREE.Vector3 | null }
  const edges = new Map<string, Edge>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.lengthSq() === 0) continue; // degenerate face
    n.normalize();
    const keys = [keyOf(i), keyOf(i + 1), keyOf(i + 2)];
    for (let j = 0; j < 3; j++) {
      const k0 = keys[j]!, k1 = keys[(j + 1) % 3]!;
      const key = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
      const found = edges.get(key);
      if (found) found.n1 = n;
      else edges.set(key, { a: i + j, b: i + ((j + 1) % 3), n0: n, n1: null });
    }
  }
  const kept: Edge[] = [];
  for (const e of edges.values()) {
    if (e.n1 === null || e.n0.dot(e.n1) <= thresholdDot) kept.push(e);
  }
  const positions = new Float32Array(kept.length * 6);
  const normals = new Float32Array(kept.length * 6);
  kept.forEach((e, i) => {
    const o = i * 6;
    positions[o] = pos.getX(e.a); positions[o + 1] = pos.getY(e.a); positions[o + 2] = pos.getZ(e.a);
    positions[o + 3] = pos.getX(e.b); positions[o + 4] = pos.getY(e.b); positions[o + 5] = pos.getZ(e.b);
    const n1 = e.n1 ?? e.n0;
    normals[o] = e.n0.x; normals[o + 1] = e.n0.y; normals[o + 2] = e.n0.z;
    normals[o + 3] = n1.x; normals[o + 4] = n1.y; normals[o + 5] = n1.z;
  });
  if (flat !== geometry) flat.dispose();
  return { positions, normals, count: kept.length };
}

/**
 * Whole-edge hidden-line removal: keep an edge if either face it joins faces `eye`
 * (given in the edges' own frame). Every kept edge is copied complete into `out`; the
 * count kept is returned. On a convex solid this is exactly what a depth test would
 * show. On a concave one it differs in the one way that matters for a vector display:
 * an edge behind a lip is drawn through the lip rather than cut off in mid-air.
 */
export function frontFacingEdges(edges: CreaseEdges, eye: THREE.Vector3, out: Float32Array): number {
  const P = edges.positions, N = edges.normals;
  let n = 0;
  for (let e = 0; e < edges.count; e++) {
    const o = e * 6;
    const dx = eye.x - P[o]!, dy = eye.y - P[o + 1]!, dz = eye.z - P[o + 2]!;
    if (dx * N[o]! + dy * N[o + 1]! + dz * N[o + 2]! <= 0 && dx * N[o + 3]! + dy * N[o + 4]! + dz * N[o + 5]! <= 0) continue;
    const w = n * 6;
    out[w] = P[o]!; out[w + 1] = P[o + 1]!; out[w + 2] = P[o + 2]!;
    out[w + 3] = P[o + 3]!; out[w + 4] = P[o + 4]!; out[w + 5] = P[o + 5]!;
    n++;
  }
  return n;
}

/** A stroke set that hides its own back edges whole, by facing, instead of by depth. */
export interface CulledStrokes extends VectorStrokes {
  /** Recompute which edges to draw for a camera at `eye` (world frame). Returns the count drawn. */
  cull(eye: THREE.Vector3): number;
}

/**
 * Strokes for a solid whose own hidden lines are removed edge by edge (`frontFacingEdges`)
 * rather than pixel by pixel, so no line of it ever just ends. Pair it with `setOccluder`
 * and `setOrder` so its solid still hides everything BEHIND it while leaving its own
 * strokes alone. The set's group must carry only a position and a rotation.
 */
export function createCulledStrokes(edges: CreaseEdges, color: THREE.ColorRepresentation): CulledStrokes {
  const fat = new LineSegmentsGeometry();
  fat.setPositions(edges.positions.slice()); // bounds cover every edge; the visible subset is compacted in each frame
  const buffer = (fat.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data;
  const array = buffer.array as Float32Array;
  const set = buildTiers(fat, color);
  const eye = new THREE.Vector3();
  const inverse = new THREE.Quaternion();
  return Object.assign(set, {
    cull(eyeWorld: THREE.Vector3): number {
      eye.copy(eyeWorld).sub(set.group.position).applyQuaternion(inverse.copy(set.group.quaternion).invert());
      const n = frontFacingEdges(edges, eye, array);
      buffer.needsUpdate = true;
      fat.instanceCount = n;
      return n;
    },
  });
}

/**
 * A torus as a vector display would be fed it: `hoops` small circles around the tube
 * spaced along the ring, and `longitudes` great circles running the ring's length.
 * EdgesGeometry cannot do this — the crease angle between adjacent facets varies around
 * the tube, so no single threshold keeps every longitude. Returns flat xyz pairs.
 */
export function torusStrokes(
  radius: number,
  tube: number,
  hoops = 24,
  longitudes = 6,
  hoopSegments = 8,
  ringSegments = 48,
): Float32Array {
  const out: number[] = [];
  const push = (a: number, b: number, c: number, x: number, y: number, z: number) => out.push(a, b, c, x, y, z);
  const point = (u: number, v: number): [number, number, number] => {
    const cx = (radius + tube * Math.cos(v)) * Math.cos(u);
    const cy = (radius + tube * Math.cos(v)) * Math.sin(u);
    const cz = tube * Math.sin(v);
    return [cx, cy, cz];
  };
  for (let h = 0; h < hoops; h++) {
    const u = (h / hoops) * Math.PI * 2;
    for (let i = 0; i < hoopSegments; i++) {
      const a = point(u, (i / hoopSegments) * Math.PI * 2);
      const b = point(u, ((i + 1) / hoopSegments) * Math.PI * 2);
      push(...a, ...b);
    }
  }
  for (let l = 0; l < longitudes; l++) {
    const v = (l / longitudes) * Math.PI * 2;
    for (let i = 0; i < ringSegments; i++) {
      const a = point((i / ringSegments) * Math.PI * 2, v);
      const b = point(((i + 1) / ringSegments) * Math.PI * 2, v);
      push(...a, ...b);
    }
  }
  return new Float32Array(out);
}

/**
 * A cylinder along Z between z0 and z1, as a vector display would draw it: hoops at
 * each end and every `hoopSpacing` metres between, and `longitudes` lines along its
 * length. Appends flat xyz pairs to `out`.
 */
export function cylinderStrokes(
  radius: number,
  z0: number,
  z1: number,
  out: number[],
  longitudes = 8,
  hoopSpacing = 4,
  hoopSegments = 24,
): void {
  const length = Math.abs(z1 - z0);
  const n = Math.max(1, Math.round(length / hoopSpacing));
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    for (let k = 0; k < hoopSegments; k++) {
      const a = (k / hoopSegments) * Math.PI * 2;
      const b = ((k + 1) / hoopSegments) * Math.PI * 2;
      out.push(radius * Math.cos(a), radius * Math.sin(a), z, radius * Math.cos(b), radius * Math.sin(b), z);
    }
  }
  for (let l = 0; l < longitudes; l++) {
    const a = (l / longitudes) * Math.PI * 2;
    const x = radius * Math.cos(a);
    const y = radius * Math.sin(a);
    out.push(x, y, z0, x, y, z1);
  }
}

/** The solid of a cylinder section along Z, shrunk for occlusion. */
export function cylinderOccluder(radius: number, z0: number, z1: number): THREE.BufferGeometry {
  const length = Math.abs(z1 - z0) * OCCLUDER_SHRINK;
  const g = new THREE.CylinderGeometry(radius * OCCLUDER_SHRINK, radius * OCCLUDER_SHRINK, length, 36, 1, false);
  g.rotateX(Math.PI / 2); // Cylinder is along Y; ours run along Z
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** The solids of a whole hull, minus any sections in `skip`, merged. */
export function hullOccluder(
  sections: ReadonlyArray<{ radius: number; from: number; to: number }>,
  skip: ReadonlySet<number> = new Set(),
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  sections.forEach((sec, i) => { if (!skip.has(i)) parts.push(cylinderOccluder(sec.radius, sec.from, sec.to)); });
  return mergeGeometries(parts);
}

/** A port's solid: the hoop, and the collar as an OPEN tube so the hole stays a hole. */
export function portOccluder(radius: number, tube: number, collar: number): THREE.BufferGeometry {
  const hoop = new THREE.TorusGeometry(radius, tube * 0.85, 8, 48);
  if (collar <= 0) return hoop;
  const wall = new THREE.CylinderGeometry(radius * OCCLUDER_SHRINK, radius * OCCLUDER_SHRINK, collar, 24, 1, true);
  wall.rotateX(Math.PI / 2);
  wall.translate(0, 0, -collar / 2);
  return mergeGeometries([hoop, wall]);
}

/** Concatenate non-indexed geometries that share the position attribute layout. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const g of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.getAttribute('position');
    for (let i = 0; i < p.count; i++) positions.push(p.getX(i), p.getY(i), p.getZ(i));
    if (ng !== g) ng.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return out;
}

/** One hull section on its own, for a section that turns independently of the rest. */
export function sectionStrokes(
  section: { radius: number; from: number; to: number },
  longitudes = 12,
  hoopSpacing = 10,
): Float32Array {
  const out: number[] = [];
  cylinderStrokes(section.radius, section.from, section.to, out, longitudes, hoopSpacing, 36);
  return new Float32Array(out);
}

/**
 * A structure's hull: each section a cylinder along local +Z, and where the radius
 * steps between sections, spokes joining the two rims so the silhouette closes. Big
 * hulls get sparser hoops so the stroke count stays sane. Sections listed in `skip`
 * are left out (they are drawn separately so they can turn), their spokes kept.
 */
export function hullStrokes(
  sections: ReadonlyArray<{ radius: number; from: number; to: number }>,
  spokes = 12,
  longitudes = 12,
  hoopSpacing = 10,
  skip: ReadonlySet<number> = new Set(),
): Float32Array {
  const out: number[] = [];
  sections.forEach((sec, i) => {
    if (!skip.has(i)) cylinderStrokes(sec.radius, sec.from, sec.to, out, longitudes, hoopSpacing, 36);
  });
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i]!;
    const b = sections[i + 1]!;
    if (Math.abs(a.radius - b.radius) < 1e-6) continue;
    for (let k = 0; k < spokes; k++) {
      const t = (k / spokes) * Math.PI * 2;
      out.push(a.radius * Math.cos(t), a.radius * Math.sin(t), a.to, b.radius * Math.cos(t), b.radius * Math.sin(t), b.from);
    }
  }
  return new Float32Array(out);
}

/**
 * A docking port in its own frame: +Z is the open side, the ring lies in the XY plane
 * at z=0, and the collar runs from the hull surface at z=-collar up to the ring.
 */
export function portStrokes(radius: number, tube: number, collar: number): Float32Array {
  const ring = torusStrokes(radius, tube);
  if (collar <= 0) return ring;
  const out: number[] = Array.from(ring);
  cylinderStrokes(radius, -collar, 0, out, 8, collar, 24);
  return new Float32Array(out);
}

/**
 * A rock as a vector display would draw it: the crease edges of a squashed icosphere
 * with a few broad dents pressed into it. Dents make it concave, which is fine now
 * that a rock's own hidden lines are removed whole (`createCulledStrokes`, #49) — the
 * convex-hull detour of #48 only ever existed to keep a depth test from cutting edges
 * off behind a lip. Every vertex stays inside `radius`, which is what the sim judges
 * collisions against; the same seed is always the same rock.
 */
export const ROCK_MIN_SCALE = 0.62;
/** Crease angle for rock edges: low, so the lattice of the icosphere reads as a surface. */
export const ROCK_CREASE_DEG = 6;

/** Rock edges with face adjacency, for `createCulledStrokes`. */
export function asteroidEdges(radius: number, seed: number, detail = 1): CreaseEdges {
  const geometry = asteroidGeometry(radius, seed, detail);
  const edges = creaseEdges(geometry, ROCK_CREASE_DEG);
  geometry.dispose();
  return edges;
}

/** Rock edges as flat segment pairs, every edge, no culling. */
export function asteroidStrokes(radius: number, seed: number, detail = 1): Float32Array {
  return asteroidEdges(radius, seed, detail).positions;
}

/** The rock's solid, before it is reduced to edges. Same seed, same rock. */
export function asteroidGeometry(radius: number, seed: number, detail = 1): THREE.BufferGeometry {
  const next = rng(seed);
  // a handful of dents: a direction, a cap width and a depth each
  const dents = Array.from({ length: 4 + Math.floor(next() * 3) }, () => ({
    dir: new THREE.Vector3(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1).normalize(),
    width: 0.45 + next() * 0.4, // cos of the cap's half-angle: bigger = narrower
    depth: 0.12 + next() * 0.2,
  }));
  const squash = new THREE.Vector3(0.78 + next() * 0.22, 0.78 + next() * 0.22, 0.78 + next() * 0.22);

  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    let scale = 1;
    for (const dent of dents) {
      const c = d.dot(dent.dir);
      if (c > dent.width) {
        const t = (c - dent.width) / (1 - dent.width); // 0 at the cap's edge, 1 at its centre
        scale -= dent.depth * t * t * (3 - 2 * t);
      }
    }
    scale = Math.max(ROCK_MIN_SCALE, scale);
    pos.setXYZ(i, d.x * scale * squash.x * radius, d.y * scale * squash.y * radius, d.z * scale * squash.z * radius);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** On-screen radius in pixels of a sphere of `radius` at `distance`, for a vertical fov in degrees. */
export function projectedRadiusPx(radius: number, distance: number, fovDeg: number, viewportHeightPx: number): number {
  if (distance <= 0) return Infinity;
  const focal = viewportHeightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return (radius / distance) * focal;
}

/**
 * Fade for a distant object from its projected radius: 1 when it is large, easing to
 * FAR_MIN_OPACITY as it shrinks to a few pixels. Continuous, so nothing pops.
 */
export function farFade(px: number): number {
  if (px >= FAR_FADE_PX) return 1;
  const t = Math.max(0, (px - FAR_MIN_PX) / (FAR_FADE_PX - FAR_MIN_PX));
  return FAR_MIN_OPACITY + (1 - FAR_MIN_OPACITY) * t;
}
