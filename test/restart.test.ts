import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { createWorld, resetRun, step, STEP, createTarget, type TenderSpec } from '../src/sim/world';
import tender from '../src/data/tender.json';
import { createShip, type ShipSpec } from '../src/sim/ship';
import { emptyCommand } from '../src/control';
import { createKeyboardMouse } from '../src/input';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

function flownWorld() {
  const ship = createShip(spec);
  const world = createWorld([ship]);
  world.targets.push(createTarget(tender as TenderSpec, new Vector3(0, 0, -400), new Vector3(0, 0, 1)));
  world.selected = 0;
  const cmd = emptyCommand(ship.prepared.length);
  cmd.throttles[ship.prepared.findIndex((p) => p.spec.id === 'main')] = 1;
  ship.body.angularVelocity.set(4, 0, 0); // spin hard enough to load the pilot
  for (let i = 0; i < 600; i++) step(world, cmd, STEP); // 5 s
  return { ship, world };
}

describe('resetRun', () => {
  it('returns every per-run field to its initial value, in place', () => {
    const { ship, world } = flownWorld();
    const prepared = ship.prepared;
    const throttles = ship.throttles;
    // sanity: the run actually did something
    expect(world.time).toBeGreaterThan(4.9);
    expect(ship.propellant).toBeLessThan(spec.propellantCapacity);
    expect(ship.body.velocity.length()).toBeGreaterThan(0);
    expect(ship.pilot!.reserve).toBeLessThan(1);

    resetRun(world);

    expect(world.time).toBe(0);
    expect(world.contact).toBeNull();
    expect(world.outcome).toBeNull();
    expect(world.summary).toBeNull();
    expect(ship.propellant).toBe(spec.propellantCapacity);
    expect(ship.body.mass).toBeCloseTo(spec.dryMass + spec.propellantCapacity, 9);
    expect(ship.body.position.length()).toBe(0);
    expect(ship.body.velocity.length()).toBe(0);
    expect(ship.body.angularVelocity.length()).toBe(0);
    expect(ship.body.orientation.w).toBe(1);
    expect(ship.body.previous.position.length()).toBe(0);
    expect(ship.pilot).toEqual({ reserve: 1, health: 1, gLoad: 0, peakG: 0 });
    expect(Array.from(ship.throttles).every((t) => t === 0)).toBe(true);
    // identity preserved: nothing downstream needs to re-bind
    expect(ship.prepared).toBe(prepared);
    expect(ship.throttles).toBe(throttles);
    expect(world.ships[0]).toBe(ship);
    // targets and selection untouched
    expect(world.targets.length).toBe(1);
    expect(world.selected).toBe(0);
  });

  it('clears an outcome so the sim runs again', () => {
    const ship = createShip(spec);
    const world = createWorld([ship]);
    ship.pilot!.health = 0;
    step(world, emptyCommand(ship.prepared.length), STEP);
    expect(world.outcome).toBe('blackout');
    const frozenTime = world.time;

    resetRun(world);
    const cmd = emptyCommand(ship.prepared.length);
    cmd.throttles[ship.prepared.findIndex((p) => p.spec.id === 'main')] = 1;
    step(world, cmd, STEP);

    expect(world.outcome).toBeNull();
    expect(world.time).toBeCloseTo(STEP, 9);
    expect(world.time).toBeLessThan(frozenTime + STEP);
    expect(ship.body.velocity.length()).toBeGreaterThan(0);
  });

  it('works mid-run with no outcome', () => {
    const { ship, world } = flownWorld();
    expect(world.outcome).toBeNull();
    resetRun(world);
    expect(world.time).toBe(0);
    expect(ship.body.velocity.length()).toBe(0);
  });
});

describe('Enter restart edge', () => {
  function fakeKeys() {
    const listeners = new Map<string, Set<(e: any) => void>>();
    return {
      addEventListener(type: string, fn: (e: any) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (e: any) => void) { listeners.get(type)?.delete(fn); },
      emit(type: string, e: any) { listeners.get(type)?.forEach((fn) => fn(e)); },
    };
  }

  it('is true for exactly one sample per press, on Enter and NumpadEnter', () => {
    const keys = fakeKeys();
    let t = 0;
    const dev = createKeyboardMouse(null as any, { now: () => t, keySource: keys as any, mouseSource: keys as any });
    expect(dev.sample(1 / 60).restart).toBe(false);
    keys.emit('keydown', { code: 'Enter', repeat: false });
    expect(dev.sample(1 / 60).restart).toBe(true);
    expect(dev.sample(1 / 60).restart).toBe(false);
    keys.emit('keydown', { code: 'Enter', repeat: true });
    expect(dev.sample(1 / 60).restart).toBe(false);
    keys.emit('keyup', { code: 'Enter' });
    keys.emit('keydown', { code: 'NumpadEnter', repeat: false });
    expect(dev.sample(1 / 60).restart).toBe(true);
    expect(dev.sample(1 / 60).restart).toBe(false);
    dev.dispose();
  });
});
