import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * Vector-monitor line rendering.
 *
 * A real vector display draws a bright thin stroke that the phosphor spreads into a
 * halo. WebGL's built-in lines are one device pixel wide and cannot be widened, so the
 * stroke is drawn with the "fat line" addon (a screen-space quad per segment, width in
 * CSS pixels) and the halo comes from the bloom stage in post.ts. Normal blending, not
 * additive: additive is the more literal CRT model, but a ring 400 m away collapses its
 * few hundred segments into a five-pixel disc, and the sum blooms into a blob that
 * swallows the target bracket. Bloom on a capped stroke gives the halo without that.
 *
 * Only silhouette and crease edges are drawn (EdgesGeometry), not triangle wireframes:
 * a cone is twelve spokes and a rim, not a fan of diagonals. Issue #36.
 */

/** Stroke width in CSS pixels. Phosphor, not a hairline. */
export const STROKE_PX = 1.6;
/** Edges between faces meeting at less than this angle are not drawn (degrees). */
export const CREASE_DEG = 10;

const materials = new Set<LineMaterial>();
const resolution = new THREE.Vector2(1, 1);

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

export function createVectorLines(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  creaseDeg = CREASE_DEG,
): LineSegments2 {
  const edges = new THREE.EdgesGeometry(geometry, creaseDeg);
  const fat = new LineSegmentsGeometry().fromEdgesGeometry(edges);
  edges.dispose();
  const material = new LineMaterial({
    color,
    linewidth: STROKE_PX,
    worldUnits: false,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  material.resolution.copy(resolution);
  materials.add(material);
  const lines = new LineSegments2(fat, material);
  lines.computeLineDistances();
  return lines;
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
    // u around the ring, v around the tube; same parametrisation as THREE.TorusGeometry
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

/** Fat lines from explicit segment pairs (flat xyz, two points per segment). */
export function createVectorStrokes(segments: Float32Array, color: THREE.ColorRepresentation): LineSegments2 {
  const fat = new LineSegmentsGeometry();
  fat.setPositions(segments);
  const material = new LineMaterial({
    color,
    linewidth: STROKE_PX,
    worldUnits: false,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  material.resolution.copy(resolution);
  materials.add(material);
  const lines = new LineSegments2(fat, material);
  lines.computeLineDistances();
  return lines;
}

// ---------------------------------------------------------------------------------------
// Level of detail. A vector display cannot draw fewer strokes as a thing recedes, but it
// should: a torus 400 m away is a circle, and drawing all 340 segments of it inside a
// five-pixel disc gives the bloom a solid blob to spread. Levels switch on the ring's
// projected radius in pixels, and the strokes fade as the ring gets small so a distant
// target is a dim mark, not a sun.
// ---------------------------------------------------------------------------------------

/**
 * Projected TUBE radius (px) at which each ring level becomes the one drawn. Keyed on
 * the tube, not the ring: hoops around the tube only read once the tube itself is a
 * few pixels wide; before that they pile into a solid band that blooms like a sun.
 */
export const RING_LOD_TUBE_PX: readonly [number, number, number] = [0, 2.5, 12];
/** Below this projected radius the strokes start to fade; at RING_FADE_MIN_PX they are dimmest. */
export const RING_FADE_PX = 10;
export const RING_FADE_MIN_PX = 2;
/** Dimmest a distant ring is allowed to get; it must stay findable. */
export const RING_MIN_OPACITY = 0.35;

/** On-screen radius in pixels of a sphere of `radius` at `distance`, for a vertical fov in degrees. */
export function projectedRadiusPx(radius: number, distance: number, fovDeg: number, viewportHeightPx: number): number {
  if (distance <= 0) return Infinity;
  const focal = viewportHeightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return (radius / distance) * focal;
}

/** Which of the three ring levels to draw for a projected TUBE radius. */
export function ringLodLevel(tubePx: number): 0 | 1 | 2 {
  if (tubePx >= RING_LOD_TUBE_PX[2]) return 2;
  if (tubePx >= RING_LOD_TUBE_PX[1]) return 1;
  return 0;
}

/** Stroke opacity for a projected radius: full when large, dimming toward the minimum when tiny. */
export function ringOpacity(px: number): number {
  if (px >= RING_FADE_PX) return 1;
  const t = Math.max(0, (px - RING_FADE_MIN_PX) / (RING_FADE_PX - RING_FADE_MIN_PX));
  return RING_MIN_OPACITY + (1 - RING_MIN_OPACITY) * t;
}

export interface VectorRing {
  group: THREE.Group;
  /** far: one circle; mid: outer+inner circles and a few hoops; near: the full lattice */
  levels: [LineSegments2, LineSegments2, LineSegments2];
  /** Pick the level and opacity for this frame from the ring's projected radius; allocation-free. */
  update(projectedRingPx: number): void;
  dispose(): void;
}

export function createVectorRing(radius: number, tube: number, color: THREE.ColorRepresentation): VectorRing {
  const levels: [LineSegments2, LineSegments2, LineSegments2] = [
    createVectorStrokes(torusStrokes(radius, tube, 0, 1, 8, 48), color),
    createVectorStrokes(torusStrokes(radius, tube, 8, 2, 8, 48), color),
    createVectorStrokes(torusStrokes(radius, tube, 16, 4, 8, 48), color),
  ];
  const tubeRatio = tube / radius;
  const group = new THREE.Group();
  for (const l of levels) group.add(l);
  let shown = -1;
  let lastOpacity = -1;
  return {
    group,
    levels,
    update(px) {
      const level = ringLodLevel(px * tubeRatio);
      if (level !== shown) {
        for (let i = 0; i < 3; i++) levels[i]!.visible = i === level;
        shown = level;
      }
      const opacity = ringOpacity(px);
      if (opacity !== lastOpacity) {
        (levels[level].material as LineMaterial).opacity = opacity;
        lastOpacity = opacity;
      }
    },
    dispose() {
      for (const l of levels) disposeVectorLines(l);
    },
  };
}

export function disposeVectorLines(lines: LineSegments2): void {
  lines.geometry.dispose();
  const m = lines.material as LineMaterial;
  materials.delete(m);
  m.dispose();
}
