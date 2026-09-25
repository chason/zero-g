import { describe, it, expect } from 'vitest';
import { stepPilot, G_SAFE, DRAIN, RECOVER, HARM } from '../src/sim/pilot';
import { createPilot, createShip, G0 } from '../src/sim/ship';
import type { Pilot, ShipSpec } from '../src/sim/ship';
import { createWorld, step, STEP } from '../src/sim/world';
import { emptyCommand } from '../src/control';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

/** Hold `g` on the pilot for `seconds` of fixed 120 Hz steps. */
function hold(pilot: Pilot, g: number, seconds: number, dt = STEP): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) stepPilot(pilot, g, dt);
}

describe('stepPilot', () => {
  it('exports sane, positive tuning constants', () => {
    expect(G_SAFE).toBeGreaterThan(1);
    expect(DRAIN).toBeGreaterThan(0);
    expect(RECOVER).toBeGreaterThan(0);
    expect(HARM).toBeGreaterThan(0);
  });

  it('records the felt g on the pilot for the HUD', () => {
    const p = createPilot();
    stepPilot(p, 3.7, STEP);
    expect(p.gLoad).toBe(3.7);
    stepPilot(p, 0.2, STEP);
    expect(p.gLoad).toBe(0.2);
  });

  it('survives a 9 g spike for 200 ms: reserve drops, health stays 1', () => {
    const p = createPilot();
    hold(p, 9, 0.2);
    expect(p.reserve).toBeLessThan(1);
    expect(p.reserve).toBeGreaterThan(0);
    expect(p.health).toBe(1);
  });

  it('does not survive 5 g sustained for 30 s: reserve empties, health falls', () => {
    const p = createPilot();
    hold(p, 5, 30);
    expect(p.reserve).toBe(0);
    expect(p.health).toBeLessThan(1);
  });

  it('never drains the reserve at 1 g, however long', () => {
    const p = createPilot();
    hold(p, 1, 600);
    expect(p.reserve).toBe(1);
    expect(p.health).toBe(1);
  });

  it('does not drain the reserve at exactly G_SAFE', () => {
    const p = createPilot();
    hold(p, G_SAFE, 60);
    expect(p.reserve).toBe(1);
    expect(p.health).toBe(1);
  });

  it('drains faster the further above G_SAFE it is', () => {
    const mild = createPilot();
    const hard = createPilot();
    hold(mild, G_SAFE + 1, 1);
    hold(hard, G_SAFE + 2, 1);
    expect(mild.reserve).toBeLessThan(1);
    expect(hard.reserve).toBeLessThan(mild.reserve);
    // the drain goes as the square of the excess: twice the excess, four times the loss
    expect(1 - hard.reserve).toBeCloseTo(4 * (1 - mild.reserve), 9);
  });

  it('refills the reserve after a spike once back below G_SAFE', () => {
    const p = createPilot();
    hold(p, 9, 0.2);
    const afterSpike = p.reserve;
    expect(afterSpike).toBeLessThan(1);

    hold(p, 1, 1);
    expect(p.reserve).toBeGreaterThan(afterSpike);
    expect(p.reserve).toBeCloseTo(Math.min(1, afterSpike + RECOVER * 1), 6);

    hold(p, 1, 10);
    expect(p.reserve).toBe(1);
  });

  it('does not touch health while any reserve remains', () => {
    const p = createPilot();
    // long enough to drain most of the reserve at 4 g, but not all of it
    const secondsToEmpty = 1 / (DRAIN * (4 - G_SAFE) ** 2);
    hold(p, 4, secondsToEmpty * 0.9);
    expect(p.reserve).toBeGreaterThan(0);
    expect(p.reserve).toBeLessThan(0.2);
    expect(p.health).toBe(1);
  });

  it('loses health at HARM per second once the reserve is empty', () => {
    const p = createPilot();
    // 12 g empties the reserve in well under a second; a second in leaves health mid-fall
    hold(p, 12, 1);
    expect(p.reserve).toBe(0);
    const before = p.health;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(1);
    hold(p, 12, 0.5);
    expect(p.health).toBeCloseTo(before - HARM * 0.5, 9);
  });

  it('never lets health rise, even after a long rest with the reserve refilled', () => {
    const p = createPilot();
    hold(p, 6, 4);
    expect(p.reserve).toBe(0);
    const damaged = p.health;
    expect(damaged).toBeLessThan(1);

    hold(p, 0, 600);
    expect(p.reserve).toBe(1);
    expect(p.health).toBe(damaged);
  });

  it('keeps both fields clamped in 0..1 under extreme load and rest', () => {
    const p = createPilot();
    hold(p, 20, 60);
    expect(p.reserve).toBe(0);
    expect(p.health).toBe(0);

    hold(p, 0, 60);
    expect(p.reserve).toBe(1);
    expect(p.health).toBe(0);
  });

  it('gives the same outcome at 60 Hz and 120 Hz, so the fixed rate is not a tuning knob', () => {
    const fine = createPilot();
    const coarse = createPilot();
    hold(fine, 5, 8, 1 / 120);
    hold(coarse, 5, 8, 1 / 60);
    expect(fine.reserve).toBe(0);
    expect(coarse.reserve).toBe(0);
    expect(coarse.health).toBeCloseTo(fine.health, 9);
  });
});

describe('world.step pilot pass', () => {
  it('a Skiff spun to 5 rad/s with no thrust drains its pilot reserve over a few seconds', () => {
    const s = createShip(spec);
    expect(s.pilot).toBeDefined();
    // pitch spin: the seat sits ~2 m off the x axis, so the centripetal term alone is
    // omega^2 r = 25 * 2.04 m/s^2, about 5.2 g
    s.body.angularVelocity.set(5, 0, 0);
    const w = createWorld([s]);
    const cmd = emptyCommand(s.prepared.length);

    for (let i = 0; i < 360; i++) step(w, cmd, STEP);

    const [, seatY, seatZ] = spec.seatOffset;
    const rPerp = Math.hypot(seatY, seatZ);
    expect(s.pilot!.gLoad).toBeCloseTo((25 * rPerp) / G0, 6);
    expect(s.pilot!.reserve).toBeLessThan(1);
    expect(s.pilot!.reserve).toBeGreaterThanOrEqual(0);

    // reads the wrench, writes only the pilot: the body is exactly as the spin left it
    expect(s.body.angularVelocity.x).toBe(5);
    expect(s.body.angularVelocity.y).toBe(0);
    expect(s.body.angularVelocity.z).toBe(0);
    expect(s.body.velocity.length()).toBe(0);
  });

  it('a Skiff at rest keeps a full reserve and full health', () => {
    const s = createShip(spec);
    const w = createWorld([s]);
    const cmd = emptyCommand(s.prepared.length);
    for (let i = 0; i < 360; i++) step(w, cmd, STEP);
    expect(s.pilot!.gLoad).toBe(0);
    expect(s.pilot!.reserve).toBe(1);
    expect(s.pilot!.health).toBe(1);
  });

  it('a ship built without a pilot steps fine and gains none', () => {
    const s = createShip(spec);
    delete s.pilot;
    s.body.angularVelocity.set(5, 0, 0);
    const w = createWorld([s]);
    const cmd = emptyCommand(s.prepared.length);
    for (let i = 0; i < 120; i++) step(w, cmd, STEP);
    expect(s.pilot).toBeUndefined();
    expect(w.time).toBeCloseTo(1, 9);
  });
});
