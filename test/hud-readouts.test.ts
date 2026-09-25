import { describe, it, expect } from 'vitest';
import { Vector3, G0 } from '../src/core/math';
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
import {
  computeReadout as computePropellant,
  deltaV,
  mainIsp,
  propellantFields,
  remainingDeltaV,
} from '../src/hud/instruments/propellant';
import type { PropellantFields, PropellantReadout } from '../src/hud/instruments/propellant';

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
  return { name, position, velocity, axis: new Vector3(0, 0, 1), radius: 2, tube: 0.1, structure: -1, collar: 0 };
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

// --- propellant (#22) ---------------------------------------------------------------

/** A spec with the same tanks as the skiff but a different engine set. */
function specWithThrusters(thrusters: ShipSpec['thrusters']): ShipSpec {
  return { ...spec, thrusters };
}

const freshPropellant = (): PropellantReadout => ({ propellant: 0, fraction: 0, mass: 0, isp: 0, deltaV: 0 });
const freshPropellantFields = (): PropellantFields => ({ propellant: '', percent: '', mass: '', deltaV: '', fraction: 0 });

describe('propellant readout: which Isp', () => {
  it("uses the main engine's Isp, not the RCS thrusters'", () => {
    expect(mainIsp(makeShip())).toBe(320);
  });

  it('falls back to the highest-thrust thruster when there is no main', () => {
    const s = specWithThrusters([
      { id: 'weak', position: [0, 0, 0], direction: [0, 0, -1], thrust: 100, isp: 400 },
      { id: 'strong', position: [0, 0, 0], direction: [0, 0, -1], thrust: 5000, isp: 250 },
      { id: 'medium', position: [0, 0, 0], direction: [0, 0, -1], thrust: 800, isp: 300 },
    ]);
    expect(mainIsp(makeShip(undefined, undefined, s))).toBe(250);
  });

  it('is zero with no thrusters, so delta-v is zero rather than NaN', () => {
    const ship = makeShip(undefined, undefined, specWithThrusters([]));
    expect(mainIsp(ship)).toBe(0);
    expect(remainingDeltaV(ship)).toBe(0);
  });
});

describe('propellant readout: the rocket equation', () => {
  it('dv = isp * g0 * ln(m_now / m_dry), checked by hand', () => {
    // a mass ratio of e makes the log exactly 1, so dv is exactly isp * g0
    expect(deltaV(100, 1000 * Math.E, 1000)).toBeCloseTo(980.665, 9);
    // the skiff, full: 320 * 9.80665 * ln(4900 / 4000) = 636.85 m/s
    expect(remainingDeltaV(makeShip())).toBeCloseTo(636.85, 1);
    expect(remainingDeltaV(makeShip())).toBeCloseTo(320 * G0 * Math.log(4900 / 4000), 9);
  });

  it('is zero once the tanks are dry and never negative', () => {
    const ship = makeShip();
    ship.propellant = 0;
    expect(remainingDeltaV(ship)).toBe(0);
    expect(deltaV(320, 3999, 4000)).toBe(0);
    expect(deltaV(320, 4900, 0)).toBe(0);
  });

  it('reads mass fresh every time rather than caching it', () => {
    const ship = makeShip();
    const full = remainingDeltaV(ship);
    ship.propellant = 450;
    const half = remainingDeltaV(ship);
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo(320 * G0 * Math.log(4450 / 4000), 9);
    expect(computePropellant(ship, freshPropellant()).mass).toBe(4450);
  });
});

describe('propellant readout: fields', () => {
  it('shows kg, percent, current mass and delta-v to the resolutions the pilot reads', () => {
    const f = propellantFields(makeShip(), freshPropellantFields());
    expect(f.propellant).toBe('900.0');
    expect(f.percent).toBe('100');
    expect(f.mass).toBe('4900.0');
    expect(f.deltaV).toBe('636.9');
    expect(f.fraction).toBe(1);
  });

  it('the bar fraction follows the tanks and is clamped to 0..1', () => {
    const ship = makeShip();
    ship.propellant = 225;
    const quarter = computePropellant(ship, freshPropellant());
    expect(quarter.fraction).toBeCloseTo(0.25, 9);
    expect(propellantFields(ship, freshPropellantFields()).percent).toBe('25');
    ship.propellant = 0;
    expect(computePropellant(ship, freshPropellant()).fraction).toBe(0);
  });

  it('never writes to the ship', () => {
    const ship = makeShip();
    propellantFields(ship, freshPropellantFields());
    expect(ship.propellant).toBe(spec.propellantCapacity);
    expect(ship.body.mass).toBe(spec.dryMass + spec.propellantCapacity);
  });
});
