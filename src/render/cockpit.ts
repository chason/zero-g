import * as THREE from 'three';
import { createVectorStrokes, type VectorStrokes } from './vector';

/**
 * The cockpit frame: what the pilot sees of their own ship from the seat. A few angular
 * struts laid out in the CAMERA's frame — x right, y up, the nose down -Z — so they ride
 * the camera exactly; the hull itself stays hidden from inside.
 *
 * The shape (#53, from Chason's sketch): on each side a pillar bent inward at a joint a
 * little above eye level, running from off the top edge down through the joint to the
 * dash's corner and on out through the bottom corner; a horizontal spar from each joint
 * out through the side edge; and between the two dash corners the dash's top edge, rising
 * to a short flat in the middle. No top rail: the view is open above. Below the dash's
 * edge and outside the lower pillars a solid hides the world, which is most of what makes
 * it a cockpit. The middle of the view stays clear for the boresight and the target.
 *
 * Every point is laid out on the plane one metre ahead, as tangents of the view angles,
 * so the numbers read directly as screen positions: on a 16:9 window at the 70° field the
 * screen spans ±1.245 across and ±0.7 up. The frame is rigid to the camera, so depth
 * changes nothing on screen; see COCKPIT_SCALE for why it is then drawn nearer.
 */
export const COCKPIT_COLOR = 0x7a8a8c;
/** Held well back: the frame is there, not looked at. */
export const COCKPIT_FADE = 0.32;
/** The dash solid sits this factor farther from the eye than its strokes, so they stay on top. */
export const DASH_SETBACK = 1.01;
/**
 * The frame is laid out at a metre and drawn at this fraction of that. A scale about the
 * eye changes nothing on screen, but it puts the dash NEARER than anything on the hull —
 * the forward thruster nozzles are 0.4 m ahead of the seat — so their exhaust is behind
 * the dash where the dash covers it, instead of flaring in front of it (#52). Still well
 * past the camera's 0.1 m near plane.
 */
export const COCKPIT_SCALE = 0.3;
/** Nearest and farthest the dash solid reaches from the eye, in metres, after scaling. */
export const DASH_DEPTH: readonly [number, number] = [COCKPIT_SCALE, COCKPIT_SCALE];
/** No stroke passes within this of the view axis, as a tangent (0.25 ≈ 14°). */
export const CLEAR_TAN = 0.25;

export type Point = readonly [number, number, number];
const at = (x: number, y: number): Point => [x, y, -1];
const mirror = (p: Point): Point => [-p[0], p[1], p[2]];

// Left side, top to bottom. The right side is its mirror.
const TOP = at(-1.16, 0.77); // off the top edge
const JOINT = at(-0.65, 0.15); // the pillar's inward bend, a little above eye level
const SPAR_END = at(-1.35, 0.15); // off the side edge
const DASH_CORNER = at(-0.96, -0.37);
const BOTTOM = at(-1.45, -0.77); // off the bottom corner
const SHOULDER = at(-0.11, -0.252); // where the dash's edge levels off

export const LEFT_PILLAR: readonly Point[] = [TOP, JOINT, DASH_CORNER, BOTTOM];
export const LEFT_SPAR: readonly Point[] = [JOINT, SPAR_END];
/** The dash's top edge, left to right. */
export const COAMING: readonly Point[] = [DASH_CORNER, SHOULDER, mirror(SHOULDER), mirror(DASH_CORNER)];

export const COCKPIT_POLYLINES: readonly (readonly Point[])[] = [
  LEFT_PILLAR,
  LEFT_PILLAR.map(mirror),
  LEFT_SPAR,
  LEFT_SPAR.map(mirror),
  COAMING,
];

/**
 * The dash solid's outline, counter-clockwise as seen from the seat: along the floor,
 * up the right lower pillar, across the coaming, down the left. The floor corners are
 * flung far out and down so that, on any window, the exhaust of the nose thrusters —
 * which sit below and ahead of the seat — is under the dash wherever it could be seen.
 */
const FLOOR = at(-4, -2.85);
export const DASH_OUTLINE: readonly Point[] = [
  FLOOR, mirror(FLOOR), mirror(BOTTOM), mirror(DASH_CORNER), mirror(SHOULDER), SHOULDER, DASH_CORNER, BOTTOM,
];

/** Flat xyz pairs, one segment per polyline edge. */
export function cockpitStrokes(): Float32Array {
  const out: number[] = [];
  for (const line of COCKPIT_POLYLINES) {
    for (let i = 0; i + 1 < line.length; i++) out.push(...line[i]!, ...line[i + 1]!);
  }
  return new Float32Array(out);
}

/**
 * The dash: DASH_OUTLINE as a fan of triangles, each facing the eye, pushed DASH_SETBACK
 * farther out so the strokes sit a hair in front of it.
 */
export function dashGeometry(): THREE.BufferGeometry {
  const tris: number[] = [];
  const [first] = DASH_OUTLINE;
  for (let i = 1; i + 1 < DASH_OUTLINE.length; i++) tris.push(...first!, ...DASH_OUTLINE[i]!, ...DASH_OUTLINE[i + 1]!);
  // Every triangle must face the eye at the origin: the occluder material culls back faces.
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 9) {
    a.fromArray(tris, i); b.fromArray(tris, i + 3); c.fromArray(tris, i + 6);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (n.dot(a) > 0) {
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
