import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { createWorld, step, STEP } from '../src/sim/world';
import { createShip, type ShipSpec } from '../src/sim/ship';
import { emptyCommand, resolve } from '../src/control';
import { emptyAxes, createKeyboardMouse } from '../src/input';
import skiff from '../src/data/skiff.json';

/**
 * Handedness: the hull's nose is body -Z (the cone is rotated so, and the camera looks
 * down -Z), +X is starboard, +Y is dorsal. These tests pin what every control DOES to
 * the ship, in world space, so a sign error in any layer fails here instead of in the
 * pilot's hands.
 */
const spec = skiff as ShipSpec;
const NOSE = new Vector3(0, 0, -1);

function fly(axes: ReturnType<typeof emptyAxes>, seconds = 1) {
  const ship = createShip(spec);
  const world = createWorld([ship]);
  const cmd = emptyCommand(ship.prepared.length);
  resolve(ship, axes, cmd);
  for (let i = 0; i < seconds / STEP; i++) step(world, cmd, STEP);
  return ship;
}

describe('translation keys', () => {
  it('W accelerates along the nose', () => {
    const s = fly({ ...emptyAxes(), translate: { x: 0, y: 0, z: -1 } });
    expect(s.body.velocity.dot(NOSE)).toBeGreaterThan(0);
    expect(Math.abs(s.body.velocity.z)).toBeGreaterThan(1); // main engine, not a retro
  });
  it('S accelerates backwards, on the retros', () => {
    const s = fly({ ...emptyAxes(), translate: { x: 0, y: 0, z: 1 } });
    expect(s.body.velocity.dot(NOSE)).toBeLessThan(0);
    expect(Math.abs(s.body.velocity.z)).toBeLessThan(1);
  });
  it('D goes starboard (+X), R goes dorsal (+Y)', () => {
    expect(fly({ ...emptyAxes(), translate: { x: 1, y: 0, z: 0 } }).body.velocity.x).toBeGreaterThan(0);
    expect(fly({ ...emptyAxes(), translate: { x: 0, y: 1, z: 0 } }).body.velocity.y).toBeGreaterThan(0);
  });
});

describe('rotation', () => {
  const noseAfter = (rotate: { x: number; y: number; z: number }) =>
    NOSE.clone().applyQuaternion(fly({ ...emptyAxes(), rotate }, 2).body.orientation);

  it('a positive (body-frame, +Y torque) yaw demand turns the nose to PORT', () => {
    // AxisState.rotate is body-frame torque sign, not pilot-frame. Rotation about +Y
    // carries a -Z nose toward -X. Yaw RIGHT is therefore a negative demand, which is
    // the input layer's job to produce — pinned in the device test below.
    expect(noseAfter({ x: 0, y: 1, z: 0 }).x).toBeLessThan(-0.05);
    expect(noseAfter({ x: 0, y: -1, z: 0 }).x).toBeGreaterThan(0.05);
  });
  it('a negative roll demand rolls right: starboard wing goes down', () => {
    const right = new Vector3(1, 0, 0).applyQuaternion(fly({ ...emptyAxes(), rotate: { x: 0, y: 0, z: -1 } }, 2).body.orientation);
    expect(right.y).toBeLessThan(-0.05);
  });
  it('positive pitch demand raises the nose', () => {
    // Stick pulled back (mouse toward the pilot) pitches up: joystick convention.
    expect(noseAfter({ x: 1, y: 0, z: 0 }).y).toBeGreaterThan(0.05);
  });
});

describe('keyboard and mouse produce those demands', () => {
  function fakeSource() {
    const listeners = new Map<string, Set<(e: any) => void>>();
    return {
      addEventListener(t: string, f: (e: any) => void) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f); },
      removeEventListener(t: string, f: (e: any) => void) { listeners.get(t)?.delete(f); },
      emit(t: string, e: any) { listeners.get(t)?.forEach((f) => f(e)); },
    };
  }
  it('W is nose-forward, mouse right is yaw right, mouse back is pitch up, E rolls right', () => {
    const src = fakeSource();
    let t = 0;
    const dev = createKeyboardMouse(null as any, { now: () => t, keySource: src as any, mouseSource: src as any });
    src.emit('keydown', { code: 'KeyW' });
    let a = dev.sample(1 / 60);
    expect(a.translate.z).toBe(-1);
    src.emit('keyup', { code: 'KeyW' }); t += 100; dev.sample(1 / 60);

    src.emit('mousemove', { movementX: 200, movementY: 0 });
    a = dev.sample(1 / 60);
    expect(a.rotate.y).toBeLessThan(0); // yaw right = -Y torque for a -Z nose
    t += 1000; dev.sample(1); // spring back

    src.emit('mousemove', { movementX: 0, movementY: 200 }); // mouse toward the pilot
    a = dev.sample(1 / 60);
    expect(a.rotate.x).toBeGreaterThan(0);
    t += 1000; dev.sample(1);

    src.emit('keydown', { code: 'KeyE' });
    expect(dev.sample(1 / 60).rotate.z).toBe(-1);
    dev.dispose();
  });
});
