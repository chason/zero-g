import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Vector3 } from 'three';
import {
  createDash, facePoint, faceTangent, fixedStrokes, thrusterGlyph, PANELS, THRUSTER_BOXES, FACE_TILT_DEG, LIT_FADES,
} from '../src/render/dash';
import { DASH_OUTLINE, COCKPIT_SCALE, DASH_DEPTH, createCockpit } from '../src/render/cockpit';
import { createHud, DASH_BORNE } from '../src/hud';
import { createShip, type Ship } from '../src/sim/ship';
import { createWorld, type World } from '../src/sim/world';
import skiff from '../src/data/skiff.json';
import type { ShipSpec } from '../src/sim/ship';
import { PerspectiveCamera } from 'three';

const TAN_HALF_V = Math.tan((70 * Math.PI) / 360);
const TAN_HALF_H = TAN_HALF_V * (16 / 9);
const tan = (p: readonly [number, number, number]) => [p[0] / -p[2], p[1] / -p[2]] as const;
function dashTopAt(u: number): number {
  let top = -Infinity;
  for (let i = 0; i < DASH_OUTLINE.length; i++) {
    const [u0, v0] = tan(DASH_OUTLINE[i]!), [u1, v1] = tan(DASH_OUTLINE[(i + 1) % DASH_OUTLINE.length]!);
    if (u0 === u1 || u < Math.min(u0, u1) || u > Math.max(u0, u1)) continue;
    top = Math.max(top, v0 + ((u - u0) / (u1 - u0)) * (v1 - v0));
  }
  return top;
}

function fresh(): { world: World; ship: Ship } {
  const ship = createShip(skiff as unknown as ShipSpec);
  const world = createWorld([ship]);
  return { world, ship };
}

describe('dash instruments (#54): the face and the layout', () => {
  it('the face leans back: the top of a panel is farther from the eye than its bottom', () => {
    expect(FACE_TILT_DEG).toBeGreaterThan(0);
    const low = facePoint(0, 0.1), high = facePoint(0, 0.4);
    expect(-high[2]).toBeGreaterThan(-low[2]);
    expect(high[1]).toBeGreaterThan(low[1]);
  });

  it('every panel and thruster view lies inside the dash, on a 16:9 screen', () => {
    for (const r of [...Object.values(PANELS), ...Object.values(THRUSTER_BOXES)]) {
      for (const [s, t] of [[r.s0, r.t0], [r.s1, r.t0], [r.s0, r.t1], [r.s1, r.t1]] as const) {
        const [u, v] = faceTangent(s, t);
        expect(Math.abs(u)).toBeLessThan(TAN_HALF_H);
        expect(v).toBeGreaterThan(-TAN_HALF_V); // above the bottom of the screen
        expect(v).toBeLessThan(dashTopAt(u) - 0.01); // below the dash's edge, with a little bezel of dash around it
      }
    }
  });

  it('the panels do not overlap each other', () => {
    const rects = [...Object.values(PANELS), ...Object.values(THRUSTER_BOXES)];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        const apart = a.s1 <= b.s0 || b.s1 <= a.s0 || a.t1 <= b.t0 || b.t1 <= a.t0;
        expect(apart).toBe(true);
      }
    }
  });

  it('the fixed strokes stay inside the dash too', () => {
    const q = fixedStrokes();
    expect(q.length % 4).toBe(0);
    expect(q.length / 4).toBeGreaterThan(100);
    for (let i = 0; i < q.length; i += 2) {
      const [u, v] = faceTangent(q[i]!, q[i + 1]!);
      expect(v).toBeLessThan(dashTopAt(u));
      expect(v).toBeGreaterThan(-TAN_HALF_V - 0.02);
    }
  });

  it('a thruster glyph is a dot and an arrow along the push, or a ring when the push is normal to the view', () => {
    const box = THRUSTER_BOXES.top;
    const arrow: number[] = [];
    thrusterGlyph(arrow, { x: 0.08, y: 0.08, dx: 1, dy: 0, n: 0 }, box);
    expect(arrow.length / 4).toBe(4 + 1 + 2); // diamond, shaft, two barbs
    const shaft = arrow.slice(16, 20);
    expect(shaft[2]! - shaft[0]!).toBeGreaterThan(0); // the shaft runs along +s for a +x push
    expect(shaft[3]).toBeCloseTo(shaft[1]!, 9);
    const ring: number[] = [];
    thrusterGlyph(ring, { x: 0.08, y: 0.08, dx: 0, dy: 0, n: -1 }, box);
    expect(ring.length / 4).toBe(8 + 2); // octagon and a cross: pushes away from the viewer
    const ringDot: number[] = [];
    thrusterGlyph(ringDot, { x: 0.08, y: 0.08, dx: 0, dy: 0, n: 1 }, box);
    expect(ringDot.length / 4).toBe(8 + 4); // octagon and a diamond: toward the viewer
  });
});

