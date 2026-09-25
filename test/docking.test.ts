import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import {
  createWorld,
  step,
  STEP,
  DOCK_MAX_SPEED,
  DOCK_MAX_ROTATION_DEG_PER_SEC,
  RING_PLANE_TOLERANCE,
  placeStructure,
  type World,
  type StructureSpec,
} from '../src/sim/world';
import capital from '../src/data/capital.json';
import { createShip, createPilot, dockingPortPosition } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { OMEGA_EPSILON } from '../src/sim/body';
import { RAD_TO_DEG } from '../src/hud/instrument';
import { SPEED_RESOLUTION } from '../src/hud/instruments/velocity';
import { summaryFields, freshSummaryFields, OUTCOME_LABELS } from '../src/hud/instruments/summary';
import { emptyCommand } from '../src/control';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

/** The assigned port of the capital: ring 400 m down -Z from the starting pose, facing +Z. */
const RING_POSITION = new Vector3(0, 0, -400);
/** Contact is judged where the port enters the tolerance band at the ring plane. */
const CONTACT_Z = RING_PLANE_TOLERANCE;

/** Place the capital so its port F6 is the ring above, and assign it. */
function placeCapital(world: World): void {
  const { port } = placeStructure(world, capital as StructureSpec, 'F6', RING_POSITION, new Vector3(0, 0, 1));
  world.assigned = port;
  world.selected = port;
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
  // port must sit at z = ring.z + tolerance + gap, so the centre of mass sits portZ further back
  ship.body.position.set(0, 0, RING_POSITION.z + CONTACT_Z + gap - portZ);
  ship.body.velocity.set(0, 0, -speed);
  ship.body.angularVelocity.copy(spin);
  const world = createWorld([ship]);
  placeCapital(world);
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
    expect(ship.body.position.distanceTo(RING_POSITION)).toBeGreaterThan(CONTACT_Z);
    run(world, 1);
    expect(world.contact).not.toBeNull();
    expect(dockingPortPosition(ship, new Vector3()).distanceTo(RING_POSITION)).toBeLessThanOrEqual(CONTACT_Z);
    expect(ship.body.position.distanceTo(RING_POSITION)).toBeGreaterThan(CONTACT_Z);
  });

  it('records the target, the time, the relative speed and the spin at the instant of contact', () => {
    const { world } = approach(gapForStep(150, 0.4), 0.4);
    // the pose after step 150 is at t = 1.25 s, and that is the pose that made contact
    run(world, 149);
    expect(world.contact).toBeNull();
    run(world, 1);
    const c = world.contact!;
    expect(c).not.toBeNull();
    expect(c.targetIndex).toBe(world.assigned);
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
    world.targets[world.assigned]!.velocity.set(0, 0, -0.7);
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
    const spin = new Vector3(0, 0.5 * DEG, 0);
    const { world, ship } = approach(0.1, 2, spin);
    runUntilContact(world);
    // Coasting, so the integration leaves velocity exactly alone; a collision response
    // would be the only thing that could have changed it on the contact step. The spin
    // is about a principal axis, so it too is exactly what it was.
    expect(ship.body.velocity.x).toBe(0);
    expect(ship.body.velocity.y).toBe(0);
    expect(ship.body.velocity.z).toBe(-2);
    expect(ship.body.angularVelocity.distanceTo(spin)).toBe(0);
  });
});

// --- outcomes (#26) -----------------------------------------------------------------

describe('run outcome: the docking limits (#26)', () => {
  it('are the numbers the issue names', () => {
    expect(DOCK_MAX_SPEED).toBe(0.5);
    expect(DOCK_MAX_ROTATION_DEG_PER_SEC).toBe(2);
  });

  it('sit at least an order of magnitude above every clamp and display floor', () => {
    // The rotation state clamp can zero a rate; it must never be able to decide a run.
    expect(OMEGA_EPSILON * RAD_TO_DEG * 10).toBeLessThan(2);
    expect(OMEGA_EPSILON * RAD_TO_DEG * 10).toBeLessThan(DOCK_MAX_ROTATION_DEG_PER_SEC);
    // Speed has no state clamp at all; its display rounding is still far under the limit.
    expect(SPEED_RESOLUTION * 10).toBeLessThan(DOCK_MAX_SPEED);
  });
});

