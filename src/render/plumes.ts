import * as THREE from 'three';
import type { PreparedThruster, Ship } from '../sim/ship';

/**
 * Visible exhaust from every open thruster, scaled by throttle. Issue #16.
 *
 * One additive cone per entry in ship.prepared, at that thruster's position and pointing
 * opposite its direction (direction is the way the thruster pushes the ship; the exhaust
 * leaves the other way). Length and opacity follow ship.throttles[i]; a closed thruster's
 * cone is not drawn at all. Everything is read from `ship.prepared`, so a new ship data
 * file gets correct plumes with no change here. The ship is never written.
 *
 * Parenting: in cockpit view the renderer hides the hull, and Three.js hides a hidden
 * object's children with it. The plumes therefore hang off the scene under their own group,
 * which copies the hull's transform on every update. The renderer keeps that transform
 * current in both view modes for exactly this reason.
 *
 * Fade: the sim steps at a fixed rate and the display does not, so a 60 ms RCS pulse can be
 * a single rendered frame. A plume therefore never vanishes abruptly: it decays over FADE_MS
 * of wall-clock time after its thruster closes. Ignition is instant. This is a visual decay
 * of a draw parameter only; nothing in the simulation is touched.
 */
export interface Plumes {
  /** Read the ship, refresh the plumes. `now` is wall-clock ms; defaults to performance.now(). */
  update(ship: Ship, now?: number): void;
  /**
   * read-only: one Mesh per thruster, in `ship.prepared` order, under a group that is a child
   * of the scene (never of the hull) and carries the hull's transform.
   */
  readonly group: THREE.Group;
}

/** metres, at full throttle on the ship's largest thruster */
export const PLUME_LENGTH = 6;
/** metres, radius at the nozzle on the ship's largest thruster */
export const PLUME_RADIUS = 0.7;
/** smallest relative size, so an RCS pulse is unmistakable beside a main engine 80x its thrust */
export const MIN_SCALE = 0.25;
/** ms for a plume to die after its thruster closes */
export const FADE_MS = 100;
export const PLUME_COLOR = 0xa9d4ff;

/**
 * Relative size of a thruster's plume, MIN_SCALE..1, from its thrust against the ship's
 * largest. Square root rather than linear: thrust reads roughly as the area of a flame and
 * size as its diameter, and a linear map would leave everything but the main engine a
 * sliver. The floor keeps small thrusters clearly visible whatever the ratio in the data.
 */
export function plumeScale(thrust: number, maxThrust: number): number {
  if (!(thrust > 0) || !(maxThrust > 0)) return MIN_SCALE;
  const s = Math.sqrt(thrust / maxThrust);
  return s < MIN_SCALE ? MIN_SCALE : s > 1 ? 1 : s;
}

/**
 * Displayed intensity this frame: the throttle itself when it is rising or steady, otherwise
 * the previously displayed value decaying linearly to zero over FADE_MS. Only the shutdown
 * is smoothed, so a single-frame pulse still lands on the eye; a thruster that opens is
 * shown at full strength the same frame.
 */
export function fadeIntensity(shown: number, throttle: number, dtMs: number): number {
  const decayed = dtMs > 0 ? shown - dtMs / FADE_MS : shown;
  const v = throttle > decayed ? throttle : decayed;
  return v > 0 ? v : 0;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Unit cone with its wide end (the nozzle) at the origin and its tip at +Y = 1. Vertex
 * colour runs from full at the nozzle to black at the tip; under additive blending black
 * adds nothing, so the plume fades out along its length for free. Shared by every plume.
 */
function coneGeometry(): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(1, 1, 16, 4, true);
  geo.translate(0, 0.5, 0);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = (1 - pos.getY(i)) ** 2;
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

export function createPlumes(scene: THREE.Scene, hull: THREE.Object3D): Plumes {
  const group = new THREE.Group();
  group.name = 'plumes';
  scene.add(group);

  // Built lazily on the first update and rebuilt whenever ship.prepared is a different
  // array. After that, update() allocates nothing.
  let geometry: THREE.BufferGeometry | undefined;
  let built: PreparedThruster[] | undefined;
  let meshes: THREE.Mesh[] = [];
  let materials: THREE.MeshBasicMaterial[] = [];
  /** relative size per thruster, from plumeScale */
  let sizes = new Float32Array(0);
  /** intensity displayed last frame, the input to the fade */
  let shown = new Float32Array(0);
  let last: number | undefined;
  const axis = new THREE.Vector3();

  function build(prepared: PreparedThruster[]) {
    for (let i = 0; i < meshes.length; i++) {
      group.remove(meshes[i]!);
      materials[i]!.dispose();
    }
    geometry ??= coneGeometry();

    let maxThrust = 0;
    for (const t of prepared) if (t.spec.thrust > maxThrust) maxThrust = t.spec.thrust;

    meshes = new Array<THREE.Mesh>(prepared.length);
    materials = new Array<THREE.MeshBasicMaterial>(prepared.length);
    sizes = new Float32Array(prepared.length);
    shown = new Float32Array(prepared.length);

    for (let i = 0; i < prepared.length; i++) {
      const { spec } = prepared[i]!;
      const material = new THREE.MeshBasicMaterial({
        color: PLUME_COLOR,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = spec.id;
      mesh.position.set(spec.position[0], spec.position[1], spec.position[2]);
      // Exhaust leaves opposite the push. A data file could hold a non-unit direction, so
      // normalise here as prepare() does; a zero direction leaves the cone on +Y.
      axis.set(spec.direction[0], spec.direction[1], spec.direction[2]);
      if (axis.lengthSq() > 0) axis.normalize().negate();
      else axis.copy(UP);
      mesh.quaternion.setFromUnitVectors(UP, axis);
      mesh.visible = false;
      group.add(mesh);
      meshes[i] = mesh;
      materials[i] = material;
      sizes[i] = plumeScale(spec.thrust, maxThrust);
    }
    built = prepared;
  }

  function update(ship: Ship, now: number = performance.now()) {
    if (ship.prepared !== built) build(ship.prepared);
    const dt = last === undefined ? 0 : now - last;
    last = now;

    // Hidden-hull-safe: follow the hull's transform rather than sitting under it.
    group.position.copy(hull.position);
    group.quaternion.copy(hull.quaternion);
    group.scale.copy(hull.scale);

    const { throttles } = ship;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      const raw = throttles[i] ?? 0;
      const throttle = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const k = fadeIntensity(shown[i]!, throttle, dt);
      shown[i] = k;
      if (k <= 0) {
        // Not opacity 0: an invisible mesh costs no draw call.
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const s = sizes[i]!;
      mesh.scale.set(s * PLUME_RADIUS, s * PLUME_LENGTH * k, s * PLUME_RADIUS);
      materials[i]!.opacity = k;
    }
  }

  return { update, group };
}
