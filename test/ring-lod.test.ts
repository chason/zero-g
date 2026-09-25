import { describe, it, expect } from 'vitest';
import {
  projectedRadiusPx, ringLodLevel, ringOpacity, createVectorRing,
  RING_LOD_TUBE_PX, RING_FADE_PX, RING_MIN_OPACITY,
} from '../src/render/vector';

describe('ring level of detail', () => {
  it('projects a 3 m ring at 400 m to a few pixels, and near to many', () => {
    // 70 deg vertical fov on a 900 px viewport
    const far = projectedRadiusPx(3, 400, 70, 900);
    expect(far).toBeGreaterThan(3);
    expect(far).toBeLessThan(8);
    expect(projectedRadiusPx(3, 20, 70, 900)).toBeGreaterThan(90);
    expect(projectedRadiusPx(3, 0, 70, 900)).toBe(Infinity);
  });

  it('draws one circle far away, the lattice only once the tube itself is wide', () => {
    const tubePx = (distance: number) => projectedRadiusPx(0.18, distance, 70, 900);
    expect(ringLodLevel(tubePx(400))).toBe(0);
    expect(ringLodLevel(tubePx(60))).toBe(0);   // a clean circle at approach range
    expect(ringLodLevel(tubePx(15))).toBe(1);   // two circles and a few hoops
    expect(ringLodLevel(tubePx(5))).toBe(2);    // the lattice, at docking range
    expect(ringLodLevel(RING_LOD_TUBE_PX[2] - 0.01)).toBe(1);
  });

  it('fades a tiny ring but never loses it', () => {
    expect(ringOpacity(RING_FADE_PX)).toBe(1);
    expect(ringOpacity(1000)).toBe(1);
    expect(ringOpacity(0)).toBe(RING_MIN_OPACITY);
    const mid = ringOpacity((RING_FADE_PX + 2) / 2);
    expect(mid).toBeGreaterThan(RING_MIN_OPACITY);
    expect(mid).toBeLessThan(1);
  });

  it('the far level really is one circle, and levels swap visibility', () => {
    const ring = createVectorRing(3, 0.18, 0xffb347);
    const count = (i: number) => ring.levels[i]!.geometry.getAttribute('instanceStart').count;
    expect(count(0)).toBe(48);
    expect(count(1)).toBeGreaterThan(count(0));
    expect(count(2)).toBeGreaterThan(count(1));

    ring.update(4); // ring 4 px across -> tube 0.24 px
    expect(ring.levels.map((l) => l.visible)).toEqual([true, false, false]);
    expect((ring.levels[0].material as any).opacity).toBeLessThan(1);
    ring.update(400); // ring 400 px -> tube 24 px
    expect(ring.levels.map((l) => l.visible)).toEqual([false, false, true]);
    expect((ring.levels[2].material as any).opacity).toBe(1);
    ring.dispose();
  });
});
