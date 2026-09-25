import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cockpitStrokes, dashGeometry, createCockpit, COCKPIT_POLYLINES, COCKPIT_FADE, DASH_SETBACK, CLEAR_TAN,
} from '../src/render/cockpit';
import { GLOW_TIERS } from '../src/render/vector';
import skiff from '../src/data/skiff.json';
import { COCKPIT_SCALE, DASH_DEPTH } from '../src/render/cockpit';
import { PLUME_LENGTH, PLUME_RADIUS, plumeScale } from '../src/render/plumes';

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

  it('draws the dash nearer than every forward thruster nozzle, and past the near plane (#52)', () => {
    const { group } = createCockpit();
    expect(group.scale.x).toBeCloseTo(COCKPIT_SCALE, 9);
    // the dash's true depth range is the laid-out range times the scale
    const g = dashGeometry();
    const p = g.getAttribute('position');
    let nearest = Infinity, farthest = 0;
    for (let i = 0; i < p.count; i++) {
      const depth = -p.getZ(i) * COCKPIT_SCALE;
      nearest = Math.min(nearest, depth); farthest = Math.max(farthest, depth);
    }
    expect(nearest).toBeGreaterThan(0.1); // the camera's near plane
    expect(nearest).toBeCloseTo(DASH_DEPTH[0] * DASH_SETBACK, 6);
    expect(farthest).toBeCloseTo(DASH_DEPTH[1] * DASH_SETBACK, 6);
    // every thruster ahead of the seat starts its plume beyond the dash
    const seatZ = skiff.seatOffset[2]!;
    for (const t of skiff.thrusters) {
      const ahead = seatZ - t.position[2]!; // nose is -Z: positive means ahead of the eye
      if (ahead > 0) expect(ahead).toBeGreaterThan(farthest);
    }
  });

  it('hides every forward thruster plume of the skiff behind the dash, from the seat (#52)', () => {
    // The dash is nearer than the nozzles (above), so a plume is hidden wherever it
    // projects inside the dash's outline: below the coaming, or below the dash's outer
    // edge past the coaming's ends. Sample each forward plume's cone and check.
    const [E, F, G, H] = COCKPIT_POLYLINES[1]!;
    const floorCorner: [number, number, number] = [-3.2, -1.7, -0.78]; // dashGeometry's outer floor point
    const tan = (p: readonly [number, number, number]) => [p[0] / -p[2], p[1] / -p[2]] as const;
    const edge = [tan(floorCorner), tan(E!), tan(F!), tan(G!), tan(H!), tan([-floorCorner[0], floorCorner[1], floorCorner[2]])];
    const dashTopAt = (u: number): number => {
      for (let i = 0; i + 1 < edge.length; i++) {
        const [u0, v0] = edge[i]!, [u1, v1] = edge[i + 1]!;
        if (u >= Math.min(u0, u1) && u <= Math.max(u0, u1)) return v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
      }
      return -Infinity; // beyond the floor corners: nothing covers it
    };
    const [sx, sy, sz] = skiff.seatOffset as [number, number, number];
    let maxThrust = 0;
    for (const t of skiff.thrusters) maxThrust = Math.max(maxThrust, t.thrust);
    let checked = 0;
    for (const t of skiff.thrusters) {
      const nozzle = new THREE.Vector3(t.position[0]! - sx, t.position[1]! - sy, t.position[2]! - sz);
      const axis = new THREE.Vector3(...(t.direction as [number, number, number])).normalize().negate();
      if (nozzle.z >= -0.05 && axis.z >= 0) continue; // nothing of it is ahead of the eye
      const s = plumeScale(t.thrust, maxThrust);
      const length = s * PLUME_LENGTH, radius = s * PLUME_RADIUS;
      const side = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const a = new THREE.Vector3().crossVectors(axis, side).normalize();
      const b = new THREE.Vector3().crossVectors(axis, a).normalize();
      for (let k = 0; k <= 8; k++) {
        const f = k / 8;
        const centre = nozzle.clone().addScaledVector(axis, length * f);
        const r = radius * (1 - f);
        for (let j = 0; j < 12; j++) {
          const th = (j / 12) * Math.PI * 2;
          const p = centre.clone().addScaledVector(a, r * Math.cos(th)).addScaledVector(b, r * Math.sin(th));
          if (p.z >= -0.05) continue; // behind or beside the eye: out of the field of view
          const u = p.x / -p.z, v = p.y / -p.z;
          expect(v, `${t.id} plume shows past the dash at (${u.toFixed(2)}, ${v.toFixed(2)})`).toBeLessThan(dashTopAt(u) - 0.02);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50); // the two retro plumes, at least
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
