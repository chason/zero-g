import { Vector3, G0 } from '../core/math';
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
export function prepare(_spec: ShipSpec): PreparedThruster[] {
  throw new Error('sim/ship.ts prepare() is not implemented yet — see test/ship.test.ts');
}

/**
 * Sum the open thrusters into a single body-frame wrench.
 * This runs every tick and is the hot path; it should allocate nothing.
 *
 * TODO — implement.
 */
export function netWrench(_ship: Ship, _out?: Wrench): Wrench {
  throw new Error('sim/ship.ts netWrench() is not implemented yet');
}

/** Total kg/s currently being consumed. Feeds back into mass, which feeds back into acceleration. */
export function massFlow(_ship: Ship): number {
  throw new Error('sim/ship.ts massFlow() is not implemented yet');
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
export function solveControlGroups(_prepared: PreparedThruster[]): ControlGroups {
  throw new Error('sim/ship.ts solveControlGroups() is not implemented yet');
}

export { G0 };
