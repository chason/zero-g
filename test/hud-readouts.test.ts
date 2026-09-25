import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { prepare } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { createBody } from '../src/sim/body';
import { createWorld } from '../src/sim/world';
import type { Target, World } from '../src/sim/world';
import skiff from '../src/data/skiff.json';
import {
  UNAVAILABLE,
  computeReadout,
  formatRange,
  formatRate,
  formatSpeed,
  selectedTarget,
  velocityFields,
} from '../src/hud/instruments/velocity';
import type { VelocityFields, VelocityReadout } from '../src/hud/instruments/velocity';

const spec = skiff as ShipSpec;

/** A skiff with no DOM and no renderer: exactly what the HUD's pure functions read. */
function makeShip(position = new Vector3(), velocity = new Vector3(), s: ShipSpec = spec): Ship {
  const prepared = prepare(s);
  return {
    spec: s,
    body: createBody({
      position,
      velocity,
      mass: s.dryMass + s.propellantCapacity,
      inertia: new Vector3(...s.inertia),
    }),
    propellant: s.propellantCapacity,
    prepared,
    throttles: new Float32Array(prepared.length),
  };
}

function makeTarget(position: Vector3, velocity = new Vector3(), name = 'Ring A'): Target {
  return { name, position, velocity, radius: 2 };
}

function worldWith(ship: Ship, targets: Target[], selected: number): World {
  const world = createWorld([ship]);
  world.targets = targets;
  world.selected = selected;
  return world;
}

const freshReadout = (): VelocityReadout => ({ speed: 0, range: 0, closing: 0 });
const freshFields = (): VelocityFields => ({ target: '', speed: '', range: '', closing: '' });

describe('velocity readout: rounding', () => {
  it('reads 0.00 below the 0.01 m/s display resolution and the true value from it', () => {
    expect(formatSpeed(0.0099)).toBe('0.00');
    expect(formatSpeed(0.01)).toBe('0.01');
    expect(formatSpeed(0)).toBe('0.00');
    expect(formatSpeed(12.5)).toBe('12.50');
  });

  it('signed rates never show -0.00 and carry an explicit sign', () => {
    expect(formatRate(-0.004)).toBe('0.00');
    expect(formatRate(0.004)).toBe('0.00');
    expect(formatRate(-0.35)).toBe('-0.35');
    expect(formatRate(0.35)).toBe('+0.35');
  });
});

describe('velocity readout: relative to the target', () => {
  it('speed is the magnitude of ship velocity minus target velocity', () => {
    const ship = makeShip(new Vector3(), new Vector3(3, 0, 0));
    const target = makeTarget(new Vector3(100, 0, 0), new Vector3(1, 0, 0));
    const r = computeReadout(ship, target, freshReadout());
    expect(r.speed).toBeCloseTo(2, 9);
    expect(r.range).toBeCloseTo(100, 9);
  });

  it('a target moving with the ship reads zero relative speed whatever the world speed', () => {
    const v = new Vector3(40, -7, 12);
    const ship = makeShip(new Vector3(), v.clone());
    const target = makeTarget(new Vector3(0, 0, 50), v.clone());
    expect(computeReadout(ship, target, freshReadout()).speed).toBe(0);
  });

  it('closing rate is negative when approaching, positive when receding, zero abeam', () => {
    const target = makeTarget(new Vector3(100, 0, 0));
    const toward = makeShip(new Vector3(), new Vector3(1, 0, 0));
    const away = makeShip(new Vector3(), new Vector3(-1, 0, 0));
    const abeam = makeShip(new Vector3(), new Vector3(0, 1, 0));
    expect(computeReadout(toward, target, freshReadout()).closing).toBeCloseTo(-1, 9);
    expect(computeReadout(away, target, freshReadout()).closing).toBeCloseTo(1, 9);
    expect(computeReadout(abeam, target, freshReadout()).closing).toBeCloseTo(0, 9);
  });

  it('closing rate is the line-of-sight component, not the full relative speed', () => {
    // 3 m/s toward the target and 4 m/s across it: speed 5, range shrinking at 3
    const target = makeTarget(new Vector3(0, 0, -100));
    const ship = makeShip(new Vector3(), new Vector3(4, 0, -3));
    const r = computeReadout(ship, target, freshReadout());
    expect(r.speed).toBeCloseTo(5, 9);
    expect(r.closing).toBeCloseTo(-3, 9);
  });

  it('a moving target is accounted for in the closing rate', () => {
    // ship still, target running away at 2 m/s: receding
    const target = makeTarget(new Vector3(100, 0, 0), new Vector3(2, 0, 0));
    const ship = makeShip();
    expect(computeReadout(ship, target, freshReadout()).closing).toBeCloseTo(2, 9);
  });

  it('never writes to the ship or the target', () => {
    const ship = makeShip(new Vector3(1, 2, 3), new Vector3(4, 5, 6));
    const target = makeTarget(new Vector3(7, 8, 9), new Vector3(1, 1, 1));
    computeReadout(ship, target, freshReadout());
    expect(ship.body.position.toArray()).toEqual([1, 2, 3]);
    expect(ship.body.velocity.toArray()).toEqual([4, 5, 6]);
    expect(target.position.toArray()).toEqual([7, 8, 9]);
    expect(target.velocity.toArray()).toEqual([1, 1, 1]);
  });
});

describe('velocity readout: range units', () => {
  it('shows metres to one decimal below 10 km and kilometres to one decimal from there', () => {
    expect(formatRange(3.2)).toBe('3.2 m');
    expect(formatRange(9999.9)).toBe('9999.9 m');
    expect(formatRange(10_000)).toBe('10.0 km');
    expect(formatRange(12_345)).toBe('12.3 km');
  });
});

describe('velocity readout: no target', () => {
  it('selected = -1 means no target', () => {
    const ship = makeShip();
    expect(selectedTarget(worldWith(ship, [makeTarget(new Vector3(1, 0, 0))], -1))).toBeNull();
  });

  it('a stale index past the end of targets means no target', () => {
    expect(selectedTarget(worldWith(makeShip(), [], 0))).toBeNull();
  });

  it('shows every field as unavailable rather than world speed', () => {
    const ship = makeShip(new Vector3(), new Vector3(100, 0, 0));
    const f = velocityFields(worldWith(ship, [makeTarget(new Vector3(1, 0, 0))], -1), ship, freshFields());
    expect(f).toEqual({ target: UNAVAILABLE, speed: UNAVAILABLE, range: UNAVAILABLE, closing: UNAVAILABLE });
  });

  it('shows the selected target once one is chosen', () => {
    const ship = makeShip(new Vector3(), new Vector3(0.5, 0, 0));
    const targets = [makeTarget(new Vector3(-100, 0, 0), new Vector3(), 'Ring A'), makeTarget(new Vector3(25_000, 0, 0), new Vector3(), 'Ring B')];
    const f = velocityFields(worldWith(ship, targets, 1), ship, freshFields());
    expect(f).toEqual({ target: 'Ring B', speed: '0.50', range: '25.0 km', closing: '-0.50' });
  });
});