describe('run outcome: contact (#26)', () => {
  it('is null while the ship is still flying', () => {
    const { world } = approach(50, 1);
    run(world, 30);
    expect(world.outcome).toBeNull();
    expect(world.summary).toBeNull();
  });

  it('slow and straight is a dock', () => {
    const { world } = approach(gapForStep(20, 0.3), 0.3);
    run(world, 19);
    expect(world.outcome).toBeNull();
    run(world, 1);
    expect(world.outcome).toBe('dock');
  });

  it('a contact exactly at the speed limit is still a dock: the limit is inclusive', () => {
    const { world } = approach(gapForStep(20, DOCK_MAX_SPEED), DOCK_MAX_SPEED);
    run(world, 20);
    expect(world.contact!.relativeSpeed).toBe(DOCK_MAX_SPEED);
    expect(world.outcome).toBe('dock');
  });

  it('fast is a crash, however straight', () => {
    const { world } = approach(gapForStep(20, 3), 3);
    run(world, 20);
    expect(world.outcome).toBe('crash');
    expect(world.summary!.contactSpeed).toBeCloseTo(3, 9);
  });

  it('slow but spinning at 3 deg/s is a crash', () => {
    const { world } = approach(gapForStep(20, 0.3), 0.3, new Vector3(0, 3 * DEG, 0));
    runUntilContact(world);
    expect(world.outcome).toBe('crash');
    expect(world.summary!.contactRotation).toBeCloseTo(3, 6);
    expect(world.summary!.contactSpeed).toBeCloseTo(0.3, 9);
  });

  it('slow and spinning at 1 deg/s is a dock', () => {
    const { world } = approach(gapForStep(20, 0.3), 0.3, new Vector3(1 * DEG, 0, 0));
    runUntilContact(world);
    expect(world.outcome).toBe('dock');
    expect(world.summary!.contactRotation).toBeCloseTo(1, 6);
  });

  it('is decided on the same step as the contact, from the contact record', () => {
    const { world } = approach(gapForStep(20, 0.3), 0.3);
    const n = runUntilContact(world);
    expect(n).toBe(20);
    expect(world.outcome).not.toBeNull();
    expect(world.summary!.time).toBe(world.contact!.time);
    expect(world.summary!.contactSpeed).toBe(world.contact!.relativeSpeed);
    expect(world.summary!.contactRotation).toBe(world.contact!.residualRotationDegPerSec);
  });

  it('closes the throttles at the outcome so nothing shows a frozen ship still firing', () => {
    const { world, ship } = approach(5, 0.3);
    const cmd = emptyCommand(ship.prepared.length);
    cmd.throttles[ship.prepared.findIndex((p) => p.spec.id === 'main')] = 1;
    for (let i = 0; i < 19; i++) step(world, cmd, STEP);
    expect(world.outcome).toBeNull();
    expect(Array.from(ship.throttles).some((t) => t > 0)).toBe(true);
    // keep the engine lit all the way in: the step that decides the run closes it anyway
    for (let i = 0; i < 5000 && world.outcome === null; i++) step(world, cmd, STEP);
    expect(world.outcome).not.toBeNull();
    expect(Array.from(ship.throttles).every((t) => t === 0)).toBe(true);
  });
});

describe('run outcome: blackout (#26)', () => {
  it('a pilot at zero health ends the run on the next step, with no contact', () => {
    const { world, ship } = approach(50, 0);
    ship.pilot!.health = 0;
    expect(world.outcome).toBeNull();
    run(world, 1);
    expect(world.outcome).toBe('blackout');
    expect(world.contact).toBeNull();
    expect(world.summary!.time).toBeCloseTo(STEP, 12);
    expect(world.summary!.contactSpeed).toBeUndefined();
    expect(world.summary!.contactRotation).toBeUndefined();
  });

  it('a ship with no pilot cannot black out', () => {
    const { world, ship } = approach(50, 0);
    delete ship.pilot;
    run(world, 120);
    expect(world.outcome).toBeNull();
  });

  it('a contact on the same step as the blackout reads as the contact', () => {
    // port already inside the sphere: contact on the very first step
    const { world, ship } = approach(-0.5, 0);
    ship.pilot!.health = 0;
    run(world, 1);
    expect(world.contact).not.toBeNull();
    expect(world.outcome).toBe('dock');
  });
});

