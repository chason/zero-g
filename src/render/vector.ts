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
  dispose(): void;
}

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
  const set: VectorStrokes = {
    group,
    tiers,
    occluder: null,
    setOccluder(geometry) {
      if (set.occluder) {
        group.remove(set.occluder);
        set.occluder.geometry.dispose();
      }
      const mesh = new THREE.Mesh(geometry, getOccluderMaterial());
      mesh.renderOrder = -100; // before every stroke, so depth is there to test against
      group.add(mesh);
      set.occluder = mesh;
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
 * A rock as a vector display would draw it: the edges of a lumpy low-poly polyhedron.
 * An icosphere is dented by a few seeded caps and squashed along its axes, so every
 * rock has its own silhouette and the same seed always gives the same rock. Every
 * vertex stays inside `radius`, which is what the sim judges collisions against.
 */
export const ROCK_MIN_SCALE = 0.62;

export function asteroidStrokes(radius: number, seed: number, detail = 1, creaseDeg = 6): Float32Array {
  const geometry = asteroidGeometry(radius, seed, detail);
  const edges = new THREE.EdgesGeometry(geometry, creaseDeg);
  const out = new Float32Array(edges.getAttribute('position').array as Float32Array);
  edges.dispose();
  geometry.dispose();
  return out;
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
