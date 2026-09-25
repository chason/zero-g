import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createRotation, formatRate, rateBand, RATE_WIDTH, DIM_BELOW_DEG, ALERT_ABOVE_DEG,
} from '../src/hud/instruments/rotation';
import { RAD_TO_DEG } from '../src/hud/instrument';
import type { HudContext } from '../src/hud/instrument';
import { Vector3 } from '../src/core/math';
import { OMEGA_EPSILON } from '../src/sim/body';

/** deg/s -> rad/s, the unit the body state is actually in */
const deg = (d: number) => d / RAD_TO_DEG;

describe('formatRate — signed deg/s to one decimal', () => {
  it('shows a positive rate with an explicit + sign', () => {
    expect(formatRate(deg(3.2))).toBe('  +3.2');
  });

  it('shows a negative rate with a - sign', () => {
    expect(formatRate(deg(-0.4))).toBe('  -0.4');
  });

  it('shows exactly zero as " 0.0" with a blank in the sign column', () => {
    expect(formatRate(0)).toBe('   0.0');
    expect(formatRate(-0)).toBe('   0.0');
  });

  it('never shows -0.0: a tiny negative rate reads 0.0', () => {
    expect(formatRate(deg(-0.049))).toBe('   0.0');
    expect(formatRate(deg(-0.0001))).toBe('   0.0');
    expect(formatRate(deg(-0.049))).not.toContain('-');
  });

  it('rounds a value just under 0.05 deg/s down to 0.0, and just over up to 0.1', () => {
    expect(formatRate(deg(0.049))).toBe('   0.0');
    expect(formatRate(deg(0.06))).toBe('  +0.1');
  });

  it('rounds to one decimal, no more', () => {
    expect(formatRate(deg(3.26))).toBe('  +3.3');
    expect(formatRate(deg(3.24))).toBe('  +3.2');
    expect(formatRate(deg(-12.55))).toBe(' -12.6');
    expect(formatRate(deg(0.96))).toBe('  +1.0');
  });

  it('keeps the physics clamp invisible: OMEGA_EPSILON reads 0.0', () => {
    // 0.0003 rad/s ~ 0.017 deg/s: six times finer than the readout resolves
    expect(formatRate(OMEGA_EPSILON)).toBe('   0.0');
    expect(formatRate(-OMEGA_EPSILON)).toBe('   0.0');
  });

  it('is fixed width with the decimal point in the same column for every value', () => {
    const samples = [0, 0.04, 0.4, -0.4, 3.2, -3.2, 12.5, -12.5, 99.9, -99.9, 123.4, -123.4];
    const strings = samples.map((d) => formatRate(deg(d)));
    for (const s of strings) expect(s).toHaveLength(RATE_WIDTH);
    const dots = new Set(strings.map((s) => s.indexOf('.')));
    expect(dots.size).toBe(1);
    expect(dots.has(RATE_WIDTH - 2)).toBe(true);
    expect(strings).toContain('+123.4');
    expect(strings).toContain(' -99.9');
  });
});

describe('rateBand — magnitude cue', () => {
  it('is dim below 0.5 deg/s, including zero', () => {
    expect(rateBand(0)).toBe('dim');
    expect(rateBand(deg(0.4))).toBe('dim');
    expect(rateBand(deg(-0.4))).toBe('dim');
    expect(rateBand(OMEGA_EPSILON)).toBe('dim');
  });

  it('is live from 0.5 deg/s up to and including 10 deg/s', () => {
    expect(rateBand(deg(DIM_BELOW_DEG))).toBe('live');
    expect(rateBand(deg(3.2))).toBe('live');
    expect(rateBand(deg(-3.2))).toBe('live');
    expect(rateBand(deg(ALERT_ABOVE_DEG))).toBe('live');
  });

  it('is alert above 10 deg/s in either direction', () => {
    expect(rateBand(deg(10.1))).toBe('alert');
    expect(rateBand(deg(-15))).toBe('alert');
    expect(rateBand(deg(400))).toBe('alert');
  });

  it('agrees with the displayed digits, not the raw value', () => {
    // 0.46 displays as +0.5, so it must be live even though the raw value is under 0.5
    expect(formatRate(deg(0.46))).toBe('  +0.5');
    expect(rateBand(deg(0.46))).toBe('live');
    // 0.44 displays as +0.4 and stays dim
    expect(formatRate(deg(0.44))).toBe('  +0.4');
    expect(rateBand(deg(0.44))).toBe('dim');
  });
});

