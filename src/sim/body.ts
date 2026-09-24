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

  // --- angular, all in the BODY frame ---
  // Euler's equation, integrated with RK4. Plain forward Euler on this ODE bleeds
  // angular momentum badly (~25% over two minutes) when the spin is near the
  // intermediate principal axis, which is exactly the tennis-racket case the
  // conservation test exercises; RK4 holds |L| to ~1e-8 there.
  const w = body.angularVelocity;
  const I = body.inertia;
  const k1 = angularAcceleration(w, I, wrench.torque);
  const k2 = angularAcceleration(w.clone().addScaledVector(k1, dt / 2), I, wrench.torque);
  const k3 = angularAcceleration(w.clone().addScaledVector(k2, dt / 2), I, wrench.torque);
  const k4 = angularAcceleration(w.clone().addScaledVector(k3, dt), I, wrench.torque);
  w.addScaledVector(k1, dt / 6)
    .addScaledVector(k2, dt / 3)
    .addScaledVector(k3, dt / 3)
    .addScaledVector(k4, dt / 6);

  // --- orientation: qdot = 0.5 * q * (0, w) ---
  const q = body.orientation;
  const qdotX = 0.5 * (q.w * w.x + q.y * w.z - q.z * w.y);
  const qdotY = 0.5 * (q.w * w.y + q.z * w.x - q.x * w.z);
  const qdotZ = 0.5 * (q.w * w.z + q.x * w.y - q.y * w.x);
  const qdotW = 0.5 * (-q.x * w.x - q.y * w.y - q.z * w.z);
  q.set(q.x + qdotX * dt, q.y + qdotY * dt, q.z + qdotZ * dt, q.w + qdotW * dt);
  q.normalize();
}

/**
 * wdot = I^-1 * (torque - w x (I*w)), all in the BODY frame. `inertia` is the
 * diagonal of the tensor, so both products are componentwise. The cross term is
 * the gyroscopic one: it is what makes an asymmetric body trade rate between axes.
 * Pure — allocates a fresh vector and mutates nothing.
 */
function angularAcceleration(w: Vector3, inertia: Vector3, torque: Vector3): Vector3 {
  const Iw = new Vector3(inertia.x * w.x, inertia.y * w.y, inertia.z * w.z);
  const net = w.clone().cross(Iw).multiplyScalar(-1).add(torque);
  return new Vector3(net.x / inertia.x, net.y / inertia.y, net.z / inertia.z);
}

/**
 * Angular momentum in the WORLD frame: q * (I * w) * q^-1.
 * Conserved exactly when no torque is applied; the test suite leans on that.
 */
export function angularMomentum(body: RigidBody): Vector3 {
  const { inertia: I, angularVelocity: w } = body;
  // I * w in the body frame, then rotate into the world frame. Nothing is mutated.
  return new Vector3(I.x * w.x, I.y * w.y, I.z * w.z).applyQuaternion(body.orientation);
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
