import { Vector3, G0 } from '../core/math';
import { createBody } from './body';
import type { RigidBody, Wrench } from './body';

/** One thruster, as it appears in a ship data file. Body frame throughout. */
export interface ThrusterSpec {
  id: string;
  /** offset from the centre of mass, metres */
  position: [number, number, number];
  /** unit vector along which this thruster PUSHES THE SHIP */
  direction: [number, number, number];
  /** newtons at full throttle */
  thrust: number;
  /** specific impulse, seconds */
  isp: number;
}

export interface ShipSpec {
  name: string;
  /** kg, excluding propellant */
  dryMass: number;
  /** diagonal of the inertia tensor at dry mass */
  inertia: [number, number, number];
  /** where the pilot sits, relative to the centre of mass. Tuning dial for g tolerance. */
  seatOffset: [number, number, number];
  /** kg of propellant in the tanks when full */
  propellantCapacity: number;
  thrusters: ThrusterSpec[];
}

/** A thruster with its per-unit-throttle contribution precomputed once at load time. */
export interface PreparedThruster {
  spec: ThrusterSpec;
  /** force in the body frame at full throttle */
  force: Vector3;
  /** torque r x F in the body frame at full throttle */
  torque: Vector3;
  /** kg/s consumed at full throttle */
  massFlow: number;
}

export interface Ship {
  spec: ShipSpec;
  body: RigidBody;
  /** kg remaining */
  propellant: number;
  prepared: PreparedThruster[];
  /** 0..1 per thruster, parallel to `prepared`. Written by control, read by the sim. */
  throttles: Float32Array;
}

/** The six signed control axes. Sign selects which of the twelve thruster groups fires. */
export const CONTROL_AXES = [
  'translateX', 'translateY', 'translateZ',
  'rotateX', 'rotateY', 'rotateZ',
] as const;
export type ControlAxis = (typeof CONTROL_AXES)[number];

/** For each axis, the thruster indices to open for positive and for negative demand. */
export type ControlGroups = Record<ControlAxis, { positive: number[]; negative: number[] }>;

/**
 * Precompute force, torque and mass flow per thruster.
 *
 *   force    = direction * thrust
 *   torque   = position x force
 *   massFlow = thrust / (isp * G0)
 *
 * TODO — implement. Spec: test/ship.test.ts.
 */
export function prepare(spec: ShipSpec): PreparedThruster[] {
  return spec.thrusters.map((thruster) => {
    // Normalise defensively: a hand-edited data file may hold a non-unit direction,
    // and a thruster that pushed harder because someone typed [0, 0, -1.02] would be
    // a miserable bug to find later.
    const dir = new Vector3(...thruster.direction);
    const len = dir.length();
    if (len > 0) dir.divideScalar(len);

    const force = dir.multiplyScalar(thruster.thrust);
    const position = new Vector3(...thruster.position);
    const torque = new Vector3().crossVectors(position, force);

    return {
      spec: thruster,
      force,
      torque,
      massFlow: thruster.thrust / (thruster.isp * G0),
    };
  });
}

/**
 * Sum the open thrusters into a single body-frame wrench.
 * This runs every tick and is the hot path; it should allocate nothing.
 *
 * TODO — implement.
 */
export function netWrench(ship: Ship, out?: Wrench): Wrench {
  const wrench = out ?? { force: new Vector3(), torque: new Vector3() };
  const { force, torque } = wrench;
  force.set(0, 0, 0);
  torque.set(0, 0, 0);

  const { prepared, throttles } = ship;
  for (let i = 0; i < prepared.length; i++) {
    const throttle = throttles[i]!;
    if (throttle === 0) continue;
    const t = prepared[i]!;
    // Component-wise rather than addScaledVector to keep this allocation-free and
    // obvious; this is the per-tick hot path.
    force.x += t.force.x * throttle;
    force.y += t.force.y * throttle;
    force.z += t.force.z * throttle;
    torque.x += t.torque.x * throttle;
    torque.y += t.torque.y * throttle;
    torque.z += t.torque.z * throttle;
  }

  return wrench;
}

/**
 * Build a flight-ready Ship from a data file. Mass and inertia come from the spec:
 * initial mass is dryMass + propellantCapacity, never a literal.
 */
