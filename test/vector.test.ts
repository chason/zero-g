import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  edgeSegmentCount, createVectorLines, createVectorStrokes, torusStrokes,
  projectedRadiusPx, farFade,
  GLOW_TIERS, CORE_WHITE, CREASE_DEG, FAR_MIN_OPACITY, FAR_FADE_PX,
} from '../src/render/vector';
import { BLOOM_STRENGTH, PHOSPHOR_DECAY } from '../src/render/post';

describe('vector strokes', () => {
  it('draws a cone as twelve spokes and a rim, not a fan of triangles', () => {
    const cone = new THREE.ConeGeometry(1.2, 5, 12);
    expect(edgeSegmentCount(cone)).toBe(24);
    expect(new THREE.WireframeGeometry(cone).getAttribute('position').count / 2).toBeGreaterThan(24);
    expect(CREASE_DEG).toBeGreaterThan(0);
  });

  it('draws a torus as hoops and longitudes, every one present', () => {
    const seg = torusStrokes(3, 0.18, 24, 6, 8, 48);
    expect(seg.length / 6).toBe(24 * 8 + 6 * 48);
    for (let i = 0; i < seg.length; i += 3) {
      const x = seg[i]!, y = seg[i + 1]!, z = seg[i + 2]!;
      expect(Math.hypot(Math.hypot(x, y) - 3, z)).toBeCloseTo(0.18, 5);
    }
  });
});

describe('the glow is in the stroke, not a blur', () => {
  it('draws every stroke set in tiers: a core and wider, dimmer bands, all normal-blended', () => {
    const s = createVectorLines(new THREE.ConeGeometry(1, 2, 8), 0x9fd9cc);
    expect(s.tiers.length).toBe(GLOW_TIERS.length);
    expect(GLOW_TIERS.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < s.tiers.length; i++) {
      const m = s.tiers[i]!.material as any;
      expect(m.linewidth).toBe(GLOW_TIERS[i]![0]);
      expect(m.opacity).toBeCloseTo(GLOW_TIERS[i]![1], 9);
      // normal blending is the whole point: overlapping halos converge on the halo
      // colour instead of summing, so a pile of lines cannot become a sun
      expect(m.blending).toBe(THREE.NormalBlending);
      expect(m.depthWrite).toBe(false);
      if (i > 0) {
        expect(GLOW_TIERS[i]![0]).toBeGreaterThan(GLOW_TIERS[i - 1]![0]);
        expect(GLOW_TIERS[i]![1]).toBeLessThan(GLOW_TIERS[i - 1]![1]);
      }
    }
    // the core is pushed toward white; every band keeps the stroke colour
    const coreColor = (s.tiers[0]!.material as any).color as THREE.Color;
    const bandColor = (s.tiers[1]!.material as any).color as THREE.Color;
    expect(bandColor.getHex()).toBe(0x9fd9cc);
    expect(coreColor.r + coreColor.g + coreColor.b).toBeGreaterThan(bandColor.r + bandColor.g + bandColor.b);
    expect(CORE_WHITE).toBeGreaterThan(0);
    expect(CORE_WHITE).toBeLessThan(1);
    // one geometry shared by all tiers
    expect(new Set(s.tiers.map((t) => t.geometry)).size).toBe(1);
    // widest band drawn first, core last, so the core sits on its halo
    const orders = s.tiers.map((t) => t.renderOrder);
    expect(orders).toEqual([...orders].sort((a, b) => b - a));
    s.dispose();
  });

  it('fades all tiers together and never below the floor for a distant object', () => {
    const s = createVectorStrokes(torusStrokes(3, 0.18), 0xffb347);
    s.setFade(0.5);
    s.tiers.forEach((t, i) => expect((t.material as any).opacity).toBeCloseTo(GLOW_TIERS[i]![1] * 0.5, 9));
    expect(farFade(1000)).toBe(1);
    expect(farFade(FAR_FADE_PX)).toBe(1);
    expect(farFade(0)).toBe(FAR_MIN_OPACITY);
    // continuous: no step anywhere in the range, so nothing pops on approach
    let prev = farFade(0);
    for (let px = 0; px <= FAR_FADE_PX + 5; px += 0.1) {
      const f = farFade(px);
      expect(f - prev).toBeGreaterThanOrEqual(0);
      expect(f - prev).toBeLessThan(0.02);
      prev = f;
    }
    s.dispose();
  });

  it('projects a 3 m ring at 400 m to a few pixels', () => {
    const far = projectedRadiusPx(3, 400, 70, 900);
    expect(far).toBeGreaterThan(3);
    expect(far).toBeLessThan(8);
    expect(projectedRadiusPx(3, 0, 70, 900)).toBe(Infinity);
  });

  it('keeps the screen-space bloom off by default and the persistence subtle', () => {
    expect(BLOOM_STRENGTH).toBe(0);
    expect(PHOSPHOR_DECAY).toBeGreaterThanOrEqual(0);
    expect(PHOSPHOR_DECAY).toBeLessThan(0.9);
  });
});
