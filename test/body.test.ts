import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import { createBody, integrate, angularMomentum, feltAcceleration, OMEGA_EPSILON } from '../src/sim/body';
import type { Wrench } from '../src/sim/body';

const NO_WRENCH: Wrench = { force: new Vector3(), torque: new Vector3() };
const dt = 1 / 120;

function run(body: Parameters<typeof integrate>[0], wrench: Wrench, seconds: number) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) integrate(body, wrench, dt);
  return body;
}

describe('free motion', () => {
  it('drifts forever — velocity never decays', () => {
    const b = createBody({ velocity: new Vector3(0, 0, 100), mass: 1000 });
    run(b, NO_WRENCH, 60);
    // If this fails, something multiplies velocity by a factor < 1 somewhere.
    expect(b.velocity.z).toBeCloseTo(100, 9);
    expect(b.position.z).toBeCloseTo(6000, 2);
  });

  it('accelerates at F/m along the body axis it is pushed on', () => {
    const b = createBody({ mass: 2000 });
    run(b, { force: new Vector3(0, 0, 1000), torque: new Vector3() }, 10);
    // a = 1000/2000 = 0.5 m/s^2, so v = 5 m/s after 10 s
    expect(b.velocity.z).toBeCloseTo(5, 6);
  });

  it('applies force in the BODY frame, rotated into the world', () => {
    // yawed 90 degrees about +Y: body +Z now points along world +X
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const b = createBody({ mass: 1000, orientation: q });
    run(b, { force: new Vector3(0, 0, 1000), torque: new Vector3() }, 1);
    expect(b.velocity.x).toBeCloseTo(1, 6);
    expect(b.velocity.z).toBeCloseTo(0, 6);
  });
});

describe('rotation', () => {
  it('keeps the orientation quaternion normalised', () => {
    const b = createBody({ angularVelocity: new Vector3(2, 0.7, -1.3), inertia: new Vector3(1, 1, 1) });
    run(b, NO_WRENCH, 300);
    expect(b.orientation.length()).toBeCloseTo(1, 9);
  });

  it('conserves angular momentum with no torque', () => {
    const b = createBody({
      angularVelocity: new Vector3(1.0, 0.4, 0.2),
      inertia: new Vector3(1200, 3400, 900),
      mass: 1000,
    });
    const before = angularMomentum(b).length();
    run(b, NO_WRENCH, 120);
    expect(angularMomentum(b).length()).toBeCloseTo(before, 1);
  });

  it('shows the gyroscopic term — an asymmetric body trades rate between axes', () => {
    const b = createBody({
      angularVelocity: new Vector3(1.0, 0.1, 0),
      inertia: new Vector3(1200, 3400, 900),
    });
    const startX = b.angularVelocity.x;
    run(b, NO_WRENCH, 20);
    // Without the w x (I*w) term this stays exactly constant and the test fails.
    expect(Math.abs(b.angularVelocity.x - startX)).toBeGreaterThan(1e-4);
  });

  it('a symmetric body spins with no wobble at all', () => {
    const b = createBody({ angularVelocity: new Vector3(1, 0.5, 0.25), inertia: new Vector3(1000, 1000, 1000) });
    run(b, NO_WRENCH, 20);
    expect(b.angularVelocity.x).toBeCloseTo(1, 6);
    expect(b.angularVelocity.y).toBeCloseTo(0.5, 6);
  });
});

describe('the zero clamp', () => {
  it('falls into zero below the epsilon when nothing is firing', () => {
    const b = createBody({ angularVelocity: new Vector3(OMEGA_EPSILON * 0.4, 0, 0), inertia: new Vector3(1, 1, 1) });
    integrate(b, NO_WRENCH, dt, false);
    expect(b.angularVelocity.x).toBe(0);
  });

  it('leaves a deliberate micro-input alone', () => {
    const b = createBody({ angularVelocity: new Vector3(OMEGA_EPSILON * 0.4, 0, 0), inertia: new Vector3(1, 1, 1) });
    integrate(b, NO_WRENCH, dt, true);
    expect(b.angularVelocity.x).toBeGreaterThan(0);
  });

  it('never clamps a rate the instruments could show', () => {
    // 0.1 deg/s is the HUD resolution; the clamp must sit far below it.
    const visible = (0.1 * Math.PI) / 180;
    const b = createBody({ angularVelocity: new Vector3(visible, 0, 0), inertia: new Vector3(1, 1, 1) });
    integrate(b, NO_WRENCH, dt, false);
    expect(b.angularVelocity.x).toBeCloseTo(visible, 9);
  });
});

describe('felt acceleration at the pilot seat', () => {
  it('is centripetal and grows with the square of spin rate', () => {
    const seat = new Vector3(0, 0, -2);
    const at = (omega: number) => {
      const b = createBody({ angularVelocity: new Vector3(0, omega, 0), inertia: new Vector3(1, 1, 1), mass: 1 });
      return feltAcceleration(b, seat, NO_WRENCH).length();
    };
    // a = omega^2 * r  ->  2 rad/s at 2 m is 8 m/s^2
    expect(at(2)).toBeCloseTo(8, 6);
    // doubling the rate quadruples the load
    expect(at(4)).toBeCloseTo(at(2) * 4, 6);
  });

  it('is zero at the centre of mass under pure rotation', () => {
    const b = createBody({ angularVelocity: new Vector3(0, 5, 0), inertia: new Vector3(1, 1, 1), mass: 1 });
    expect(feltAcceleration(b, new Vector3(), NO_WRENCH).length()).toBeCloseTo(0, 9);
  });
});
