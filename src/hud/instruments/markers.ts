import type { Instrument, HudContext, Projected } from '../instrument';
import { projectDirection } from '../instrument';
import { Vector3 } from '../../core/math';
import type { Target } from '../../sim/world';

/**
 * Prograde and retrograde markers projected through the camera.
 *
 * Prograde is the direction of the ship's velocity RELATIVE TO THE SELECTED TARGET
 * (world velocity when nothing is selected); retrograde is its opposite. Pointing the
 * nose at retrograde and burning until both markers vanish nulls the drift exactly,
 * which is the manoeuvre a no-assist pilot performs more than any other.
 *
 * Behind-camera handling — the choice, and why. projectDirection() sets `behind` when
 * the direction points into the hemisphere behind the camera; the x/y it returns are
 * then the point-reflection of the true position through the screen centre. Drawing
 * them as-is puts a "ghost" glyph that points the WRONG way: a pilot who turns toward
 * it turns away from the marker and never finds it. Hiding the marker is not good
 * enough either, because retrograde is behind the camera precisely when the pilot is
 * flying prograde-first, which is exactly when they need to know which way to turn for
 * a braking burn. So a behind (or merely off-screen) marker is CLAMPED TO THE VIEWPORT
 * EDGE in the direction that is the shortest turn toward it: the offset from screen
 * centre, negated when behind (screenDirection). It gets the .is-edge class (dimmed)
 * so a clamped marker is never mistaken for one genuinely at the edge of view.
 *
 * Per-frame work is allocation-free on this side: one scratch Vector3 and one scratch
 * Projected, DOM writes only when a rounded position or state actually changes.
 * (projectDirection itself clones internally; that lives in the shared helper.)
 *
 * Issue #20.
 */

/** Below this relative speed (m/s) the direction is numerical noise; both markers hide. */
export const MIN_MARKER_SPEED = 0.05;

/** Inset in px from the viewport edge at which clamped glyphs sit, so they stay visible. */
export const EDGE_MARGIN = 18;

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Offset of a projected point from the screen centre, as the direction the pilot must
 * turn to bring it on screen. For a point behind the camera the projected x/y are
 * reflected through the centre, so the offset is negated to recover the true direction.
 */
export function screenDirection(p: Projected, width: number, height: number, out: ScreenPoint): ScreenPoint {
  let dx = p.x - width * 0.5;
  let dy = p.y - height * 0.5;
  if (p.behind) {
    dx = -dx;
    dy = -dy;
  }
  out.x = dx;
  out.y = dy;
  return out;
}

/**
 * The point where a ray from the screen centre along (dx, dy) leaves the viewport,
 * pulled in by `margin` px on every side. The ray is intersected with the inset
 * rectangle per axis and the nearer hit wins, so a diagonal lands on whichever edge it
 * crosses first. A zero (or non-finite) direction means the thing is exactly behind or
 * exactly ahead: there is no shortest turn, so it is parked at the bottom-centre edge
 * rather than allowed to jump around.
 */
export function clampToEdge(
  width: number, height: number, dx: number, dy: number, margin: number, out: ScreenPoint,
): ScreenPoint {
  const cx = width * 0.5;
  const cy = height * 0.5;
  const hx = Math.max(0, cx - margin);
  const hy = Math.max(0, cy - margin);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const EPS = 1e-9;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (ax < EPS && ay < EPS)) {
    out.x = cx;
    out.y = cy + hy;
    return out;
  }
  const tx = ax > EPS ? hx / ax : Infinity;
  const ty = ay > EPS ? hy / ay : Infinity;
  const t = Math.min(tx, ty);
  out.x = cx + dx * t;
  out.y = cy + dy * t;
  return out;
}

/**
 * True when a projected point is in front of the camera and inside the viewport inset
 * by `margin`. Using the same inset as clampToEdge keeps a glyph's position continuous
 * as it crosses from "drawn where it is" to "clamped to the edge".
 */
export function isOnScreen(p: Projected, width: number, height: number, margin = 0): boolean {
  return (
    !p.behind &&
    Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= margin && p.x <= width - margin &&
    p.y >= margin && p.y <= height - margin
  );
}

/** Ship velocity relative to the target, or the plain world velocity when there is none. */
export function relativeVelocity(shipVelocity: Vector3, target: Target | undefined, out: Vector3): Vector3 {
  out.copy(shipVelocity);
  if (target) out.sub(target.velocity);
  return out;
}

interface Glyph {
  el: HTMLElement;
  /** last written rounded position, so unchanged frames write nothing */
  x: number;
  y: number;
  edge: boolean;
  shown: boolean;
}

// Module-level scratch: the draw path allocates nothing of its own.
const relVel = new Vector3();
const proj: Projected = { x: 0, y: 0, behind: false };
const dir: ScreenPoint = { x: 0, y: 0 };
const edge: ScreenPoint = { x: 0, y: 0 };

function makeGlyph(root: HTMLElement, cls: string, text: string): Glyph {
  const el = document.createElement('div');
  el.className = `marker ${cls}`;
  el.textContent = text;
  el.style.display = 'none';
  root.appendChild(el);
  return { el, x: NaN, y: NaN, edge: false, shown: false };
}

function show(g: Glyph, shown: boolean): void {
  if (g.shown === shown) return;
  g.shown = shown;
  g.el.style.display = shown ? '' : 'none';
}

/** Place a glyph from the current contents of `proj`: on screen where it is, else at the edge. */
function place(g: Glyph, ctx: HudContext): void {
  let x: number;
  let y: number;
  let atEdge: boolean;
  if (isOnScreen(proj, ctx.width, ctx.height, EDGE_MARGIN)) {
    x = proj.x;
    y = proj.y;
    atEdge = false;
  } else {
    screenDirection(proj, ctx.width, ctx.height, dir);
    clampToEdge(ctx.width, ctx.height, dir.x, dir.y, EDGE_MARGIN, edge);
    x = edge.x;
    y = edge.y;
    atEdge = true;
  }
  x = Math.round(x);
  y = Math.round(y);
  if (x !== g.x || y !== g.y) {
    g.x = x;
    g.y = y;
    // translate() moves the glyph on the compositor; left/top would re-run layout.
    g.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }
  if (atEdge !== g.edge) {
    g.edge = atEdge;
    g.el.classList.toggle('is-edge', atEdge);
  }
  show(g, true);
}

export function createMarkers(): Instrument {
  let pro: Glyph | null = null;
  let retro: Glyph | null = null;
  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-markers';
      root.appendChild(el);
      pro = makeGlyph(el, 'marker-prograde', '⊙'); // ⊙
      retro = makeGlyph(el, 'marker-retrograde', '⊗'); // ⊗
    },
    draw(ctx: HudContext) {
      if (!pro || !retro) return;
      const target = ctx.world.targets[ctx.world.selected];
      relativeVelocity(ctx.ship.body.velocity, target, relVel);
      if (relVel.lengthSq() < MIN_MARKER_SPEED * MIN_MARKER_SPEED) {
        show(pro, false);
        show(retro, false);
        return;
      }
      projectDirection(relVel, ctx, proj);
      place(pro, ctx);
      relVel.negate(); // scratch only; the ship's velocity was copied, never touched
      projectDirection(relVel, ctx, proj);
      place(retro, ctx);
    },
  };
}
