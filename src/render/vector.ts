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

export function disposeVectorLines(lines: LineSegments2): void {
  lines.geometry.dispose();
  const m = lines.material as LineMaterial;
  materials.delete(m);
  m.dispose();
}
