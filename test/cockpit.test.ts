import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cockpitStrokes, dashGeometry, createCockpit, COCKPIT_POLYLINES, COCKPIT_FADE, DASH_SETBACK, CLEAR_TAN,
} from '../src/render/cockpit';
import { GLOW_TIERS } from '../src/render/vector';

const TAN_HALF_V = Math.tan((70 * Math.PI) / 360); // the camera's vertical half-field
const TAN_HALF_H = TAN_HALF_V * (16 / 9);

describe('cockpit frame', () => {
  it('has one segment per polyline edge, every one ahead of the eye and past the near plane', () => {
    const seg = cockpitStrokes();
    const edges = COCKPIT_POLYLINES.reduce((n, line) => n + line.length - 1, 0);
    expect(seg.length).toBe(edges * 6);
    for (let i = 2; i < seg.length; i += 3) expect(seg[i]).toBeLessThan(-0.1);
  });

  it('keeps the middle of the view clear for the boresight and the target', () => {
    const seg = cockpitStrokes();
    for (let i = 0; i < seg.length; i += 6) {
      // project both ends to tangents and take the segment's closest approach to the axis
      const ax = seg[i]! / -seg[i + 2]!, ay = seg[i + 1]! / -seg[i + 2]!;
      const bx = seg[i + 3]! / -seg[i + 5]!, by = seg[i + 4]! / -seg[i + 5]!;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      expect(d).toBeGreaterThan(CLEAR_TAN);
    }
  });

  it('puts the top rail and the coaming on a 16:9 screen, and the side rails off it', () => {
    const [topRail, coaming, , , , , , upperLeftRail] = COCKPIT_POLYLINES;
    for (const p of [...topRail!, ...coaming!]) {
      expect(Math.abs(p[1] / p[2])).toBeLessThan(TAN_HALF_V);
    }
    // the coaming's outer corners are just past the side edges: the frame wraps the screen
    expect(Math.abs(coaming![0]![0] / coaming![0]![2])).toBeGreaterThan(TAN_HALF_H);
    const railEnd = upperLeftRail![1]!;
    expect(Math.abs(railEnd[0] / railEnd[2])).toBeGreaterThan(TAN_HALF_H * 3);
  });

  it('dash faces the eye, sits behind its strokes, and covers the bottom of the view', () => {
    const g = dashGeometry();
    const p = g.getAttribute('position');
    expect(p.count % 3).toBe(0);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    let lowest = 0;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.crossVectors(b.clone().sub(a), c.clone().sub(a));
      expect(n.dot(a)).toBeLessThan(0); // normal toward the origin: front-facing from the seat
      for (const v of [a, b, c]) {
        expect(v.z).toBeLessThan(-0.1);
        lowest = Math.min(lowest, v.y / -v.z);
      }
    }
    expect(lowest).toBeLessThan(-TAN_HALF_V * 1.5);
    // the coaming's first point, pushed out by the setback, is a dash vertex
    const [E] = COCKPIT_POLYLINES[1]!;
    let found = false;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i) - E![0] * DASH_SETBACK) < 1e-6 && Math.abs(p.getY(i) - E![1] * DASH_SETBACK) < 1e-6) found = true;
    }
    expect(found).toBe(true);
    expect(DASH_SETBACK).toBeGreaterThan(1);
  });

  it('is a faded stroke set with the dash as its solid', () => {
    const { group, strokes } = createCockpit();
    expect(strokes.occluder).not.toBeNull();
    expect(group.children).toContain(strokes.occluder);
    expect(strokes.tiers.length).toBe(GLOW_TIERS.length);
    expect((strokes.tiers[0]!.material as THREE.Material).opacity).toBeCloseTo(GLOW_TIERS[0]![1] * COCKPIT_FADE, 6);
    strokes.dispose();
  });
});
