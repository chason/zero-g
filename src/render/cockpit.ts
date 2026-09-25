import * as THREE from 'three';
import { createVectorStrokes, type VectorStrokes } from './vector';

/**
 * The cockpit frame: what the pilot sees of their own ship from the seat. A few angular
 * struts laid out in the CAMERA's frame — x right, y up, the nose down -Z, metres from
 * the eye — so they ride the camera exactly; the hull itself stays hidden from inside.
 *
 * Sized for a 16:9 window at the 70° vertical field: the top rail crosses just below the
 * top edge, the coaming (the dash's top edge) sits above the lower instruments, the front
 * pillars slant out through the sides, and the side rails only show on a wider window.
 * The middle of the view, where the boresight and the target live, is kept clear. Below
 * the coaming a solid dash hides the world, which is most of what makes it a cockpit.
 */
export const COCKPIT_COLOR = 0x7a8a8c;
/** Held well back: the frame is there, not looked at. */
export const COCKPIT_FADE = 0.32;
/** The dash solid sits this factor farther from the eye than its strokes, so they stay on top. */
export const DASH_SETBACK = 1.01;
/**
 * The frame is laid out at about a metre and then drawn at this fraction of that. A scale
 * about the eye changes nothing on screen, but it puts the dash NEARER than anything on
 * the hull — the forward thruster nozzles are 0.4 m ahead of the seat — so their exhaust
 * is behind the dash where the dash covers it, instead of flaring in front of it (#52).
 * Still well past the camera's 0.1 m near plane.
 */
export const COCKPIT_SCALE = 0.3;
/** Nearest and farthest the dash solid reaches from the eye, in metres, after scaling. */
export const DASH_DEPTH: readonly [number, number] = [0.78 * COCKPIT_SCALE, 1.2 * COCKPIT_SCALE];
/** No stroke passes within this of the view axis, as a tangent (0.25 ≈ 14°). */
export const CLEAR_TAN = 0.25;

export type Point = readonly [number, number, number];

// Top rail, left to right: a shallow peak.
const A: Point = [-1.05, 0.5, -1.05];
const B: Point = [-0.42, 0.78, -1.25];
const C: Point = [0.42, 0.78, -1.25];
const D: Point = [1.05, 0.5, -1.05];
// Coaming: the top edge of the dash, a chevron pushed toward the nose in the middle.
const E: Point = [-1.2, -0.44, -0.9];
const F: Point = [-0.45, -0.36, -1.2];
const G: Point = [0.45, -0.36, -1.2];
const H: Point = [1.2, -0.44, -0.9];
// The dash's front edge, lower and nearer: the slab has thickness.
const E2: Point = [-1.2, -0.58, -0.78];
const F2: Point = [-0.45, -0.5, -1.05];
const G2: Point = [0.45, -0.5, -1.05];
const H2: Point = [1.2, -0.58, -0.78];
// Side rails run back past the eye and out of view.
const I: Point = [-1.75, 0.42, -0.25];
const J: Point = [-1.9, -0.6, -0.2];
const I2: Point = [1.75, 0.42, -0.25];
const J2: Point = [1.9, -0.6, -0.2];

export const COCKPIT_POLYLINES: readonly (readonly Point[])[] = [
  [A, B, C, D], // top rail
  [E, F, G, H], // coaming
  [E2, F2, G2, H2], // dash front edge
  [A, E], // front pillars
  [D, H],
  [F, F2], // the dash's two front corners
  [G, G2],
  [A, I], // side rails
  [E, J],
  [D, I2],
  [H, J2],
];

/** Flat xyz pairs, one segment per polyline edge. */
export function cockpitStrokes(): Float32Array {
  const out: number[] = [];
  for (const line of COCKPIT_POLYLINES) {
    for (let i = 0; i + 1 < line.length; i++) out.push(...line[i]!, ...line[i + 1]!);
  }
  return new Float32Array(out);
}

/** Two triangles per quad between matching points of two polylines. */
function strip(top: readonly Point[], bottom: readonly Point[], out: number[]): void {
  for (let i = 0; i + 1 < top.length; i++) {
    out.push(...top[i]!, ...top[i + 1]!, ...bottom[i + 1]!);
    out.push(...top[i]!, ...bottom[i + 1]!, ...bottom[i]!);
  }
}

/**
 * The dash: a solid from the coaming down and out past the bottom of any window, facing
 * the eye. Built from the same points as the strokes, then pushed DASH_SETBACK farther
 * out, so the strokes sit a centimetre in front of it.
 */
export function dashGeometry(): THREE.BufferGeometry {
  const tris: number[] = [];
  strip([E, F, G, H], [E2, F2, G2, H2], tris); // the top slab
  // The front face drops to a floor whose corners are flung wide, so the bottom corners
  // of a wide window are covered too.
  const floor: Point[] = [[-3.2, -1.7, -0.78], [-1.2, -1.7, -1.05], [1.2, -1.7, -1.05], [3.2, -1.7, -0.78]];
  strip([E2, F2, G2, H2], floor, tris);
  // Every triangle must face the eye at the origin: the occluder material culls back faces.
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 9) {
    a.fromArray(tris, i); b.fromArray(tris, i + 3); c.fromArray(tris, i + 6);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.dot(a) > 0) {
      // normal points away from the eye: swap b and c
      for (let k = 0; k < 3; k++) {
        const t = tris[i + 3 + k]!;
        tris[i + 3 + k] = tris[i + 6 + k]!;
        tris[i + 6 + k] = t;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(tris.map((v) => v * DASH_SETBACK), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** The frame as a stroke set with the dash as its solid. Add `group` to the camera. */
export function createCockpit(): { group: THREE.Group; strokes: VectorStrokes } {
  const strokes = createVectorStrokes(cockpitStrokes(), COCKPIT_COLOR);
  strokes.setOccluder(dashGeometry());
  strokes.setFade(COCKPIT_FADE);
  strokes.group.scale.setScalar(COCKPIT_SCALE);
  return { group: strokes.group, strokes };
}