export function createShip(spec: ShipSpec): Ship {
  const prepared = prepare(spec);
  return {
    spec,
    body: createBody({
      mass: spec.dryMass + spec.propellantCapacity,
      inertia: new Vector3(...spec.inertia),
    }),
    propellant: spec.propellantCapacity,
    prepared,
    throttles: new Float32Array(prepared.length),
  };
}

/** Total kg/s currently being consumed. Feeds back into mass, which feeds back into acceleration. */
export function massFlow(ship: Ship): number {
  const { prepared, throttles } = ship;
  let total = 0;
  for (let i = 0; i < prepared.length; i++) {
    const throttle = throttles[i]!;
    if (throttle === 0) continue;
    total += prepared[i]!.massFlow * throttle;
  }
  return total;
}

/** Current total mass. Never hardcode this — cargo and propellant both move it. */
export function currentMass(ship: Ship): number {
  return ship.spec.dryMass + ship.propellant;
}

/**
 * Work out which thruster subset produces net force or torque on each axis while
 * cancelling everything else. Hand-authored groups are fine for a symmetric ship;
 * a least-squares solve over the thruster matrix generalises to asymmetric ones.
 * Built once at load time, never per frame.
 *
 * TODO — implement.
 */
export function solveControlGroups(prepared: PreparedThruster[]): ControlGroups {
  // Each thruster is a 6-vector [Fx, Fy, Fz, Tx, Ty, Tz]; axis i of CONTROL_AXES is
  // component i of that vector. For a symmetric ship every useful group is either a
  // lone thruster through the centre of mass (the main engine) or an opposed pair
  // whose unwanted components annihilate, so we look for exactly those rather than
  // running a least-squares solve we would then have to debug.
  const rows = prepared.map((t) => [
    t.force.x, t.force.y, t.force.z,
    t.torque.x, t.torque.y, t.torque.z,
  ]);

  // Tolerances scale with the ship: 'cancels' must mean cancels, not 'is small
  // compared with the main engine'.
  const scale = [0, 1, 2, 3, 4, 5].map((axis) => {
    let max = 0;
    for (const row of rows) max = Math.max(max, Math.abs(row[axis]!));
    return max;
  });
  const tol = scale.map((s) => Math.max(s * 1e-9, 1e-12));

  const cancelsOthers = (sum: number[], wanted: number): boolean =>
    sum.every((v, axis) => axis === wanted || Math.abs(v) <= tol[axis]!);

  const groups = {} as ControlGroups;

  for (let axis = 0; axis < CONTROL_AXES.length; axis++) {
    const name = CONTROL_AXES[axis]!;
    const positive: number[] = [];
    const negative: number[] = [];

    for (const sign of [1, -1]) {
      const wants = (i: number) => rows[i]![axis]! * sign > tol[axis]!;
      const used = new Set<number>();
      const chosen: number[] = [];

      // A thruster that already produces nothing but the wanted component needs no
      // partner (the main engine, on the centreline).
      for (let i = 0; i < rows.length; i++) {
        if (!wants(i)) continue;
        if (!cancelsOthers(rows[i]!, axis)) continue;
        used.add(i);
        chosen.push(i);
      }

      // Otherwise pair thrusters whose off-axis contributions cancel, strongest first.
      const pairs: Array<{ i: number; j: number; gain: number }> = [];
      for (let i = 0; i < rows.length; i++) {
        if (used.has(i) || !wants(i)) continue;
        for (let j = i + 1; j < rows.length; j++) {
          if (used.has(j) || !wants(j)) continue;
          const sum = rows[i]!.map((v, k) => v + rows[j]![k]!);
          if (!cancelsOthers(sum, axis)) continue;
          pairs.push({ i, j, gain: Math.abs(sum[axis]!) });
        }
      }
      pairs.sort((a, b) => b.gain - a.gain);
      for (const pair of pairs) {
        if (used.has(pair.i) || used.has(pair.j)) continue;
        used.add(pair.i);
        used.add(pair.j);
        chosen.push(pair.i, pair.j);
      }

      chosen.sort((a, b) => a - b);
      if (sign > 0) positive.push(...chosen);
      else negative.push(...chosen);
    }

    groups[name] = { positive, negative };
  }

  return groups;
}

export { G0 };
