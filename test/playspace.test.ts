import { describe, it, expect, vi, afterEach } from 'vitest';
import readme from '../README.md?raw';
import { Vector3 } from '../src/core/math';
import {
  createWorld,
  step,
  STEP,
  PLAY_SPACE_RADIUS,
  assertWithinPlaySpace,
  type Target, createPort } from '../src/sim/world';
import { prepare } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { createBody } from '../src/sim/body';
import { emptyCommand } from '../src/control';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

function ship(position = new Vector3()): Ship {
  const prepared = prepare(spec);
  return {
    spec,
    body: createBody({
      position,
      mass: spec.dryMass + spec.propellantCapacity,
      inertia: new Vector3(...spec.inertia),
    }),
    propellant: spec.propellantCapacity,
    prepared,
    throttles: new Float32Array(prepared.length),
  };
}

function ring(position: Vector3): Target {
  return createPort('ring', position, new Vector3(0, 0, 1));
}

/** Silence console.warn and count calls; every test gets a fresh spy. */
function spyWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('play-space limit (#17)', () => {
  it('is 10 km, and the README states the same number', () => {
    expect(PLAY_SPACE_RADIUS).toBe(10_000);
    expect(readme).toContain('## Play-space scale');
    expect(readme).toContain(`${PLAY_SPACE_RADIUS / 1000} km`);
    expect(readme).toContain('#17');
  });

  it('accepts the M6 layout: ship at origin, ring 400 m ahead', () => {
    const warn = spyWarn();
    const w = createWorld([ship()]);
    w.targets.push(ring(new Vector3(0, 0, -400)));
    expect(assertWithinPlaySpace(w)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats the boundary itself as inside', () => {
    const warn = spyWarn();
    const w = createWorld([ship(new Vector3(PLAY_SPACE_RADIUS, 0, 0))]);
    expect(assertWithinPlaySpace(w)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, and only once, for a ship beyond the limit', () => {
    const warn = spyWarn();
    const w = createWorld([ship(new Vector3(0, -(PLAY_SPACE_RADIUS + 1), 0))]);
    expect(assertWithinPlaySpace(w)).toBe(false);
    expect(assertWithinPlaySpace(w)).toBe(false);
    expect(assertWithinPlaySpace(w)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('ship "Skiff"');
    expect(message).toContain('#17');
  });

  it('warns for a target placed beyond the limit, naming it', () => {
    const warn = spyWarn();
    const w = createWorld([ship()]);
    w.targets.push(ring(new Vector3(0, 0, -400)));
    w.targets.push({ ...ring(new Vector3(8000, 8000, 0)), name: 'far ring' });
    expect(assertWithinPlaySpace(w)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('target "far ring"');
  });

  it('measures distance from the origin, not from any one axis', () => {
    const warn = spyWarn();
    // Each component is inside the limit; the vector is not.
    const c = PLAY_SPACE_RADIUS * 0.8;
    const w = createWorld([ship(new Vector3(c, c, c))]);
    expect(assertWithinPlaySpace(w)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is enforced by step(), once per world, without touching the physics', () => {
    const warn = spyWarn();
    const w = createWorld([ship(new Vector3(0, 0, -(PLAY_SPACE_RADIUS * 2)))]);
    const s = w.ships[0]!;
    const cmd = emptyCommand(s.prepared.length);
    const before = s.body.position.clone();
    for (let i = 0; i < 120; i++) step(w, cmd, STEP);
    expect(warn).toHaveBeenCalledTimes(1);
    // A coasting ship with no command does not move, and the guard did not move it either.
    expect(s.body.position.distanceTo(before)).toBe(0);
    expect(w.time).toBeCloseTo(1, 9);
  });

  it('warns separately for each world that leaves the play space', () => {
    const warn = spyWarn();
    const a = createWorld([ship(new Vector3(0, 0, PLAY_SPACE_RADIUS * 3))]);
    const b = createWorld([ship(new Vector3(0, 0, PLAY_SPACE_RADIUS * 3))]);
    assertWithinPlaySpace(a);
    assertWithinPlaySpace(a);
    assertWithinPlaySpace(b);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
