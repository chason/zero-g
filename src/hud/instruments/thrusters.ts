import type { Instrument, HudContext } from '../instrument';
import type { PreparedThruster } from '../../sim/ship';

/**
 * Per-thruster indicator lights, laid out from ship.prepared. The cockpit's substitute
 * for seeing plumes: a first-person view hides the hull, and with it the only feedback a
 * no-assist pilot had for "which thrusters did that tap fire?".
 *
 * Two small schematic views of the thruster layout, both derived from ship.prepared and
 * never hardcoded, so a thruster added to the data file shows up with no HUD change:
 *
 *   TOP   x across, z down the screen: nose up, starboard right, seen from above (+y).
 *   SIDE  z across, y up the screen: nose right, dorsal up, seen from starboard (+x).
 *
 * Each thruster is a dot at its position with a short arrow along the direction it
 * PUSHES the ship (not the plume, which goes the other way). A push normal to the view
 * plane has no arrow to draw, so it uses the drafting convention instead: a ring with a
 * centre dot pushes toward the viewer, a ring with a cross pushes away. That is what keeps
 * the roll couples, whose thrusters share a position in any single 2-D view, tellable
 * apart in the top view.
 *
 * Rendering is two SVG layers over the same geometry: a static dim outline of every
 * thruster, and a lit copy per thruster whose opacity is its throttle (0 = only the
 * outline shows, 1 = full). Geometry is built lazily on the first draw, because mount()
 * has no ship yet, and rebuilt only when ship.prepared is a different array. Each frame
 * then does nothing but compare throttles and write the opacities that changed.
 *
 * Issue #32.
 */

/** px: each view is a BOX x BOX square */
export const BOX = 72;
/** px kept clear inside each box so no arrow or glyph crosses its edge */
export const INSET = 10;
/** px: arrow length for a push lying fully in the view plane */
export const TICK = 7;

/** px between the two views */
const GAP = 12;
/** px under the boxes for the captions */
const LABEL_H = 14;
const DOT_R = 1.6;
const RING_R = 2.8;
const BARB = 2.6;
const BARB_RAD = (35 * Math.PI) / 180;
const EPS = 1e-6;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ViewPoint {
  /** px from the top-left corner of the view's box */
  x: number;
  y: number;
  /**
   * Push direction projected into the view, in screen axes (y down). Length 1 for a push
   * lying in the view plane, 0 for one normal to it, in between for a canted thruster.
   */
  dx: number;
  dy: number;
  /** push component along the view normal: > 0 toward the viewer, < 0 away from them */
  n: number;
}

export interface ThrusterLayout {
  /** px per metre, shared by both views so the hull reads the same length in each */
  scale: number;
  /** top-down: x across (starboard right), z down the screen (nose up); parallel to `prepared` */
  top: ViewPoint[];
  /** side, from starboard: z across (nose right), y up the screen (dorsal up); parallel to `prepared` */
  side: ViewPoint[];
}

/**
 * Project body-frame thruster positions onto the two views and scale them to fit a box.
 *
 * One uniform scale for both views and all three axes, chosen so the farthest thruster
 * on any axis lands exactly `inset` px inside the box edge. Uniform because a schematic
 * that stretched x and z independently would misrepresent lever arms, and the whole
 * point is reading which couple fired. Pure: no DOM, no state.
 *
 * Spec: test/hud-thrusters.test.ts.
 */
export function layoutThrusters(
  prepared: readonly PreparedThruster[],
  box = BOX,
  inset = INSET,
): ThrusterLayout {
  let extent = 0;
  for (const t of prepared) {
    const [x, y, z] = t.spec.position;
    extent = Math.max(extent, Math.abs(x), Math.abs(y), Math.abs(z));
  }
  const half = box / 2;
  const scale = extent > 0 ? (half - inset) / extent : 0;

  const top: ViewPoint[] = [];
  const side: ViewPoint[] = [];
  for (const t of prepared) {
    const [x, y, z] = t.spec.position;
    // Same defensive normalisation as prepare(): a hand-edited direction may not be unit.
    let [dx, dy, dz] = t.spec.direction;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0) {
      dx /= len;
      dy /= len;
      dz /= len;
    }
    // Seen from +y: screen right = +x, screen down = +z (aft), toward the viewer = +y.
    top.push({ x: half + x * scale, y: half + z * scale, dx, dy: dz, n: dy });
    // Seen from +x: screen right = -z (nose), screen down = -y (ventral), toward the viewer = +x.
    side.push({ x: half - z * scale, y: half - y * scale, dx: -dz, dy: -dy, n: dx });
  }
  return { scale, top, side };
}

/** Short fixed-point string for SVG attributes. Build time only. */
function f(v: number): string {
  return v.toFixed(2);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]!);
  return e;
}

/** Box outline, centre-of-mass mark and nose chevron for one view. Ship-independent. */
function viewFrame(ox: number, nose: string): SVGGElement {
  const g = svgEl('g', { class: 'thr-frame' });
  const c = BOX / 2;
  g.appendChild(svgEl('rect', { x: f(ox + 0.5), y: '0.5', width: f(BOX - 1), height: f(BOX - 1), rx: '3' }));
  g.appendChild(svgEl('path', { d: `M${f(ox + c - 2)} ${f(c)}h4M${f(ox + c)} ${f(c - 2)}v4` }));
  g.appendChild(svgEl('path', { d: nose }));
  return g;
}

