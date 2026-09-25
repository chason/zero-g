import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Ship, PreparedThruster } from '../sim/ship';
import { createVectorStrokes, createDynamicStrokes, type VectorStrokes, type DynamicStrokes } from './vector';
import { textStrokes, textWidth } from './vectorfont';
import { formatRate, rateBand, type RateBand } from '../hud/instruments/rotation';
import { propellantFields, type PropellantFields } from '../hud/instruments/propellant';
import { velocityFields, UNAVAILABLE, type VelocityFields } from '../hud/instruments/velocity';
import { layoutThrusters, type ThrusterLayout, type ViewPoint } from '../hud/instruments/thrusters';

/**
 * The dash instruments (#54): the four readouts as physical parts of the cockpit, drawn
 * in the same strokes as everything else and read off the panel the way a pilot would.
 * In cockpit view these replace the screen HUD's ROT, REL/VEL/RNG/CLS, thruster lights
 * and PROP; the boresight, brackets, markers and summary stay on the canopy, because
 * they track the world. The numbers come from the same pure functions the screen HUD
 * uses, so the two never disagree.
 *
 * The instruments sit on the dash's FACE: a plane through FACE_ORIGIN, leaning back by
 * FACE_TILT_DEG so the top of a panel is a little farther from the eye than its bottom.
 * That is what makes them read as a surface rather than an overlay. Everything is laid
 * out in face coordinates — s across, t up the face, in the cockpit's metre-ahead layout
 * units (see cockpit.ts) — and `faceTangent` says where a face point lands on screen.
 *
 * Layout, left to right: ROT | REL/VEL/RNG/CLS over the two thruster views | PROP.
 */
export const INSTRUMENT_COLOR = 0x7fd4c1;
export const ALERT_COLOR = 0xffb347;
export const BEZEL_FADE = 0.4;
export const OUTLINE_FADE = 0.3;
/** lit thruster glyphs are drawn in one of three brightnesses by throttle */
export const LIT_FADES: readonly [number, number, number] = [0.45, 0.75, 1];

export type Point = readonly [number, number, number];
export const FACE_ORIGIN: Point = [0, -0.74, -0.95];
export const FACE_TILT_DEG = 20;
const TILT = (FACE_TILT_DEG * Math.PI) / 180;
const T_AXIS: Point = [0, Math.cos(TILT), -Math.sin(TILT)];

/** A face point (s across, t up) in the cockpit's layout frame. */
export function facePoint(s: number, t: number): [number, number, number] {
  return [FACE_ORIGIN[0] + s, FACE_ORIGIN[1] + T_AXIS[1] * t, FACE_ORIGIN[2] + T_AXIS[2] * t];
}

/** Where a face point lands on screen, as view tangents (x/depth, y/depth). */
export function faceTangent(s: number, t: number): [number, number] {
  const [x, y, z] = facePoint(s, t);
  return [x / -z, y / -z];
}

export interface Rect { s0: number; s1: number; t0: number; t1: number }
/** Bezelled panels, in face units. */
export const PANELS: Readonly<Record<'rot' | 'nav' | 'prop', Rect>> = {
  rot: { s0: -1.0, s1: -0.58, t0: 0.08, t1: 0.34 },
  nav: { s0: -0.34, s1: 0.34, t0: 0.265, t1: 0.445 },
  prop: { s0: 0.58, s1: 1.0, t0: 0.08, t1: 0.34 },
};
/** The two thruster views: frames of their own, no bezel. */
export const THRUSTER_BOXES: Readonly<Record<'top' | 'side', Rect>> = {
  top: { s0: -0.27, s1: -0.11, t0: 0.07, t1: 0.23 },
  side: { s0: 0.11, s1: 0.27, t0: 0.07, t1: 0.23 },
};
const BOX = THRUSTER_BOXES.top.s1 - THRUSTER_BOXES.top.s0;
const BOX_INSET = 0.02;
const CHAMFER = 0.015;
const PAD = 0.03;
/** cap heights */
const SIDE_CAP = 0.03;
const NAV_CAP = 0.026;
const CAPTION_CAP = 0.02;
const SIDE_PITCH = 0.058;
const NAV_PITCH = 0.04;
/** thruster glyph sizes, face units */
const DOT_R = 0.004;
const RING_R = 0.007;
const TICK = 0.016;
const BARB = 0.006;
const BARB_RAD = (35 * Math.PI) / 180;
const EPS = 1e-6;

