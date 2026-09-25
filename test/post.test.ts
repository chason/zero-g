import { describe, it, expect } from 'vitest';
import {
  blackoutCurve,
  chase,
  blackoutAmount,
  DESATURATE_WINDOW,
  VIGNETTE_WINDOW,
  DARKEN_WINDOW,
  ONSET_TAU,
  RECOVERY_TAU,
  SETTLE,
  type BlackoutCurve,
} from '../src/render/post';

/** Reserve values from full to empty, inclusive, evenly spaced. */
function sweep(n = 400): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(1 - i / n);
  return out;
}

const KEYS = ['desaturate', 'vignette', 'darken'] as const;

describe('post: reserve → effect curve', () => {
  it('is no effect at all at a full reserve', () => {
    const c = blackoutCurve(1);
    expect(c).toEqual({ desaturate: 0, vignette: 0, darken: 0 });
  });

  it('is the full effect at an empty reserve', () => {
    const c = blackoutCurve(0);
    expect(c).toEqual({ desaturate: 1, vignette: 1, darken: 1 });
  });

  it('stays within 0..1 and clamps out-of-range or NaN input', () => {
    expect(blackoutCurve(1.5)).toEqual({ desaturate: 0, vignette: 0, darken: 0 });
    expect(blackoutCurve(-0.5)).toEqual({ desaturate: 1, vignette: 1, darken: 1 });
    // A broken pilot value must read as "no effect", never as a black screen.
    expect(blackoutCurve(NaN)).toEqual({ desaturate: 0, vignette: 0, darken: 0 });
    for (const r of sweep()) {
      const c = blackoutCurve(r);
      for (const k of KEYS) {
        expect(c[k]).toBeGreaterThanOrEqual(0);
        expect(c[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every component is monotonic as the reserve drains', () => {
    let prev = blackoutCurve(1);
    for (const r of sweep().slice(1)) {
      const c = blackoutCurve(r);
      for (const k of KEYS) expect(c[k]).toBeGreaterThanOrEqual(prev[k]);
      prev = c;
    }
  });

  it('desaturates first, then vignettes, then darkens', () => {
    for (const r of sweep()) {
      const c = blackoutCurve(r);
      expect(c.desaturate).toBeGreaterThanOrEqual(c.vignette);
      expect(c.vignette).toBeGreaterThanOrEqual(c.darken);
    }
    // Colour is visibly going while the tunnel has not begun.
    const early = blackoutCurve(1 - (VIGNETTE_WINDOW[0] + DESATURATE_WINDOW[0]) / 2);
    expect(early.desaturate).toBeGreaterThan(0);
    expect(early.vignette).toBe(0);
    expect(early.darken).toBe(0);
    // The tunnel is well under way while the darkening has not begun.
    const mid = blackoutCurve(1 - (DARKEN_WINDOW[0] + VIGNETTE_WINDOW[0]) / 2);
    expect(mid.vignette).toBeGreaterThan(0);
    expect(mid.darken).toBe(0);
  });

  it('closes the tunnel before the view is fully black', () => {
    // At the reserve where the vignette first reaches 1 there is still light to lose.
    const shut = blackoutCurve(1 - VIGNETTE_WINDOW[1]);
    expect(shut.vignette).toBe(1);
    expect(shut.darken).toBeLessThan(1);
    expect(shut.darken).toBeGreaterThan(0);
    // ...and it is only lost exactly at zero.
    expect(blackoutCurve(0.01).darken).toBeLessThan(1);
    expect(blackoutCurve(0).darken).toBe(1);
  });

  it('is gentle at onset: a barely-dented reserve is invisible', () => {
    const c = blackoutCurve(0.99);
    for (const k of KEYS) expect(c[k]).toBeLessThan(0.002);
  });

  it('writes into the supplied scratch object and allocates nothing', () => {
    const out: BlackoutCurve = { desaturate: 9, vignette: 9, darken: 9 };
    const ret = blackoutCurve(0.5, out);
    expect(ret).toBe(out);
    expect(out.desaturate).toBeLessThanOrEqual(1);
  });
});

describe('post: felt reserve chases the real one', () => {
  it('leaves the value alone for zero, negative or NaN dt', () => {
    expect(chase(0.4, 1, 0)).toBe(0.4);
    expect(chase(0.4, 1, -0.1)).toBe(0.4);
    expect(chase(0.4, 1, NaN)).toBe(0.4);
  });

  it('approaches the target and never overshoots, in both directions', () => {
    // Onset: reserve drops from full to 0.3.
    let felt = 1;
    let prev = felt;
    for (let i = 0; i < 200; i++) {
      felt = chase(felt, 0.3, 1 / 120);
      expect(felt).toBeLessThanOrEqual(prev);
      expect(felt).toBeGreaterThanOrEqual(0.3);
      prev = felt;
    }
    expect(felt).toBe(0.3);

    // Recovery: reserve refills from empty to full.
    felt = 0;
    prev = felt;
    for (let i = 0; i < 1200; i++) {
      felt = chase(felt, 1, 1 / 120);
      expect(felt).toBeGreaterThanOrEqual(prev);
      expect(felt).toBeLessThanOrEqual(1);
      prev = felt;
    }
    expect(felt).toBe(1);
  });

  it('settles EXACTLY on the target so a full reserve switches the pass off', () => {
    let felt = 0;
    let t = 0;
    while (felt !== 1 && t < 10) {
      felt = chase(felt, 1, 1 / 120);
      t += 1 / 120;
    }
    expect(felt).toBe(1);
    // A single huge step lands on the target too.
    expect(chase(0, 1, 60)).toBe(1);
    expect(chase(1, 0, 60)).toBe(0);
  });

  it('is first-order exponential with the stated time constants', () => {
    // After one time constant the remaining gap is 1/e of the original.
    const onset = chase(1, 0, ONSET_TAU);
    expect(onset).toBeCloseTo(Math.exp(-1), 9);
    const recovery = chase(0, 1, RECOVERY_TAU);
    expect(1 - recovery).toBeCloseTo(Math.exp(-1), 9);
  });

  it('is frame-rate independent: many small steps land where one big step does', () => {
    const big = chase(0, 1, 0.1);
    let small = 0;
    for (let i = 0; i < 10; i++) small = chase(small, 1, 0.01);
    expect(small).toBeCloseTo(big, 12);

    const bigDown = chase(1, 0.2, 0.05);
    let smallDown = 1;
    for (let i = 0; i < 6; i++) smallDown = chase(smallDown, 0.2, 0.05 / 6);
    expect(smallDown).toBeCloseTo(bigDown, 12);
  });

  it('recovers slower than it sets in', () => {
    expect(RECOVERY_TAU).toBeGreaterThan(ONSET_TAU);
    const dt = 0.05;
    const onsetMoved = 1 - chase(1, 0, dt);
    const recoveryMoved = chase(0, 1, dt);
    expect(onsetMoved).toBeGreaterThan(recoveryMoved);
  });

  it('lags a refilled reserve by a few hundred milliseconds, not a frame', () => {
    // Reserve snaps from empty to full. One frame later the view is still mostly gone;
    // a few hundred ms later it is coming back; well under a few seconds it is clear.
    const STEP = 1 / 120;
    let felt = 0;
    felt = chase(felt, 1, STEP);
    expect(felt).toBeLessThan(0.05);
    let t = STEP;
    while (t < 0.3) { felt = chase(felt, 1, STEP); t += STEP; }
    expect(felt).toBeGreaterThan(0.4);
    expect(felt).toBeLessThan(0.7);
    while (t < 3) { felt = chase(felt, 1, STEP); t += STEP; }
    expect(felt).toBe(1);
  });

  it('snap window is small enough to be invisible', () => {
    expect(SETTLE).toBeLessThan(0.01);
    const c = blackoutCurve(1 - SETTLE);
    for (const k of KEYS) expect(c[k]).toBeLessThan(1e-4);
  });
});

describe('post: audio hook', () => {
  it('reports no blackout before anything has rendered', () => {
    expect(blackoutAmount()).toBe(0);
  });
});