describe('dash instruments (#54): reading the ship', () => {
  it('draws rotation into the band its rate falls in, and nothing when the ship is still', () => {
    const { world, ship } = fresh();
    const dash = createDash();
    dash.update(world);
    const count = (set: { tiers: { geometry: { instanceCount: number } }[] }) => set.tiers[0]!.geometry.instanceCount;
    expect(count(dash.rot.dim)).toBeGreaterThan(0); // three " 0.0" readings, all dim
    expect(count(dash.rot.live)).toBe(0);
    expect(count(dash.rot.alert)).toBe(0);
    ship.body.angularVelocity.set(0.05, 0, 0.5); // 2.9 deg/s pitch: live; 28.6 deg/s roll: alert
    dash.update(world);
    expect(count(dash.rot.dim)).toBeGreaterThan(0); // yaw
    expect(count(dash.rot.live)).toBeGreaterThan(0);
    expect(count(dash.rot.alert)).toBeGreaterThan(0);
    dash.dispose();
  });

  it('draws the nav and propellant readouts, and only redraws when the text changes', () => {
    const { world, ship } = fresh();
    const dash = createDash();
    dash.update(world);
    const count = (set: { tiers: { geometry: { instanceCount: number } }[] }) => set.tiers[0]!.geometry.instanceCount;
    expect(count(dash.nav)).toBeGreaterThan(0); // "REL --" and friends
    expect(count(dash.prop)).toBeGreaterThan(0);
    const before = count(dash.prop);
    ship.propellant = ship.spec.propellantCapacity / 2; // shorter bar, different digits
    dash.update(world);
    expect(count(dash.prop)).not.toBe(before);
    dash.dispose();
  });

  it('lights thruster glyphs by throttle, in three brightnesses', () => {
    const { world, ship } = fresh();
    const dash = createDash();
    dash.update(world);
    const count = (set: { tiers: { geometry: { instanceCount: number } }[] }) => set.tiers[0]!.geometry.instanceCount;
    expect(count(dash.outlines)).toBeGreaterThan(0);
    for (const set of dash.lit) expect(count(set)).toBe(0);
    ship.throttles[0] = 1;
    ship.throttles[1] = 0.5;
    ship.throttles[2] = 0.2;
    dash.update(world);
    expect(count(dash.lit[2])).toBeGreaterThan(0);
    expect(count(dash.lit[1])).toBeGreaterThan(0);
    expect(count(dash.lit[0])).toBeGreaterThan(0);
    expect(LIT_FADES[0]).toBeLessThan(LIT_FADES[1]);
    expect(LIT_FADES[1]).toBeLessThan(LIT_FADES[2]);
    ship.throttles.fill(0);
    dash.update(world);
    for (const set of dash.lit) expect(count(set)).toBe(0);
    dash.dispose();
  });

  it('rides the cockpit: laid out in its frame, scaled with it, nearer than the dash solid', () => {
    const cockpit = createCockpit();
    expect(cockpit.group.children).toContain(cockpit.dash.group);
    expect(cockpit.group.scale.x).toBeCloseTo(COCKPIT_SCALE, 9);
    // the face is in front of the dash solid everywhere the instruments are
    for (const r of Object.values(PANELS)) {
      for (const t of [r.t0, r.t1]) expect(-facePoint(0, t)[2] * COCKPIT_SCALE).toBeLessThan(DASH_DEPTH[0]);
    }
    const { world } = fresh();
    cockpit.update(world);
  });
});

describe('screen HUD in the two views (#54)', () => {
  const g = globalThis as unknown as { document?: Document; innerWidth?: number; innerHeight?: number; addEventListener?: unknown };
  let saved: unknown[];
  beforeAll(() => {
    saved = [g.document, g.innerWidth, g.innerHeight, g.addEventListener];
    // a tiny DOM: enough for mount() and for the registry's boxes
    class El {
      children: El[] = []; style: Record<string, string> = {}; className = ''; textContent = '';
      attrs: Record<string, string> = {};
      appendChild(c: El) { this.children.push(c); return c; }
      setAttribute(k: string, v: string) { this.attrs[k] = v; }
      removeChild(c: El) { this.children = this.children.filter((x) => x !== c); }
      querySelector() { return null; }
      classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    }
    g.document = { createElement: () => new El(), createElementNS: () => new El() } as unknown as Document;
    g.innerWidth = 800; g.innerHeight = 450; g.addEventListener = () => {};
  });
  afterAll(() => { [g.document, g.innerWidth, g.innerHeight, g.addEventListener] = saved as [Document, number, number, unknown]; });

  it('hides the dash-borne readouts in cockpit view and shows them in chase view', () => {
    const root = (globalThis as unknown as { document: Document }).document.createElement('div') as unknown as { children: { className: string; style: Record<string, string> }[] };
    const hud = createHud(root as unknown as HTMLElement, new PerspectiveCamera(70, 16 / 9, 0.1, 1e7));
    const { world } = fresh();
    expect(DASH_BORNE).toEqual(new Set(['rotation', 'velocity', 'propellant', 'thrusters']));
    hud.draw(world, 'cockpit');
    const boxes = root.children;
    expect(boxes.length).toBe(8);
    for (const box of boxes) {
      const name = box.className.replace('inst-box inst-box-', '');
      expect(box.style.display, name).toBe(DASH_BORNE.has(name) ? 'none' : '');
    }
    hud.draw(world, 'chase');
    for (const box of boxes) expect(box.style.display).toBe('');
    hud.draw(world); // the default is the chase view's screen HUD
    for (const box of boxes) expect(box.style.display).toBe('');
  });
});