// --- 2-D drawing into a flat s0,t0,s1,t1 list ----------------------------------------

function seg(out: number[], s0: number, t0: number, s1: number, t1: number): void {
  out.push(s0, t0, s1, t1);
}

function polyline(out: number[], pts: readonly number[]): void {
  for (let i = 0; i + 3 < pts.length; i += 2) seg(out, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
}

/** A rectangle with its corners cut: the frame's angular bezel. */
function bezel(out: number[], r: Rect, cut = CHAMFER): void {
  polyline(out, [
    r.s0 + cut, r.t0, r.s1 - cut, r.t0, r.s1, r.t0 + cut, r.s1, r.t1 - cut,
    r.s1 - cut, r.t1, r.s0 + cut, r.t1, r.s0, r.t1 - cut, r.s0, r.t0 + cut, r.s0 + cut, r.t0,
  ]);
}

function rect(out: number[], r: Rect): void {
  polyline(out, [r.s0, r.t0, r.s1, r.t0, r.s1, r.t1, r.s0, r.t1, r.s0, r.t0]);
}

function textLeft(out: number[], text: string, s: number, t: number, cap: number): void {
  textStrokes(text, s, t, cap, out);
}

function textRight(out: number[], text: string, sRight: number, t: number, cap: number): void {
  textStrokes(text, sRight - textWidth(text, cap), t, cap, out);
}

function textCentre(out: number[], text: string, sMid: number, t: number, cap: number): void {
  textStrokes(text, sMid - textWidth(text, cap) / 2, t, cap, out);
}

/** A small diamond: the beam's dot. */
function dot(out: number[], s: number, t: number, r: number): void {
  polyline(out, [s - r, t, s, t + r, s + r, t, s, t - r, s - r, t]);
}

function octagon(out: number[], s: number, t: number, r: number): void {
  const pts: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pts.push(s + r * Math.cos(a), t + r * Math.sin(a));
  }
  polyline(out, pts);
}

/**
 * One thruster's glyph in one view, mirroring the screen HUD's: a dot at its position
 * and an arrow along the push, or a ring (dot: toward the viewer, cross: away) when the
 * push is normal to the view. `p` is in the view's box, y down; the box's top-left is
 * (s0, t1) on the face.
 */
export function thrusterGlyph(out: number[], p: ViewPoint, box: Rect): void {
  const s = box.s0 + p.x;
  const t = box.t1 - p.y;
  const ds = p.dx, dt = -p.dy;
  const m = Math.hypot(ds, dt);
  if (m < EPS) {
    octagon(out, s, t, RING_R);
    if (p.n < 0) {
      const c = RING_R * 0.6;
      seg(out, s - c, t - c, s + c, t + c);
      seg(out, s - c, t + c, s + c, t - c);
    } else {
      dot(out, s, t, DOT_R * 0.8);
    }
    return;
  }
  dot(out, s, t, DOT_R);
  const ts = s + ds * TICK, tt = t + dt * TICK;
  seg(out, s, t, ts, tt);
  const bs = -ds / m, bt = -dt / m;
  const cos = Math.cos(BARB_RAD), sin = Math.sin(BARB_RAD);
  seg(out, ts + (bs * cos - bt * sin) * BARB, tt + (bs * sin + bt * cos) * BARB, ts, tt);
  seg(out, ts, tt, ts + (bs * cos + bt * sin) * BARB, tt + (bt * cos - bs * sin) * BARB);
}

/** Frame, centre-of-mass mark and nose chevron for a thruster view; the nose is up in TOP and right in SIDE. */
function viewFrame(out: number[], box: Rect, nose: 'up' | 'right'): void {
  rect(out, box);
  const cs = (box.s0 + box.s1) / 2, ct = (box.t0 + box.t1) / 2;
  seg(out, cs - DOT_R, ct, cs + DOT_R, ct);
  seg(out, cs, ct - DOT_R, cs, ct + DOT_R);
  const a = 0.012, b = 0.006;
  if (nose === 'up') polyline(out, [cs - a, box.t1 - a - b, cs, box.t1 - b, cs + a, box.t1 - a - b]);
  else polyline(out, [box.s1 - a - b, ct - a, box.s1 - b, ct, box.s1 - a - b, ct + a]);
}

