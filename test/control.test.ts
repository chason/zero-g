import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { prepare } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { createBody } from '../src/sim/body';
import { resolve } from '../src/control';
import { emptyAxes, FINE_SCALE } from '../src/input';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

function ship(): Ship {
  const prepared = prepare(spec);
  return {
    spec,
    body: createBody({ mass: spec.dryMass, inertia: new Vector3(...spec.inertia) }),
    propellant: spec.propellantCapacity,
    prepared,
    throttles: new Float32Array(prepared.length),
  };
}

describe('resolve', () => {
  it('opens nothing when the sticks are centred', () => {
    const cmd = resolve(ship(), emptyAxes());
    expect(cmd.throttles.some((t) => t !== 0)).toBe(false);
  });

  it('opposite demands select different thruster groups', () => {
    const s = ship();
    const left = { ...emptyAxes(), rotate: { x: 0, y: -1, z: 0 } };
    const right = { ...emptyAxes(), rotate: { x: 0, y: 1, z: 0 } };
    const a = Array.from(resolve(s, left).throttles);
    const b = Array.from(resolve(s, right).throttles);
    expect(a).not.toEqual(b);
    expect(a.some((t) => t > 0)).toBe(true);
    expect(b.some((t) => t > 0)).toBe(true);
  });

  it('passes partial demand through proportionally', () => {
    const s = ship();
    const half = resolve(s, { ...emptyAxes(), rotate: { x: 0, y: 0.5, z: 0 } });
    expect(Math.max(...half.throttles)).toBeCloseTo(0.5, 6);
  });

  it('fine mode scales everything down', () => {
    const s = ship();
    const fine = resolve(s, { ...emptyAxes(), rotate: { x: 0, y: 1, z: 0 }, fine: true });
    expect(Math.max(...fine.throttles)).toBeCloseTo(FINE_SCALE, 6);
  });

  it('never exceeds full throttle when axes share a thruster', () => {
    const s = ship();
    const cmd = resolve(s, { ...emptyAxes(), rotate: { x: 1, y: 1, z: 1 }, translate: { x: 1, y: 1, z: 1 } });
    expect(Math.max(...cmd.throttles)).toBeLessThanOrEqual(1);
  });

  it('cutAll closes everything', () => {
    const s = ship();
    const cmd = resolve(s, { ...emptyAxes(), rotate: { x: 1, y: 1, z: 1 }, cutAll: true });
    expect(cmd.throttles.some((t) => t !== 0)).toBe(false);
  });
});