describe('run outcome: the frozen sim (#26)', () => {
  function frozen(): { world: World; ship: Ship } {
    const { world, ship } = approach(gapForStep(20, 3), 3, new Vector3(0, 1 * DEG, 0));
    run(world, 20);
    expect(world.outcome).toBe('crash');
    return { world, ship };
  }

  it('stops integrating: position, velocity, orientation and spin never change again', () => {
    const { world, ship } = frozen();
    const position = ship.body.position.clone();
    const velocity = ship.body.velocity.clone();
    const orientation = ship.body.orientation.clone();
    const spin = ship.body.angularVelocity.clone();
    // full main engine and a yaw thruster pair demanded: the frozen step ignores them all
    const cmd = emptyCommand(ship.prepared.length);
    cmd.throttles.fill(1);
    for (let i = 0; i < 240; i++) step(world, cmd, STEP);
    expect(ship.body.position.distanceTo(position)).toBe(0);
    expect(ship.body.velocity.distanceTo(velocity)).toBe(0);
    expect(ship.body.orientation.equals(orientation)).toBe(true);
    expect(ship.body.angularVelocity.distanceTo(spin)).toBe(0);
    expect(Array.from(ship.throttles).every((t) => t === 0)).toBe(true);
  });

  it('burns no propellant and leaves the pilot alone', () => {
    const { world, ship } = frozen();
    const propellant = ship.propellant;
    const pilot = { ...ship.pilot! };
    const cmd = emptyCommand(ship.prepared.length);
    cmd.throttles.fill(1);
    for (let i = 0; i < 240; i++) step(world, cmd, STEP);
    expect(ship.propellant).toBe(propellant);
    expect(ship.pilot).toEqual(pilot);
  });

  it('pins the render-interpolation pose to the final one, so a frozen ship does not wobble', () => {
    const { world, ship } = frozen();
    expect(ship.body.previous.position.distanceTo(ship.body.position)).toBe(0);
    expect(ship.body.previous.orientation.equals(ship.body.orientation)).toBe(true);
    run(world, 10);
    expect(ship.body.previous.position.distanceTo(ship.body.position)).toBe(0);
  });

  it('keeps the clock running so the HUD lag and the blackout fade can settle', () => {
    const { world } = frozen();
    const t = world.time;
    run(world, 120);
    expect(world.time).toBeCloseTo(t + 1, 9);
  });

  it('never changes its mind: outcome, summary and contact are the same objects afterwards', () => {
    const { world } = frozen();
    const { outcome, summary, contact } = world;
    const summarySnapshot = { ...summary! };
    run(world, 120);
    expect(world.outcome).toBe(outcome);
    expect(world.summary).toBe(summary);
    expect(world.summary).toEqual(summarySnapshot);
    expect(world.contact).toBe(contact);
  });
});

describe('run summary figures (#26)', () => {
  it('propellantUsed is capacity minus what is left in the tanks', () => {
    const { world, ship } = approach(20, 0);
    const cmd = emptyCommand(ship.prepared.length);
    cmd.throttles[ship.prepared.findIndex((p) => p.spec.id === 'main')] = 1;
    // half a second of main engine, then coast the rest of the way in
    for (let i = 0; i < 60; i++) step(world, cmd, STEP);
    expect(ship.propellant).toBeLessThan(spec.propellantCapacity);
    runUntilContact(world);
    expect(world.outcome).toBe('crash'); // ~4 m/s
    expect(world.summary!.propellantUsed).toBeCloseTo(spec.propellantCapacity - ship.propellant, 12);
    expect(world.summary!.propellantUsed).toBeGreaterThan(0);
  });

  it('peakG is at least every g the pilot felt, and exactly the largest', () => {
    // A 2 rad/s ROLL keeps the port and the main engine on the spin axis, so the ship
    // still arrives, while the seat's 0.4 m offset from that axis feels a steady ~0.16 g.
    // A short main burn on top of it makes the peak an earlier, larger figure than the
    // value at contact, so the test tells a running maximum from a final reading.
    const { world, ship } = approach(20, 0, new Vector3(0, 0, 2));
    const cmd = emptyCommand(ship.prepared.length);
    const main = ship.prepared.findIndex((p) => p.spec.id === 'main');
    let seen = 0;
    const sample = () => { seen = Math.max(seen, ship.pilot!.gLoad); };
    cmd.throttles[main] = 1;
    for (let i = 0; i < 30; i++) { step(world, cmd, STEP); sample(); }
    const afterBurn = seen;
    cmd.throttles[main] = 0;
    for (let i = 0; i < 5000 && world.outcome === null; i++) { step(world, cmd, STEP); sample(); }
    expect(world.outcome).not.toBeNull();
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBe(afterBurn);
    expect(ship.pilot!.gLoad).toBeLessThan(seen);
    expect(world.summary!.peakG).toBeGreaterThanOrEqual(seen);
    expect(world.summary!.peakG).toBe(seen);
    expect(ship.pilot!.peakG).toBe(seen);
    // and the pilot's own record never fell below anything it saw
    expect(ship.pilot!.peakG).toBeGreaterThanOrEqual(ship.pilot!.gLoad);
  });

  it('a fresh pilot starts with a zero peak', () => {
    expect(createPilot().peakG).toBe(0);
    expect(createShip(spec).pilot!.peakG).toBe(0);
  });
});

