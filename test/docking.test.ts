import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import { createWorld, step, STEP, type Target, type World } from '../src/sim/world';
import { createShip, dockingPortPosition } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { emptyCommand } from '../src/control';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

/** The M6 ring: 400 m down -Z from the starting pose, static, 3 m contact radius. */
const RING_POSITION = new Vector3(0, 0, -400);
const RING_RADIUS = 3;

function ring(): Target {
  return { name: 'ring', position: RING_POSITION.clone(), velocity: new Vector3(), radius: RING_RADIUS };
}

/**
 * A world with one Skiff and the ring. The ship is placed so its docking port sits
 * `gap` metres outside the contact sphere on the approach line, closing at `speed` m/s
 * straight down -Z, with an optional body-frame spin. Nothing is flown through input:
 * the body state is set by hand and step() is driven with an empty command.
 */
function approach(gap: number, speed: number, spin = new Vector3()): { world: World; ship: Ship } {
  const ship = createShip(spec);
  const portZ = spec.dockingPort[2];
  // port must sit at z = ring.z + radius + gap, so the centre of mass sits portZ further back
  ship.body.position.set(0, 0, RING_POSITION.z + RING_RADIUS + gap - portZ);
  ship.body.velocity.set(0, 0, -speed);
  ship.body.angularVelocity.copy(spin);
  const world = createWorld([ship]);
  world.targets.push(ring());
  world.selected = 0;
  return { world, ship };
}

function run(world: World, steps: number): void {
  const cmd = emptyCommand(world.ships[0]!.prepared.length);
  for (let i = 0; i < steps; i++) step(world, cmd, STEP);
}

/** Step until the world records a contact; returns the number of steps taken. Fails past `max`. */
function runUntilContact(world: World, max = 2000): number {
  const cmd = emptyCommand(world.ships[0]!.prepared.length);
  for (let i = 1; i <= max; i++) {
    step(world, cmd, STEP);
    if (world.contact !== null) return i;
  }
  throw new Error(`no contact within ${max} steps`);
}

/**
 * The gap that puts the crossing squarely in the middle of step `n` at `speed`, so the
 * test never sits on a floating-point boundary: after n-1 steps the port is half a step
 * outside the sphere, after n it is half a step inside.
 */
function gapForStep(n: number, speed: number): number {
  return speed * STEP * (n - 0.5);
}

const DEG = Math.PI / 180;

describe('docking port data (#25)', () => {
  it('the Skiff carries a docking port on the nose, ahead of every thruster', () => {
    const [x, y, z] = spec.dockingPort;
    expect(x).toBe(0);
    expect(y).toBe(0);
    // -Z is forward: the hull's nose is what the camera looks down and the port sits on it.
    expect(z).toBeLessThan(0);
    const foremostThruster = Math.min(...spec.thrusters.map((t) => t.position[2]));
    expect(z).toBeLessThan(foremostThruster);
  });
});

describe('docking port world position (#25)', () => {
  it('is the body offset itself for a ship at the origin with identity orientation', () => {
    const ship = createShip(spec);
    const p = dockingPortPosition(ship, new Vector3());
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(0, 12);
    expect(p.z).toBeCloseTo(spec.dockingPort[2], 12);
    expect(p.z).toBeCloseTo(-2.6, 12);
  });

  it('follows the ship: a +90 degree yaw about +Y swings the nose from -Z onto -X', () => {
    const ship = createShip(spec);
    ship.body.orientation.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2));
    const p = dockingPortPosition(ship, new Vector3());
    // Right-handed rotation about +Y carries -Z to -X (and +Z to +X); checked against the
    // quaternion, not assumed.
    const check = new Vector3(...spec.dockingPort).applyQuaternion(ship.body.orientation);
    expect(p.x).toBeCloseTo(check.x, 12);
    expect(p.x).toBeCloseTo(-2.6, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it('adds the centre-of-mass position after rotating the offset', () => {
    const ship = createShip(spec);
    ship.body.position.set(10, 20, 30);
    ship.body.orientation.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2));
    const p = dockingPortPosition(ship, new Vector3());
    expect(p.x).toBeCloseTo(10 - 2.6, 9);
    expect(p.y).toBeCloseTo(20, 9);
    expect(p.z).toBeCloseTo(30, 9);
  });

  it('writes into the supplied vector and allocates none of its own', () => {
    const ship = createShip(spec);
    const out = new Vector3(99, 99, 99);
    expect(dockingPortPosition(ship, out)).toBe(out);
    expect(out.z).toBeCloseTo(-2.6, 12);
  });
});

