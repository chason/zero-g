import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import { alignmentTo, formatAlignment, ALIGNED_DEG, type Alignment } from '../src/hud/instruments/boresight';
import { MIN_MARKER_SPEED } from '../src/hud/instruments/markers';

const out: Alignment = { which: 'pro', deg: 0 };
const fwd = new Vector3(0, 0, -1);

describe('alignmentTo', () => {
  it('nose on the velocity vector is prograde, zero degrees', () => {
    const a = alignmentTo(fwd, new Vector3(0, 0, -10), out)!;
    expect(a.which).toBe('pro');
    expect(a.deg).toBeCloseTo(0, 6);
  });

  it('nose opposite the velocity vector is retrograde, zero degrees', () => {
    const a = alignmentTo(fwd, new Vector3(0, 0, 10), out)!;
    expect(a.which).toBe('retro');
    expect(a.deg).toBeCloseTo(0, 6);
  });

  it('perpendicular reads 90 either way', () => {
    const a = alignmentTo(fwd, new Vector3(10, 0, 0), out)!;
    expect(a.deg).toBeCloseTo(90, 6);
  });

  it('picks the nearer marker and measures from it', () => {
    // 20 deg off retrograde: velocity along +z, nose rotated 20 deg from -z toward +x... i.e. nose 160 deg from +z
    const nose = new Vector3(Math.sin((20 * Math.PI) / 180), 0, -Math.cos((20 * Math.PI) / 180));
    const a = alignmentTo(nose, new Vector3(0, 0, 10), out)!;
    expect(a.which).toBe('retro');
    expect(a.deg).toBeCloseTo(20, 5);
    const b = alignmentTo(nose, new Vector3(0, 0, -10), out)!;
    expect(b.which).toBe('pro');
    expect(b.deg).toBeCloseTo(20, 5);
  });

  it('is null below the marker speed floor and for a zero nose', () => {
    expect(alignmentTo(fwd, new Vector3(0, 0, MIN_MARKER_SPEED * 0.5), out)).toBeNull();
    expect(alignmentTo(new Vector3(), new Vector3(0, 0, 10), out)).toBeNull();
  });

  it('never NaNs on numerically colinear input', () => {
    const a = alignmentTo(new Vector3(0, 0, -1.0000001), new Vector3(0, 0, -3), out)!;
    expect(Number.isFinite(a.deg)).toBe(true);
    expect(a.deg).toBeCloseTo(0, 3);
  });
});

describe('formatAlignment', () => {
  it('is fixed width with one decimal', () => {
    expect(formatAlignment({ which: 'retro', deg: 2.34 })).toBe('RETRO   2.3°');
    expect(formatAlignment({ which: 'pro', deg: 0.04 })).toBe('PRO     0.0°');
    expect(formatAlignment({ which: 'retro', deg: 89.96 })).toBe('RETRO  90.0°');
    expect(formatAlignment({ which: 'retro', deg: 2.34 }).length)
      .toBe(formatAlignment({ which: 'pro', deg: 45 }).length);
  });

  it('aligned threshold is one degree', () => {
    expect(ALIGNED_DEG).toBe(1);
  });
});