/**
 * There is no DOM in the node test environment. This is the smallest stand-in that lets
 * the mount/draw wiring be exercised: it records how many times textContent is written so
 * "do not touch the DOM when the string has not changed" is a testable claim.
 */
class FakeElement {
  className = '';
  children: FakeElement[] = [];
  writes = 0;
  private text = '';
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; this.writes++; }
  appendChild(c: FakeElement): FakeElement { this.children.push(c); return c; }
}

function fakeCtx(pitch: number, yaw: number, roll: number): HudContext {
  // rad/s, BODY frame — the only thing the instrument reads
  return { ship: { body: { angularVelocity: new Vector3(pitch, yaw, roll) } } } as unknown as HudContext;
}

describe('createRotation — mount/draw wiring against a fake DOM', () => {
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  beforeAll(() => {
    saved = g.document;
    g.document = { createElement: () => new FakeElement() };
  });
  afterAll(() => { g.document = saved; });

  function mounted() {
    const root = new FakeElement();
    const inst = createRotation();
    inst.mount(root as unknown as HTMLElement);
    const el = root.children[0]!;
    const rows = el.children.filter((c) => c.className.startsWith('rot-row'));
    return { inst, el, rows, values: rows.map((r) => r.children[1]!), labels: rows.map((r) => r.children[0]!) };
  }

  it('builds one .inst-rotation with PITCH, YAW, ROLL rows reading 0.0 and dim', () => {
    const { el, rows, labels, values } = mounted();
    expect(el.className).toBe('inst inst-rotation');
    expect(rows).toHaveLength(3);
    expect(labels.map((l) => l.textContent.trim())).toEqual(['PITCH', 'YAW', 'ROLL']);
    for (const v of values) expect(v.textContent).toBe('   0.0');
    for (const r of rows) expect(r.className).toContain('rate-dim');
  });

  it('maps body x/y/z to pitch/yaw/roll in deg/s', () => {
    const { inst, values } = mounted();
    inst.draw(fakeCtx(deg(3.2), deg(-0.4), 0));
    expect(values.map((v) => v.textContent)).toEqual(['  +3.2', '  -0.4', '   0.0']);
  });

  it('does not write to the DOM when the displayed string has not changed', () => {
    const { inst, values, rows } = mounted();
    const ctx = fakeCtx(deg(3.2), deg(-0.4), 0);
    inst.draw(ctx);
    const after = values.map((v) => v.writes);
    // roll was 0.0 at mount and is still 0.0: one write (mount), none from draw
    expect(after[2]).toBe(1);
    inst.draw(ctx);
    inst.draw(fakeCtx(deg(3.21), deg(-0.41), deg(0.01))); // same digits, sub-resolution change
    expect(values.map((v) => v.writes)).toEqual(after);
    // 3.2 is live; -0.4 is under the 0.5 dim threshold; roll is still zero
    expect(rows.map((r) => r.className)).toEqual(['rot-row rate-live', 'rot-row rate-dim', 'rot-row rate-dim']);
  });

  it('toggles the magnitude class per row as rates cross the thresholds', () => {
    const { inst, rows } = mounted();
    inst.draw(fakeCtx(deg(12), deg(0.5), deg(-0.1)));
    expect(rows.map((r) => r.className)).toEqual(['rot-row rate-alert', 'rot-row rate-live', 'rot-row rate-dim']);
    inst.draw(fakeCtx(deg(0.2), deg(-30), 0));
    expect(rows.map((r) => r.className)).toEqual(['rot-row rate-dim', 'rot-row rate-alert', 'rot-row rate-dim']);
  });

  it('never mutates the state it reads', () => {
    const { inst } = mounted();
    const ctx = fakeCtx(deg(3.2), deg(-0.4), deg(12));
    const before = ctx.ship.body.angularVelocity.clone();
    inst.draw(ctx);
    expect(ctx.ship.body.angularVelocity.equals(before)).toBe(true);
  });
});