/** Convert flat s0,t0,s1,t1 quads into the xyz pairs a stroke set takes. Returns the segment count. */
function toFace(quads: readonly number[], into: Float32Array): number {
  const n = Math.min(quads.length >> 2, into.length / 6);
  for (let i = 0; i < n; i++) {
    const a = facePoint(quads[i * 4]!, quads[i * 4 + 1]!);
    const b = facePoint(quads[i * 4 + 2]!, quads[i * 4 + 3]!);
    into[i * 6] = a[0]; into[i * 6 + 1] = a[1]; into[i * 6 + 2] = a[2];
    into[i * 6 + 3] = b[0]; into[i * 6 + 4] = b[1]; into[i * 6 + 5] = b[2];
  }
  return n;
}

// --- the instruments -------------------------------------------------------------------

/** The screen HUD's row format, so the two readouts show the same text. */
const NAV_NUM_WIDTH = 9;
function navRow(label: string, value: string, unit: string): string {
  return label + ' ' + value.padStart(NAV_NUM_WIDTH) + (unit ? ' ' + unit : '');
}
function navRangeRow(value: string): string {
  if (value === UNAVAILABLE) return navRow('RNG', value, '');
  const sp = value.lastIndexOf(' ');
  return navRow('RNG', value.slice(0, sp), value.slice(sp + 1));
}

export interface Dash {
  /** add to the cockpit group: it is laid out in the cockpit's frame and scaled with it */
  group: THREE.Group;
  /** the bezels, labels and frames: built once */
  fixed: VectorStrokes;
  /** the dim outline of every thruster, rebuilt when the ship's loadout changes */
  outlines: DynamicStrokes;
  /** rotation values by band */
  rot: Readonly<Record<RateBand, DynamicStrokes>>;
  nav: DynamicStrokes;
  prop: DynamicStrokes;
  /** lit thruster glyphs by brightness bucket */
  lit: readonly [DynamicStrokes, DynamicStrokes, DynamicStrokes];
  /** read the world, refresh whatever changed; allocation-free once the strings settle */
  update(world: World): void;
  dispose(): void;
}

class Scratch {
  quads: number[] = [];
  xyz: Float32Array;
  constructor(capacity: number) { this.xyz = new Float32Array(capacity * 6); }
  begin(): number[] { this.quads.length = 0; return this.quads; }
  flush(into: DynamicStrokes): void { into.set(this.xyz, toFace(this.quads, this.xyz)); }
}

/** Fixed strokes: the three bezels with their labels, and the two thruster frames with captions. */
export function fixedStrokes(): number[] {
  const out: number[] = [];
  // ROT
  const rot = PANELS.rot;
  bezel(out, rot);
  textLeft(out, 'ROT', rot.s0 + PAD, rot.t1 - PAD - SIDE_CAP, SIDE_CAP);
  textRight(out, 'DEG/S', rot.s1 - PAD, rot.t1 - PAD - SIDE_CAP, SIDE_CAP);
  ['PITCH', 'YAW', 'ROLL'].forEach((label, i) => {
    textLeft(out, label, rot.s0 + PAD, rot.t1 - PAD - SIDE_CAP - SIDE_PITCH * (i + 1), SIDE_CAP);
  });
  // PROP
  const prop = PANELS.prop;
  bezel(out, prop);
  textLeft(out, 'PROP', prop.s0 + PAD, prop.t1 - PAD - SIDE_CAP, SIDE_CAP);
  textLeft(out, 'MASS', prop.s0 + PAD, prop.t1 - PAD - SIDE_CAP - SIDE_PITCH * 2, SIDE_CAP);
  textLeft(out, 'DV', prop.s0 + PAD, prop.t1 - PAD - SIDE_CAP - SIDE_PITCH * 3, SIDE_CAP);
  rect(out, propBar());
  // NAV
  bezel(out, PANELS.nav);
  // thruster views
  viewFrame(out, THRUSTER_BOXES.top, 'up');
  viewFrame(out, THRUSTER_BOXES.side, 'right');
  textCentre(out, 'TOP', (THRUSTER_BOXES.top.s0 + THRUSTER_BOXES.top.s1) / 2, THRUSTER_BOXES.top.t1 + 0.01, CAPTION_CAP);
  textCentre(out, 'SIDE', (THRUSTER_BOXES.side.s0 + THRUSTER_BOXES.side.s1) / 2, THRUSTER_BOXES.side.t1 + 0.01, CAPTION_CAP);
  return out;
}