describe('run summary instrument fields (#26)', () => {
  it('is null while the run is live, so the panel stays hidden', () => {
    const { world } = approach(50, 1);
    expect(summaryFields(world, freshSummaryFields())).toBeNull();
    run(world, 10);
    expect(summaryFields(world, freshSummaryFields())).toBeNull();
  });

  it('labels the three outcomes in the words the player reads', () => {
    expect(OUTCOME_LABELS.dock).toBe('DOCKED');
    expect(OUTCOME_LABELS.crash).toBe('CRASHED');
    expect(OUTCOME_LABELS.blackout).toBe('BLACKOUT');
  });

  it('shows a dock with both figures inside their limits', () => {
    const { world } = approach(gapForStep(20, 0.3), 0.3, new Vector3(1 * DEG, 0, 0));
    runUntilContact(world);
    const f = summaryFields(world, freshSummaryFields())!;
    expect(f.headline).toBe('DOCKED');
    expect(f.speed).toBe('0.30');
    expect(f.speedLimit).toBe('0.50');
    expect(f.speedOver).toBe(false);
    expect(f.rotation).toBe('1.0');
    expect(f.rotationLimit).toBe('2.0');
    expect(f.rotationOver).toBe(false);
    expect(f.time).toBe(world.summary!.time.toFixed(1));
    expect(f.propellant).toBe('0.0');
    expect(f.peakG).toBe(world.summary!.peakG.toFixed(1));
  });

  it('flags exactly the figure that lost a crash', () => {
    const fast = approach(gapForStep(20, 3), 3).world;
    run(fast, 20);
    const f = summaryFields(fast, freshSummaryFields())!;
    expect(f.headline).toBe('CRASHED');
    expect(f.speedOver).toBe(true);
    expect(f.rotationOver).toBe(false);

    const spinning = approach(gapForStep(20, 0.3), 0.3, new Vector3(0, 3 * DEG, 0)).world;
    runUntilContact(spinning);
    const g = summaryFields(spinning, freshSummaryFields())!;
    expect(g.headline).toBe('CRASHED');
    expect(g.speedOver).toBe(false);
    expect(g.rotationOver).toBe(true);
  });

  it('flags on the raw figure, not the rounded string', () => {
    const { world } = approach(gapForStep(20, 0.504), 0.504);
    run(world, 20);
    const f = summaryFields(world, freshSummaryFields())!;
    expect(world.outcome).toBe('crash');
    expect(f.speed).toBe('0.50');
    expect(f.speedOver).toBe(true);
  });

  it('leaves the contact rows empty for a blackout', () => {
    const { world, ship } = approach(50, 0);
    ship.pilot!.health = 0;
    run(world, 1);
    const f = summaryFields(world, freshSummaryFields())!;
    expect(f.headline).toBe('BLACKOUT');
    expect(f.speed).toBe('');
    expect(f.rotation).toBe('');
    expect(f.speedOver).toBe(false);
    expect(f.rotationOver).toBe(false);
  });
});