describe('contact detection (#25)', () => {
  it('starts with no contact', () => {
    const { world } = approach(50, 1);
    expect(world.contact).toBeNull();
    run(world, 10);
    expect(world.contact).toBeNull();
  });

  it('fires when the PORT, not the centre of mass, enters the contact radius', () => {
    // Port just under 0.5 m outside the sphere at 1 m/s: contact on the 60th step.
    const { world, ship } = approach(gapForStep(60, 1), 1);
    run(world, 59);
    expect(world.contact).toBeNull();
    // the centre of mass is still 2.6 m behind the port, well outside the sphere
    expect(ship.body.position.distanceTo(RING_POSITION)).toBeGreaterThan(RING_RADIUS);
    run(world, 1);
    expect(world.contact).not.toBeNull();
    expect(dockingPortPosition(ship, new Vector3()).distanceTo(RING_POSITION)).toBeLessThanOrEqual(RING_RADIUS);
    expect(ship.body.position.distanceTo(RING_POSITION)).toBeGreaterThan(RING_RADIUS);
  });

  it('records the target, the time, the relative speed and the spin at the instant of contact', () => {
    const { world } = approach(gapForStep(150, 0.4), 0.4);
    // the pose after step 150 is at t = 1.25 s, and that is the pose that made contact
    run(world, 149);
    expect(world.contact).toBeNull();
    run(world, 1);
    const c = world.contact!;
    expect(c).not.toBeNull();
    expect(c.targetIndex).toBe(0);
    expect(c.time).toBeCloseTo(150 * STEP, 9);
    expect(c.time).toBe(world.time);
    expect(c.relativeSpeed).toBeCloseTo(0.4, 9);
    expect(c.residualRotationDegPerSec).toBe(0);
  });

  it('records the residual spin in deg/s, and the time of the step that made contact', () => {
    const spin = new Vector3(0, 1.5 * DEG, 0); // 1.5 deg/s of yaw
    const { world } = approach(gapForStep(150, 0.4), 0.4, spin);
    // The yaw swings the nose a few centimetres sideways on the way in, so contact comes a
    // step or two after the straight-line count; the recorded time must be that step's.
    const n = runUntilContact(world);
    expect(n).toBeGreaterThanOrEqual(150);
    expect(n).toBeLessThan(170);
    const c = world.contact!;
    expect(c.time).toBeCloseTo(n * STEP, 9);
    expect(c.time).toBe(world.time);
    expect(c.relativeSpeed).toBeCloseTo(0.4, 9);
    expect(c.residualRotationDegPerSec).toBeCloseTo(1.5, 6);
  });

  it('measures speed relative to the target, not to the world', () => {
    const { world } = approach(0.1, 1);
    // a target receding at 0.7 m/s makes a 1 m/s ship a 0.3 m/s closure
    world.targets[0]!.velocity.set(0, 0, -0.7);
    run(world, 60);
    expect(world.contact).not.toBeNull();
    expect(world.contact!.relativeSpeed).toBeCloseTo(0.3, 9);
  });

  it('fires once and never again: the record is frozen at first contact', () => {
    const { world } = approach(0.1, 2);
    run(world, 20);
    const first = world.contact!;
    expect(first).not.toBeNull();
    const snapshot = { ...first };
    run(world, 200);
    expect(world.contact).toBe(first);
    expect(world.contact).toEqual(snapshot);
  });

  it('does not touch the body: contact has no collision response', () => {
    const { world, ship } = approach(0.1, 2);
    run(world, 20);
    expect(world.contact).not.toBeNull();
    const v = ship.body.velocity.clone();
    const w = ship.body.angularVelocity.clone();
    // one more step with the contact already recorded: the body is untouched by the check
    run(world, 1);
    expect(ship.body.velocity.z).toBeLessThanOrEqual(v.z);
    expect(ship.body.angularVelocity.distanceTo(w)).toBe(0);
  });
});
