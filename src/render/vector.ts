import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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
  return {
    group,
    tiers,
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
    },
  };
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
  return buildTiers(fat, color);
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
 * A cylinder along -Z from z=-from to z=-to, as a vector display would draw it: hoops
 * at each end and every `hoopSpacing` metres between, and `longitudes` lines along
 * its length. Returns flat xyz pairs, appended to `out`.
 */
export function cylinderStrokes(
  radius: number,
  from: number,
  to: number,
  out: number[],
  longitudes = 8,
  hoopSpacing = 4,
  hoopSegments = 24,
): void {
  const zs: number[] = [];
  const length = to - from;
  const n = Math.max(1, Math.round(length / hoopSpacing));
  for (let i = 0; i <= n; i++) zs.push(-(from + (length * i) / n));
  for (const z of zs) {
    for (let i = 0; i < hoopSegments; i++) {
      const a = (i / hoopSegments) * Math.PI * 2;
      const b = ((i + 1) / hoopSegments) * Math.PI * 2;
      out.push(radius * Math.cos(a), radius * Math.sin(a), z, radius * Math.cos(b), radius * Math.sin(b), z);
    }
  }
  for (let l = 0; l < longitudes; l++) {
    const a = (l / longitudes) * Math.PI * 2;
    const x = radius * Math.cos(a);
    const y = radius * Math.sin(a);
    out.push(x, y, -from, x, y, -to);
  }
}

/**
 * The hull of a tender behind its ring: each section a cylinder, and where the radius
 * steps between sections, spokes joining the two rims so the silhouette closes.
 */
export function tenderHullStrokes(
  sections: ReadonlyArray<{ radius: number; from: number; to: number }>,
  spokes = 8,
): Float32Array {
  const out: number[] = [];
  for (const sec of sections) cylinderStrokes(sec.radius, sec.from, sec.to, out);
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i]!;
    const b = sections[i + 1]!;
    if (Math.abs(a.radius - b.radius) < 1e-6) continue;
    const z = -Math.min(a.to, b.from);
    for (let k = 0; k < spokes; k++) {
      const t = (k / spokes) * Math.PI * 2;
      out.push(a.radius * Math.cos(t), a.radius * Math.sin(t), -a.to, b.radius * Math.cos(t), b.radius * Math.sin(t), -b.from);
      void z;
    }
  }
  return new Float32Array(out);
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
