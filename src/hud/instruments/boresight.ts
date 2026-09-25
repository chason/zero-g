import { Vector3 } from '../../core/math';
import type { Instrument, HudContext, Projected } from '../instrument';
import { projectDirection, RAD_TO_DEG } from '../instrument';
import { relativeVelocity, MIN_MARKER_SPEED } from './markers';

/**
 * Boresight reticle and burn-alignment readout.
 *
 * The prograde/retrograde markers give the pilot something to point at; this gives them
 * the thing they are pointing WITH. The nose (body −Z) is projected through the camera
 * rather than pinned to screen centre so it is honest in chase view too, where the
 * lagged camera does not look exactly down the hull.
 *
 * Beside it, the angle from the nose to whichever of prograde or retrograde is nearer.
 * Burning a little off-axis is fine — the marker slides away from the nose and that IS
 * the correction cue — but the pilot has to see the error to chase it, and the number
 * also says when a shrinking velocity vector has become too twitchy for the main engine.
 *
 * Issue #35.
 */

/** Within this the readout is emphasised: close enough to light the main engine. */
export const ALIGNED_DEG = 1;

export interface Alignment {
  which: 'pro' | 'retro';
  deg: number;
}

const NOSE_BODY = new Vector3(0, 0, -1);
const scratchNose = new Vector3();
const scratchVel = new Vector3();
const scratchProj: Projected = { x: 0, y: 0, behind: false };

/**
 * Angle in degrees from the nose to the nearer of prograde and retrograde.
 * Pure: returns null when relative speed is below the marker floor, since the
 * direction is then noise. `nose` and `relVel` are world-frame.
 */
export function alignmentTo(nose: Vector3, relVel: Vector3, out: Alignment): Alignment | null {
  const speed = relVel.length();
  if (speed < MIN_MARKER_SPEED) return null;
  const n = nose.length();
  if (n === 0) return null;
  const cos = Math.max(-1, Math.min(1, nose.dot(relVel) / (n * speed)));
  const toPro = Math.acos(cos) * RAD_TO_DEG;
  if (toPro <= 90) {
    out.which = 'pro';
    out.deg = toPro;
  } else {
    out.which = 'retro';
    out.deg = 180 - toPro;
  }
  return out;
}

/** "RETRO  2.3°" — fixed width, one decimal. */
export function formatAlignment(a: Alignment): string {
  const label = a.which === 'retro' ? 'RETRO' : 'PRO  ';
  return `${label} ${a.deg.toFixed(1).padStart(5)}°`;
}

export function createBoresight(): Instrument {
  let ring: HTMLElement | null = null;
  let text: HTMLElement | null = null;
  const align: Alignment = { which: 'pro', deg: 0 };
  let lastX = -1;
  let lastY = -1;
  let lastText = '';
  let lastAligned = false;
  let lastShown = false;

  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-boresight';
      ring = document.createElement('div');
      ring.className = 'bore-ring';
      text = document.createElement('div');
      text.className = 'bore-text';
      el.appendChild(ring);
      el.appendChild(text);
      root.appendChild(el);
    },

    draw(ctx: HudContext) {
      if (!ring || !text) return;
      const { ship, world } = ctx;

      scratchNose.copy(NOSE_BODY).applyQuaternion(ship.body.orientation);
      projectDirection(scratchNose, ctx, scratchProj);
      const shown = !scratchProj.behind;
      if (shown !== lastShown) {
        ring.style.display = shown ? '' : 'none';
        lastShown = shown;
      }
      if (shown) {
        const x = Math.round(scratchProj.x);
        const y = Math.round(scratchProj.y);
        if (x !== lastX || y !== lastY) {
          ring.style.transform = `translate(${x}px, ${y}px)`;
          lastX = x;
          lastY = y;
        }
      }

      const target = world.selected >= 0 ? world.targets[world.selected] : undefined;
      relativeVelocity(ship.body.velocity, target, scratchVel);
      const a = alignmentTo(scratchNose, scratchVel, align);
      const s = a ? formatAlignment(a) : '';
      if (s !== lastText) {
        text.textContent = s;
        lastText = s;
      }
      const aligned = a !== null && a.deg <= ALIGNED_DEG;
      if (aligned !== lastAligned) {
        text.classList.toggle('bore-aligned', aligned);
        lastAligned = aligned;
      }
    },
  };
}
