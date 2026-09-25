import type { Instrument, HudContext, Projected } from '../instrument';
import { projectPoint } from '../instrument';
import { Vector3, clamp } from '../../core/math';
// Pure screen geometry shared with the markers instrument — functions only, no DOM.
import { screenDirection, clampToEdge, isOnScreen, EDGE_MARGIN, type ScreenPoint } from './markers';

/**
 * Target bracket on screen, edge arrow off screen.
 *
 * Brackets `world.targets[world.selected]` (−1 = none, draws nothing) with four corner
 * ticks around its projected position and its name beside it. The bracket scales with
 * the target's apparent size (radius / range, small-angle) so it grows on approach,
 * clamped to BRACKET_MIN..BRACKET_MAX px so it neither vanishes at 400 m nor swallows
 * the screen at the dock.
 *
 * Off screen or behind the camera the bracket is replaced by an arrow clamped to the
 * viewport edge, pointing the shortest way round: the projected point's offset from
 * screen centre, negated when behind (the raw projection of a behind point is its
 * reflection through the centre, so used as-is it would point the wrong way), then
 * intersected with the inset viewport rectangle. The name rides just inside the arrow,
 * unrotated, so the pilot knows which target the arrow means.
 *
 * Target CYCLING is not here: Tab -> world.selected is owned by src/input and main.ts.
 * This instrument only reads world.selected.
 *
 * Issue #21.
 */

export const BRACKET_MIN = 24;
export const BRACKET_MAX = 160;
/** Bracket sits a little outside the hull outline rather than on it. */
export const BRACKET_SLACK = 1.4;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Bracket size in px for a target of `radius` m at `range` m through a camera with
 * `vfovDeg` vertical field of view on a viewport `height` px tall. Apparent diameter
 * under the small-angle approximation, times BRACKET_SLACK, clamped to
 * BRACKET_MIN..BRACKET_MAX. Zero or negative range (inside the target) is the max.
 */
export function bracketSize(radius: number, range: number, height: number, vfovDeg: number): number {
  if (!(range > 0)) return BRACKET_MAX;
  const pxPerRad = (height * 0.5) / Math.tan(vfovDeg * 0.5 * DEG_TO_RAD);
  const px = 2 * (radius / range) * pxPerRad * BRACKET_SLACK;
  return clamp(px, BRACKET_MIN, BRACKET_MAX);
}

/** How far inside the arrow tip the name label sits, px. */
const LABEL_INSET = 30;

// Module-level scratch: the draw path allocates nothing of its own.
const toTarget = new Vector3();
const proj: Projected = { x: 0, y: 0, behind: false };
const dir: ScreenPoint = { x: 0, y: 0 };
const edge: ScreenPoint = { x: 0, y: 0 };

function child(parent: HTMLElement, tag: string, cls: string, text = ''): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function setShown(el: HTMLElement, state: { shown: boolean }, shown: boolean): void {
  if (state.shown === shown) return;
  state.shown = shown;
  el.style.display = shown ? '' : 'none';
}

export function createTarget(): Instrument {
  let bracket: HTMLElement | null = null;
  let bracketName: HTMLElement | null = null;
  let arrow: HTMLElement | null = null;
  let arrowHead: HTMLElement | null = null;
  let arrowName: HTMLElement | null = null;

  // Last written values, so an unchanged frame writes nothing to the DOM.
  const bState = { shown: false, x: NaN, y: NaN, size: NaN };
  const aState = { shown: false, x: NaN, y: NaN, angle: NaN, lx: NaN, ly: NaN };
  let lastName = '';

  return {
    mount(root) {
      const el = child(root, 'div', 'inst inst-target');

      bracket = child(el, 'div', 'tgt-bracket');
      bracket.style.display = 'none';
      child(bracket, 'span', 'tgt-tick tl');
      child(bracket, 'span', 'tgt-tick tr');
      child(bracket, 'span', 'tgt-tick bl');
      child(bracket, 'span', 'tgt-tick br');
      bracketName = child(bracket, 'span', 'tgt-name');

      arrow = child(el, 'div', 'tgt-arrow');
      arrow.style.display = 'none';
      arrowHead = child(arrow, 'span', 'tgt-arrow-head');
      arrowName = child(arrow, 'span', 'tgt-arrow-name');
    },

    draw(ctx: HudContext) {
      if (!bracket || !bracketName || !arrow || !arrowHead || !arrowName) return;
      const target = ctx.world.targets[ctx.world.selected];
      if (!target) {
        setShown(bracket, bState, false);
        setShown(arrow, aState, false);
        return;
      }

      if (target.name !== lastName) {
        lastName = target.name;
        bracketName.textContent = target.name;
        arrowName.textContent = target.name;
      }

      projectPoint(target.position, ctx, proj);

      if (isOnScreen(proj, ctx.width, ctx.height, EDGE_MARGIN)) {
        // Range from the camera, since that is what sets the target's size on screen;
        // the ship-to-target range the velocity instrument shows differs by the camera
        // offset, which only matters in the last few metres.
        const range = toTarget.copy(target.position).sub(ctx.camera.position).length();
        const size = Math.round(bracketSize(target.radius, range, ctx.height, ctx.camera.fov));
        const x = Math.round(proj.x);
        const y = Math.round(proj.y);
        if (size !== bState.size) {
          bState.size = size;
          bracket.style.width = `${size}px`;
          bracket.style.height = `${size}px`;
        }
        if (x !== bState.x || y !== bState.y) {
          bState.x = x;
          bState.y = y;
          bracket.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        }
        setShown(arrow, aState, false);
        setShown(bracket, bState, true);
        return;
      }

      // Off screen or behind: arrow at the edge, pointing the shortest way round.
      screenDirection(proj, ctx.width, ctx.height, dir);
      clampToEdge(ctx.width, ctx.height, dir.x, dir.y, EDGE_MARGIN, edge);
      const x = Math.round(edge.x);
      const y = Math.round(edge.y);
      // Direction from the centre to the edge point is the arrow's heading; it is
      // well-defined even when dir was degenerate, because clampToEdge parked it.
      const ex = edge.x - ctx.width * 0.5;
      const ey = edge.y - ctx.height * 0.5;
      const len = Math.hypot(ex, ey) || 1;
      const angle = Math.round(Math.atan2(ey, ex) * 100) / 100;
      const lx = Math.round((-ex / len) * LABEL_INSET);
      const ly = Math.round((-ey / len) * LABEL_INSET);

      if (x !== aState.x || y !== aState.y) {
        aState.x = x;
        aState.y = y;
        arrow.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (angle !== aState.angle) {
        aState.angle = angle;
        arrowHead.style.transform = `rotate(${angle}rad)`;
      }
      if (lx !== aState.lx || ly !== aState.ly) {
        aState.lx = lx;
        aState.ly = ly;
        arrowName.style.transform = `translate(-50%, -50%) translate(${lx}px, ${ly}px)`;
      }
      setShown(bracket, bState, false);
      setShown(arrow, aState, true);
    },
  };
}
