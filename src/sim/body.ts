import { Vector3, Quaternion } from '../core/math';

/**
 * The entire simulation state of one rigid body: 13 numbers plus its constants.
 * Frames matter and are noted per field. Getting these confused is the classic bug.
 */
export interface RigidBody {
  /** world frame, metres */
  position: Vector3;
  /** world frame, m/s. Never decays. If this shrinks without a burn, you have written a drag term. */
  velocity: Vector3;
  /** body -> world. Renormalise every tick. */
  orientation: Quaternion;
  /** BODY frame, rad/s */
  angularVelocity: Vector3;
  /** kg, falls as propellant burns */
  mass: number;
  /** diagonal of the inertia tensor, BODY frame, kg m^2 */
  inertia: Vector3;
}

/** A force and torque, both expressed in the BODY frame. */
export interface Wrench {
  force: Vector3;
  torque: Vector3;
}

/** Below this the rotation clamp engages. 0.0003 rad/s is ~0.017 deg/s: six times finer than the HUD resolves. */
export const OMEGA_EPSILON = 3e-4;

export function createBody(init: Partial<RigidBody> = {}): RigidBody {
  return {
    position: init.position?.clone() ?? new Vector3(),
    velocity: init.velocity?.clone() ?? new Vector3(),
    orientation: init.orientation?.clone() ?? new Quaternion(),
    angularVelocity: init.angularVelocity?.clone() ?? new Vector3(),
    mass: init.mass ?? 1,
    inertia: init.inertia?.clone() ?? new Vector3(1, 1, 1),
  };
}

export function cloneBody(b: RigidBody): RigidBody {
  return createBody(b);
}

/**
 * Advance one body by dt using semi-implicit Euler. Mutates `body`.
 *
 * TODO — implement. The spec is test/body.test.ts. In order:
 *   1. linear:  a = (q * force * q^-1) / mass ; v += a*dt ; x += v*dt   (new v, not old)
 *   2. angular: wdot = I^-1 * (torque - w x (I*w))  in the BODY frame
 *               the cross term is the gyroscopic one; it is what makes a tumble wobble
 *   3. quaternion: qdot = 0.5 * q * (0, w) ; q += qdot*dt ; q.normalize()
 *   4. clamp |w| < OMEGA_EPSILON to exactly zero, but only when no thruster on that
 *      axis has fired recently (see hasRecentInput) or deliberate micro-inputs get eaten.
 */
export function integrate(body: RigidBody, wrench: Wrench, dt: number, _hasRecentInput = false): void {
  // --- linear: force arrives in the BODY frame, rotate it into world before use ---
  const accel = wrench.force.clone().applyQuaternion(body.orientation).divideScalar(body.mass);
  body.velocity.addScaledVector(accel, dt);
  // semi-implicit Euler: position uses the NEW velocity
  body.position.addScaledVector(body.velocity, dt);
}

/**
 * Angular momentum in the WORLD frame: q * (I * w) * q^-1.
 * Conserved exactly when no torque is applied; the test suite leans on that.
 *
 * TODO — implement.
 */
export function angularMomentum(_body: RigidBody): Vector3 {
  throw new Error('sim/body.ts angularMomentum() is not implemented yet');
}

/**
 * Specific force felt at a point `rBody` offset from the centre of mass, in the BODY frame:
 *
 *   a_felt = a_linear + wdot x r + w x (w x r)
 *
 * The last term is centripetal and goes as the SQUARE of spin rate, which is what makes
 * the pilot-tolerance mechanic steep. Used by the health system; divide by G0 for g.
 *
 * TODO — implement.
 */
export function feltAcceleration(_body: RigidBody, _rBody: Vector3, _wrench: Wrench): Vector3 {
  throw new Error('sim/body.ts feltAcceleration() is not implemented yet');
}
