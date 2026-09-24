import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { createWorld, step, STEP } from '../src/sim/world';
import { prepare, currentMass } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { createBody } from '../src/sim/body';
import { emptyCommand } from '../src/control';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

function ship(): Ship {
  const prepared = prepare(spec);
  return {
    spec,
    body: createBody({
      mass: spec.dryMass + spec.propellantCapacity,
      inertia: new Vector3(...spec.inertia),
    }),
    propellant: spec.propellantCapacity,
    prepared,
    throttles: new Float32Array(prepared.length),
  };
}

describe('world.step', () => {
  it('advances simulated time by exactly dt', () => {
    const w = createWorld([ship()]);
    const cmd = emptyCommand(w.ships[0]!.prepared.length);
    for (let i = 0; i < 120; i++) step(w, cmd, STEP);
    expect(w.time).toBeCloseTo(1, 9);
  });

  it('burns propellant and loses mass while thrusting', () => {
    const w = createWorld([ship()]);
    const s = w.ships[0]!;
    const cmd = emptyCommand(s.prepared.length);
    const mainIndex = s.prepared.findIndex((p) => p.spec.id === 'main');
    cmd.throttles[mainIndex] = 1;

    const massBefore = currentMass(s);
    for (let i = 0; i < 120; i++) step(w, cmd, STEP);

    expect(s.propellant).toBeLessThan(spec.propellantCapacity);
    expect(currentMass(s)).toBeLessThan(massBefore);
    expect(s.body.velocity.length()).toBeGreaterThan(0);
  });

  it('accelerates harder as the tanks empty', () => {
    const w = createWorld([ship()]);
    const s = w.ships[0]!;
    const cmd = emptyCommand(s.prepared.length);
    cmd.throttles[s.prepared.findIndex((p) => p.spec.id === 'main')] = 1;

    const sample = () => {
      const before = s.body.velocity.length();
      step(w, cmd, STEP);
      return s.body.velocity.length() - before;
    };
    const early = sample();
    for (let i = 0; i < 6000; i++) step(w, cmd, STEP);
    const late = sample();
    expect(late).toBeGreaterThan(early);
  });

  it('does not run out of propellant into negative mass', () => {
    const w = createWorld([ship()]);
    const s = w.ships[0]!;
    const cmd = emptyCommand(s.prepared.length);
    cmd.throttles[s.prepared.findIndex((p) => p.spec.id === 'main')] = 1;
    for (let i = 0; i < 40000; i++) step(w, cmd, STEP);
    expect(s.propellant).toBe(0);
    expect(currentMass(s)).toBeCloseTo(spec.dryMass, 6);
  });
});
