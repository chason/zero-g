import { describe, it, expect } from 'vitest';
import { prepare } from '../src/sim/ship';
import type { ShipSpec, ThrusterSpec } from '../src/sim/ship';
import skiff from '../src/data/skiff.json';
import { layoutThrusters, BOX, INSET, TICK } from '../src/hud/instruments/thrusters';
import type { ViewPoint } from '../src/hud/instruments/thrusters';

const spec = skiff as ShipSpec;
const prepared = prepare(spec);
const layout = layoutThrusters(prepared);
const CENTRE = BOX / 2;

function index(id: string): number {
  const i = prepared.findIndex((t) => t.spec.id === id);
  expect(i, `thruster ${id} exists in skiff.json`).toBeGreaterThanOrEqual(0);
  return i;
}

/** screen-space angle of the projected push, degrees, y down: 0 = right, 90 = down, -90 = up */
function angle(p: ViewPoint): number {
  return (Math.atan2(p.dy, p.dx) * 180) / Math.PI;
}

function inPlane(p: ViewPoint): number {
  return Math.hypot(p.dx, p.dy);
}

/** The skiff plus one extra thruster, so the real layout is exercised with a hand-placed point. */
function withExtra(extra: Partial<ThrusterSpec>) {
  const thruster: ThrusterSpec = {
    id: 'extra', position: [0, 0, 0], direction: [0, 0, -1], thrust: 1, isp: 1, ...extra,
  };
  const p = prepare({ ...spec, thrusters: [...spec.thrusters, thruster] });
  const l = layoutThrusters(p);
  const i = p.length - 1;
  return { top: l.top[i]!, side: l.side[i]! };
}

