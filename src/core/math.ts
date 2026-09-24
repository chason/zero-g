/**
 * Thin math layer. Everything else imports vectors and quaternions from here,
 * so the underlying library is swappable and never leaks into the simulation.
 */
export { Vector3, Quaternion, Matrix3 } from 'three';

/** Standard gravity, used only to convert specific impulse and to express felt acceleration in g. */
export const G0 = 9.80665;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Reshape a normalised axis value without disturbing its direction.
 * exponent 1 = linear, 2 = the default input curve, 3 = finer centre.
 * Math.sign keeps the direction that squaring would otherwise destroy.
 */
export function signPow(x: number, exponent = 2): number {
  return Math.sign(x) * Math.pow(Math.abs(x), exponent);
}

/** Zero out device noise below a threshold, rescaling the remainder to keep full range. */
export function deadzone(x: number, threshold = 0.05): number {
  const a = Math.abs(x);
  if (a <= threshold) return 0;
  return Math.sign(x) * ((a - threshold) / (1 - threshold));
}
