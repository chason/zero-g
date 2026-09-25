import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import { createBody, cloneBody, integrate } from '../src/sim/body';
import type { Wrench } from '../src/sim/body';

const NO_WRENCH: Wrench = { force: new Vector3(), torque: new Vector3() };
const dt = 1 / 120;

/**
 * Issue #15: the renderer interpolates between the pose at the start of the last physics
 * step and the pose at its end, so a display faster than the physics rate never repeats
 * a frame. That needs every body to carry a `previous` snapshot, taken before it moves.
 */
describe('previous-pose snapshot', () => {
  it('createBody starts with previous equal to current', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
    const b = createBody({ position: new Vector3(3, -4, 5), orientation: q });
    expect(b.previous.position.equals(b.position)).toBe(true);
    expect(b.previous.orientation.equals(b.orientation)).toBe(true);
    // a copy, not the same object: the step must be able to move one without the other
    expect(b.previous.position).not.toBe(b.position);
    expect(b.previous.orientation).not.toBe(b.orientation);
  });

  it('after one step previous holds the pre-step position and position = previous + v*dt', () => {
    const v = new Vector3(12, -3, 100);
    const start = new Vector3(1, 2, 3);
    const b = createBody({ position: start, velocity: v, mass: 1000 });

    integrate(b, NO_WRENCH, dt);

    // previous is the pose from BEFORE the step, taken before anything moved
    expect(b.previous.position.x).toBeCloseTo(start.x, 12);
    expect(b.previous.position.y).toBeCloseTo(start.y, 12);
    expect(b.previous.position.z).toBeCloseTo(start.z, 12);

    // and current is exactly one step of drift further on
    const expected = start.clone().addScaledVector(v, dt);
    expect(b.position.x).toBeCloseTo(expected.x, 12);
    expect(b.position.y).toBeCloseTo(expected.y, 12);
    expect(b.position.z).toBeCloseTo(expected.z, 12);
    expect(b.position.distanceTo(b.previous.position)).toBeCloseTo(v.length() * dt, 12);
  });

  it('snapshots orientation as well, and advances it every step', () => {
    const b = createBody({ angularVelocity: new Vector3(0, 1, 0), inertia: new Vector3(1, 1, 1) });
    integrate(b, NO_WRENCH, dt);
    // previous is still identity; current has rotated
    expect(b.previous.orientation.equals(new Quaternion())).toBe(true);
    expect(b.orientation.equals(new Quaternion())).toBe(false);

    const afterOne = b.orientation.clone();
    integrate(b, NO_WRENCH, dt);
    // the snapshot rolls forward: previous is now the pose at the end of step one
    expect(b.previous.orientation.equals(afterOne)).toBe(true);
    expect(b.orientation.equals(afterOne)).toBe(false);
  });

  it('a lerp by alpha lands between the two poses', () => {
    const v = new Vector3(0, 0, 100);
    const b = createBody({ velocity: v, mass: 1 });
    integrate(b, NO_WRENCH, dt);
    const half = new Vector3().lerpVectors(b.previous.position, b.position, 0.5);
    expect(half.z).toBeCloseTo(0.5 * 100 * dt, 12);
  });

  it('cloneBody keeps the previous snapshot rather than resetting it', () => {
    const b = createBody({ velocity: new Vector3(0, 0, 100), mass: 1 });
    integrate(b, NO_WRENCH, dt);
    const c = cloneBody(b);
    expect(c.previous.position.equals(b.previous.position)).toBe(true);
    expect(c.position.equals(b.position)).toBe(true);
    expect(c.previous.position).not.toBe(b.previous.position);
  });
});