function viewLabel(ox: number, label: string): SVGTextElement {
  const text = svgEl('text', {
    class: 'thr-label',
    x: f(ox + BOX / 2),
    y: f(BOX + LABEL_H - 3),
    'text-anchor': 'middle',
  });
  text.textContent = label;
  return text;
}

/** Append one thruster's glyph in one view to `into`: its position dot, then arrow or ring. */
function appendGlyph(into: SVGGElement, p: ViewPoint, ox: number): void {
  const x = ox + p.x;
  const y = p.y;
  const m = Math.hypot(p.dx, p.dy);

  if (m < EPS) {
    // Push normal to the view: a ring, with a dot for "toward the viewer" and a cross for "away".
    const r = RING_R;
    let d = `M${f(x - r)} ${f(y)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0`;
    if (p.n < 0) {
      const c = r * 0.6;
      d += `M${f(x - c)} ${f(y - c)}L${f(x + c)} ${f(y + c)}M${f(x - c)} ${f(y + c)}L${f(x + c)} ${f(y - c)}`;
    } else {
      into.appendChild(svgEl('circle', { class: 'thr-dot', cx: f(x), cy: f(y), r: f(DOT_R * 0.8) }));
    }
    into.appendChild(svgEl('path', { d }));
    return;
  }

  // In-plane push: dot at the position, arrow along the push. A canted push gets a
  // proportionally shorter arrow, which is simply its honest projection.
  const tx = x + p.dx * TICK;
  const ty = y + p.dy * TICK;
  // Barbs run back from the tip, rotated either side of the shaft.
  const bx = -p.dx / m;
  const by = -p.dy / m;
  const cos = Math.cos(BARB_RAD);
  const sin = Math.sin(BARB_RAD);
  const lx = tx + (bx * cos - by * sin) * BARB;
  const ly = ty + (bx * sin + by * cos) * BARB;
  const rx = tx + (bx * cos + by * sin) * BARB;
  const ry = ty + (by * cos - bx * sin) * BARB;
  into.appendChild(svgEl('circle', { class: 'thr-dot', cx: f(x), cy: f(y), r: f(DOT_R) }));
  into.appendChild(svgEl('path', {
    d: `M${f(x)} ${f(y)}L${f(tx)} ${f(ty)}M${f(lx)} ${f(ly)}L${f(tx)} ${f(ty)}L${f(rx)} ${f(ry)}`,
  }));
}

export function createThrusters(): Instrument {
  let el: HTMLElement | null = null;
  /** static dim outlines, one <g> per thruster */
  let off: SVGGElement | null = null;
  /** lit copies, one <g> per thruster; its opacity is the throttle */
  let on: SVGGElement | null = null;
  /** the array the current geometry was built from; identity, not contents */
  let builtFor: PreparedThruster[] | null = null;
  let lit: SVGGElement[] = [];
  /** last opacity written per thruster, so unchanged throttles cost no DOM write */
  let last = new Float32Array(0);

  function build(prepared: PreparedThruster[]): void {
    if (!off || !on) return;
    while (off.firstChild) off.removeChild(off.firstChild);
    while (on.firstChild) on.removeChild(on.firstChild);

    const layout = layoutThrusters(prepared);
    lit = [];
    last = new Float32Array(prepared.length);
    for (let i = 0; i < prepared.length; i++) {
      const dim = svgEl('g', {});
      const glow = svgEl('g', {});
      glow.style.opacity = '0';
      appendGlyph(dim, layout.top[i]!, 0);
      appendGlyph(dim, layout.side[i]!, BOX + GAP);
      appendGlyph(glow, layout.top[i]!, 0);
      appendGlyph(glow, layout.side[i]!, BOX + GAP);
      off.appendChild(dim);
      on.appendChild(glow);
      lit.push(glow);
    }
    builtFor = prepared;
  }

  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-thrusters';

      const width = BOX * 2 + GAP;
      const height = BOX + LABEL_H;
      const svg = svgEl('svg', {
        width: String(width),
        height: String(height),
        viewBox: `0 0 ${width} ${height}`,
      });
      const c = BOX / 2;
      const sx = BOX + GAP;
      // Everything that does not depend on the ship is built here, once.
      svg.appendChild(viewFrame(0, `M${f(c - 3)} 8L${f(c)} 4L${f(c + 3)} 8`));
      svg.appendChild(viewFrame(sx, `M${f(sx + BOX - 8)} ${f(c - 3)}L${f(sx + BOX - 4)} ${f(c)}L${f(sx + BOX - 8)} ${f(c + 3)}`));
      svg.appendChild(viewLabel(0, 'TOP'));
      svg.appendChild(viewLabel(sx, 'SIDE'));
      off = svgEl('g', { class: 'thr-off' });
      on = svgEl('g', { class: 'thr-on' });
      svg.appendChild(off);
      svg.appendChild(on);

      el.appendChild(svg);
      root.appendChild(el);
    },
    draw(ctx: HudContext) {
      if (!el) return;
      const { prepared, throttles } = ctx.ship;
      if (prepared !== builtFor) build(prepared);
      for (let i = 0; i < lit.length; i++) {
        const t = throttles[i] ?? 0;
        if (t === last[i]) continue;
        last[i] = t;
        lit[i]!.style.opacity = t.toFixed(3);
      }
    },
  };
}