/** The propellant bar's outline: the second row of the PROP panel, left of the percentage. */
function propBar(): Rect {
  const p = PANELS.prop;
  const t = p.t1 - PAD - SIDE_CAP - SIDE_PITCH;
  return { s0: p.s0 + PAD, s1: p.s1 - PAD - textWidth('100%', SIDE_CAP) - 0.02, t0: t + 0.004, t1: t + SIDE_CAP - 0.004 };
}

export function createDash(): Dash {
  const group = new THREE.Group();
  const fixedQuads = fixedStrokes();
  const fixedXYZ = new Float32Array((fixedQuads.length >> 2) * 6);
  toFace(fixedQuads, fixedXYZ);
  const fixedSet = createVectorStrokes(fixedXYZ, INSTRUMENT_COLOR);
  fixedSet.setFade(BEZEL_FADE);
  for (const t of fixedSet.tiers) t.frustumCulled = false;
  group.add(fixedSet.group);

  const outlines = createDynamicStrokes(600, INSTRUMENT_COLOR);
  outlines.setFade(OUTLINE_FADE);
  const rot: Record<RateBand, DynamicStrokes> = {
    dim: createDynamicStrokes(200, INSTRUMENT_COLOR),
    live: createDynamicStrokes(200, INSTRUMENT_COLOR),
    alert: createDynamicStrokes(200, ALERT_COLOR),
  };
  rot.dim.setFade(0.45);
  const nav = createDynamicStrokes(800, INSTRUMENT_COLOR);
  const prop = createDynamicStrokes(400, INSTRUMENT_COLOR);
  const lit: [DynamicStrokes, DynamicStrokes, DynamicStrokes] = [
    createDynamicStrokes(400, INSTRUMENT_COLOR),
    createDynamicStrokes(400, INSTRUMENT_COLOR),
    createDynamicStrokes(400, INSTRUMENT_COLOR),
  ];
  lit.forEach((set, i) => set.setFade(LIT_FADES[i]!));
  const dynamic = [outlines, rot.dim, rot.live, rot.alert, nav, prop, ...lit];
  for (const d of dynamic) group.add(d.group);

  const scratch = new Scratch(800);
  // last-drawn state, so an unchanged readout costs nothing
  const lastRot = ['', '', ''];
  const lastBand: RateBand[] = ['dim', 'dim', 'dim'];
  const navFields: VelocityFields = { target: '', speed: '', range: '', closing: '' };
  let lastNav = '';
  const propF: PropellantFields = { propellant: '', percent: '', mass: '', deltaV: '', fraction: 0 };
  let lastProp = '';
  let builtFor: PreparedThruster[] | null = null;
  /** per thruster, per view: its glyph as quads, ready to copy into a lit bucket */
  let glyphs: number[][] = [];
  let lastThrottles = new Float32Array(0);

  function build(prepared: PreparedThruster[]): void {
    const layout: ThrusterLayout = layoutThrusters(prepared, BOX, BOX_INSET);
    glyphs = [];
    const all = scratch.begin();
    for (let i = 0; i < prepared.length; i++) {
      const g: number[] = [];
      thrusterGlyph(g, layout.top[i]!, THRUSTER_BOXES.top);
      thrusterGlyph(g, layout.side[i]!, THRUSTER_BOXES.side);
      glyphs.push(g);
      for (const v of g) all.push(v);
    }
    scratch.flush(outlines);
    lastThrottles = new Float32Array(prepared.length).fill(-1);
    builtFor = prepared;
  }

  function drawRotation(ship: Ship): void {
    const w = ship.body.angularVelocity;
    const rates = [w.x, w.y, w.z];
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const text = formatRate(rates[i]!);
      const band = rateBand(rates[i]!);
      if (text !== lastRot[i] || band !== lastBand[i]) { lastRot[i] = text; lastBand[i] = band; changed = true; }
    }
    if (!changed) return;
    const r = PANELS.rot;
    for (const band of ['dim', 'live', 'alert'] as const) {
      const q = scratch.begin();
      for (let i = 0; i < 3; i++) {
        if (lastBand[i] !== band) continue;
        textRight(q, lastRot[i]!, r.s1 - PAD, r.t1 - PAD - SIDE_CAP - SIDE_PITCH * (i + 1), SIDE_CAP);
      }
      scratch.flush(rot[band]);
    }
  }

  function drawNav(world: World, ship: Ship): void {
    velocityFields(world, ship, navFields);
    const key = navFields.target + '|' + navFields.speed + '|' + navFields.range + '|' + navFields.closing;
    if (key === lastNav) return;
    lastNav = key;
    const p = PANELS.nav;
    const q = scratch.begin();
    const rows = [
      'REL ' + navFields.target,
      navRow('VEL', navFields.speed, navFields.speed === UNAVAILABLE ? '' : 'M/S'),
      navRangeRow(navFields.range),
      navRow('CLS', navFields.closing, navFields.closing === UNAVAILABLE ? '' : 'M/S'),
    ];
    rows.forEach((row, i) => textLeft(q, row, p.s0 + PAD, p.t1 - PAD - NAV_CAP - NAV_PITCH * i, NAV_CAP));
    scratch.flush(nav);
  }

  function drawProp(ship: Ship): void {
    propellantFields(ship, propF);
    const key = propF.propellant + '|' + propF.percent + '|' + propF.mass + '|' + propF.deltaV;
    if (key === lastProp) return;
    lastProp = key;
    const p = PANELS.prop;
    const q = scratch.begin();
    const top = p.t1 - PAD - SIDE_CAP;
    textRight(q, propF.propellant + ' KG', p.s1 - PAD, top, SIDE_CAP);
    textRight(q, propF.percent + '%', p.s1 - PAD, top - SIDE_PITCH, SIDE_CAP);
    textRight(q, propF.mass + ' KG', p.s1 - PAD, top - SIDE_PITCH * 2, SIDE_CAP);
    textRight(q, propF.deltaV + ' M/S', p.s1 - PAD, top - SIDE_PITCH * 3, SIDE_CAP);
    // the bar: the filled part as a band of three lines
    const bar = propBar();
    const fill = bar.s0 + (bar.s1 - bar.s0) * propF.fraction;
    if (fill > bar.s0 + 1e-6) {
      const tm = (bar.t0 + bar.t1) / 2, h = (bar.t1 - bar.t0) / 2;
      for (const dt of [-h * 0.55, 0, h * 0.55]) seg(q, bar.s0, tm + dt, fill, tm + dt);
    }
    scratch.flush(prop);
  }

  function drawThrusters(ship: Ship): void {
    if (ship.prepared !== builtFor) build(ship.prepared);
    const { throttles } = ship;
    let changed = false;
    for (let i = 0; i < glyphs.length; i++) {
      const raw = throttles[i] ?? 0;
      const k = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      if (k !== lastThrottles[i]) { lastThrottles[i] = k; changed = true; }
    }
    if (!changed) return;
    for (let bucket = 0; bucket < 3; bucket++) {
      const q = scratch.begin();
      for (let i = 0; i < glyphs.length; i++) {
        const k = lastThrottles[i]!;
        if (k <= 0) continue;
        const b = k <= 1 / 3 ? 0 : k <= 2 / 3 ? 1 : 2;
        if (b !== bucket) continue;
        for (const v of glyphs[i]!) q.push(v);
      }
      scratch.flush(lit[bucket]!);
    }
  }

  return {
    group,
    fixed: fixedSet,
    outlines,
    rot,
    nav,
    prop,
    lit,
    update(world) {
      const ship = world.ships[0];
      if (!ship) return;
      drawRotation(ship);
      drawNav(world, ship);
      drawProp(ship);
      drawThrusters(ship);
    },
    dispose() {
      fixedSet.dispose();
      for (const d of dynamic) d.dispose();
    },
  };
}