describe('thruster schematic layout', () => {
  it('lays out one point per prepared thruster in each view, in order', () => {
    expect(layout.top).toHaveLength(prepared.length);
    expect(layout.side).toHaveLength(prepared.length);
    expect(layout.scale).toBeGreaterThan(0);
  });

  it('fits every position inside the box, clear of the inset', () => {
    for (const view of [layout.top, layout.side]) {
      for (const p of view) {
        expect(p.x).toBeGreaterThanOrEqual(INSET - 1e-9);
        expect(p.x).toBeLessThanOrEqual(BOX - INSET + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(INSET - 1e-9);
        expect(p.y).toBeLessThanOrEqual(BOX - INSET + 1e-9);
      }
    }
  });

  it('keeps every arrow tip inside the box as well', () => {
    for (const view of [layout.top, layout.side]) {
      for (const p of view) {
        const tx = p.x + p.dx * TICK;
        const ty = p.y + p.dy * TICK;
        expect(tx).toBeGreaterThanOrEqual(0);
        expect(tx).toBeLessThanOrEqual(BOX);
        expect(ty).toBeGreaterThanOrEqual(0);
        expect(ty).toBeLessThanOrEqual(BOX);
      }
    }
  });

  it('uses the whole box: the farthest thruster lands on the inset line', () => {
    // main sits at z = +2.4, the skiff's largest extent on any axis. Aft is down the
    // screen in the top view and left in the side view.
    const i = index('main');
    expect(layout.top[i]!.y).toBeCloseTo(BOX - INSET, 6);
    expect(layout.side[i]!.x).toBeCloseTo(INSET, 6);
    // and both views share one scale, so the hull is the same length in each
    const r = index('retro_p');
    expect(layout.top[i]!.y - layout.top[r]!.y).toBeCloseTo(layout.side[r]!.x - layout.side[i]!.x, 6);
  });

  it('maps a thruster at the origin to the centre of both views', () => {
    const { top, side } = withExtra({ position: [0, 0, 0] });
    expect(top.x).toBeCloseTo(CENTRE, 6);
    expect(top.y).toBeCloseTo(CENTRE, 6);
    expect(side.x).toBeCloseTo(CENTRE, 6);
    expect(side.y).toBeCloseTo(CENTRE, 6);
  });

  it('maps a port/starboard pair as mirror images across the top view', () => {
    const p = layout.top[index('retro_p')]!;
    const s = layout.top[index('retro_s')]!;
    expect(p.x - CENTRE).toBeCloseTo(CENTRE - s.x, 6);
    expect(p.x).toBeGreaterThan(CENTRE); // starboard is screen right
    expect(p.y).toBeCloseTo(s.y, 6);
    // the pair is indistinguishable by position from the side, as it should be
    const ps = layout.side[index('retro_p')]!;
    const ss = layout.side[index('retro_s')]!;
    expect(ps.x).toBeCloseTo(ss.x, 6);
    expect(ps.y).toBeCloseTo(ss.y, 6);
  });

  it('maps a dorsal/ventral pair as mirror images across the side view', () => {
    const d = layout.side[index('fwd_dorsal')]!;
    const v = layout.side[index('fwd_ventral')]!;
    expect(d.y - CENTRE).toBeCloseTo(CENTRE - v.y, 6);
    expect(d.y).toBeLessThan(CENTRE); // dorsal is screen up
    expect(d.x).toBeCloseTo(v.x, 6);
  });

  it('maps a fore/aft pair as mirror images along the hull in both views', () => {
    const fwd = index('fwd_port');
    const aft = index('aft_port');
    expect(layout.top[fwd]!.y - CENTRE).toBeCloseTo(CENTRE - layout.top[aft]!.y, 6);
    expect(layout.top[fwd]!.y).toBeLessThan(CENTRE); // nose is screen up
    expect(layout.top[fwd]!.x).toBeCloseTo(layout.top[aft]!.x, 6);
    expect(layout.side[fwd]!.x - CENTRE).toBeCloseTo(CENTRE - layout.side[aft]!.x, 6);
    expect(layout.side[fwd]!.x).toBeGreaterThan(CENTRE); // nose is screen right
    expect(layout.side[fwd]!.y).toBeCloseTo(layout.side[aft]!.y, 6);
  });

  it('maps the diagonal roll pair as point reflections through the centre', () => {
    const a = index('roll_port');
    const b = index('roll_stbd');
    for (const view of [layout.top, layout.side]) {
      expect(view[a]!.x - CENTRE).toBeCloseTo(CENTRE - view[b]!.x, 6);
      expect(view[a]!.y - CENTRE).toBeCloseTo(CENTRE - view[b]!.y, 6);
    }
  });

  it('points the main engine toward the nose in both views', () => {
    const i = index('main'); // pushes -z
    expect(inPlane(layout.top[i]!)).toBeCloseTo(1, 9);
    expect(angle(layout.top[i]!)).toBeCloseTo(-90, 9); // up the screen
    expect(layout.top[i]!.n).toBeCloseTo(0, 9);
    expect(inPlane(layout.side[i]!)).toBeCloseTo(1, 9);
    expect(angle(layout.side[i]!)).toBeCloseTo(0, 9); // to the right
    expect(layout.side[i]!.n).toBeCloseTo(0, 9);
  });

  it('points a retro thruster aft in both views', () => {
    const i = index('retro_p'); // pushes +z
    expect(angle(layout.top[i]!)).toBeCloseTo(90, 9); // down the screen
    expect(Math.abs(angle(layout.side[i]!))).toBeCloseTo(180, 9); // to the left
  });

  it('shows a lateral push as an arrow from above and as a normal from the side', () => {
    const i = index('fwd_port'); // pushes +x, toward starboard
    expect(angle(layout.top[i]!)).toBeCloseTo(0, 9); // to the right
    expect(layout.top[i]!.n).toBeCloseTo(0, 9);
    // from the starboard side, +x comes straight at the viewer
    expect(inPlane(layout.side[i]!)).toBeCloseTo(0, 9);
    expect(layout.side[i]!.n).toBeCloseTo(1, 9);

    const j = index('fwd_stbd'); // pushes -x
    expect(Math.abs(angle(layout.top[j]!))).toBeCloseTo(180, 9);
    expect(layout.side[j]!.n).toBeCloseTo(-1, 9);
  });

  it('shows a vertical push as an arrow from the side and as a normal from above', () => {
    const i = index('fwd_dorsal'); // pushes -y, toward ventral
    expect(angle(layout.side[i]!)).toBeCloseTo(90, 9); // down the screen
    expect(layout.side[i]!.n).toBeCloseTo(0, 9);
    // from above, -y goes away from the viewer
    expect(inPlane(layout.top[i]!)).toBeCloseTo(0, 9);
    expect(layout.top[i]!.n).toBeCloseTo(-1, 9);

    const j = index('fwd_ventral'); // pushes +y
    expect(angle(layout.side[j]!)).toBeCloseTo(-90, 9);
    expect(layout.top[j]!.n).toBeCloseTo(1, 9);
  });

  it('tells the two roll senses apart by the normal sign in the top view', () => {
    // Both roll couples put a thruster at the same top-view position on each side; the
    // sign of the push along the view normal is what distinguishes them.
    const port = layout.top[index('roll_port')]!;
    const portLower = layout.top[index('roll_port_lower')]!;
    expect(port.x).toBeCloseTo(portLower.x, 6);
    expect(port.y).toBeCloseTo(portLower.y, 6);
    expect(Math.sign(port.n)).toBe(-Math.sign(portLower.n));
  });

  it('projects a canted push with a proportionally shorter arrow', () => {
    const c = Math.SQRT1_2;
    const { top, side } = withExtra({ direction: [c, 0, -c] });
    // fully in the top plane: unit arrow, pointing up and to the right
    expect(inPlane(top)).toBeCloseTo(1, 9);
    expect(angle(top)).toBeCloseTo(-45, 9);
    // from the side only the -z half shows; the +x half comes toward the viewer
    expect(inPlane(side)).toBeCloseTo(c, 9);
    expect(angle(side)).toBeCloseTo(0, 9);
    expect(side.n).toBeCloseTo(c, 9);
  });

  it('normalises a non-unit direction, like prepare() does', () => {
    const { top } = withExtra({ direction: [0, 0, -3] });
    expect(inPlane(top)).toBeCloseTo(1, 9);
    expect(angle(top)).toBeCloseTo(-90, 9);
  });

  it('copes with no thrusters and with every thruster at the origin', () => {
    expect(layoutThrusters([])).toEqual({ scale: 0, top: [], side: [] });
    const onlyOrigin = prepare({
      ...spec,
      thrusters: [{ id: 'a', position: [0, 0, 0], direction: [0, 0, -1], thrust: 1, isp: 1 }],
    });
    const l = layoutThrusters(onlyOrigin);
    expect(l.scale).toBe(0);
    expect(l.top[0]!.x).toBeCloseTo(CENTRE, 9);
    expect(l.top[0]!.y).toBeCloseTo(CENTRE, 9);
    expect(l.side[0]!.x).toBeCloseTo(CENTRE, 9);
    expect(l.side[0]!.y).toBeCloseTo(CENTRE, 9);
  });

  it('honours a custom box and inset', () => {
    const l = layoutThrusters(prepared, 200, 25);
    for (const view of [l.top, l.side]) {
      for (const p of view) {
        expect(p.x).toBeGreaterThanOrEqual(25 - 1e-9);
        expect(p.x).toBeLessThanOrEqual(175 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(25 - 1e-9);
        expect(p.y).toBeLessThanOrEqual(175 + 1e-9);
      }
    }
    expect(l.top[index('main')]!.y).toBeCloseTo(175, 6);
  });
});
