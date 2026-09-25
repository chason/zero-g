import type { Instrument, HudContext } from '../instrument';
import { RAD_TO_DEG } from '../instrument';

/**
 * Per-axis rotation rate in deg/s, one decimal. The instrument that makes no-assist flyable:
 * with nothing damping the ship, the only way to null a tumble is to see it, and a pilot
 * who can read 3.2 deg/s of residual yaw can kill it in three taps.
 *
 * Reads `ship.body.angularVelocity`, which is in the BODY frame in rad/s: x = pitch,
 * y = yaw, z = roll. Displayed resolution is 0.1 deg/s — this is what makes the state
 * clamp at OMEGA_EPSILON (~0.017 deg/s) invisible, so do not raise it.
 *
 * Issue #18.
 */

/** Characters per value: sign + up to three integer digits + '.' + one decimal, e.g. "  +3.2". */
export const RATE_WIDTH = 6;
/** Below this the row is dimmed: a rate the pilot can leave alone for now. */
export const DIM_BELOW_DEG = 0.5;
/** Above this the row is emphasised: a tumble worth killing before anything else. */
export const ALERT_ABOVE_DEG = 10;

export type RateBand = 'dim' | 'live' | 'alert';

/**
 * Quantise a rate to signed tenths of a deg/s — the integer the readout is built from.
 * Rounding the magnitude and re-applying the sign means anything below 0.05 deg/s is
 * exactly 0, so "-0.0" can never appear.
 */
function quantizeRate(radPerSec: number): number {
  const tenths = Math.round(Math.abs(radPerSec) * RAD_TO_DEG * 10);
  if (tenths === 0) return 0;
  return radPerSec < 0 ? -tenths : tenths;
}

/** Render signed tenths as "+3.2" / "-0.4" / " 0.0", right-aligned to RATE_WIDTH. */
function formatTenths(signedTenths: number): string {
  const mag = Math.abs(signedTenths);
  const sign = mag === 0 ? ' ' : signedTenths < 0 ? '-' : '+';
  const s = sign + Math.floor(mag / 10) + '.' + (mag % 10);
  return s.length < RATE_WIDTH ? s.padStart(RATE_WIDTH, ' ') : s;
}

/** Which brightness band a quantised rate falls in; judged on the DISPLAYED value so the cue never disagrees with the digits. */
function bandOfTenths(signedTenths: number): RateBand {
  const mag = Math.abs(signedTenths);
  if (mag < DIM_BELOW_DEG * 10) return 'dim';
  if (mag > ALERT_ABOVE_DEG * 10) return 'alert';
  return 'live';
}

/**
 * Format a BODY-frame rate in rad/s as signed deg/s to one decimal, fixed width.
 * Pure; this is the whole display contract and what test/hud-rotation.test.ts pins.
 */
export function formatRate(radPerSec: number): string {
  return formatTenths(quantizeRate(radPerSec));
}

/** Magnitude cue for a rate in rad/s: 'dim' below 0.5 deg/s, 'alert' above 10 deg/s, else 'live'. */
export function rateBand(radPerSec: number): RateBand {
  return bandOfTenths(quantizeRate(radPerSec));
}

const ROW_CLASS: Record<RateBand, string> = {
  dim: 'rot-row rate-dim',
  live: 'rot-row rate-live',
  alert: 'rot-row rate-alert',
};

interface Row {
  el: HTMLElement;
  value: HTMLElement;
  /** last displayed signed tenths — draw skips the DOM when this has not moved */
  tenths: number;
  band: RateBand;
}

function buildRow(parent: HTMLElement, label: string): Row {
  const el = document.createElement('div');
  el.className = ROW_CLASS.dim;
  const name = document.createElement('span');
  name.className = 'rot-label';
  name.textContent = label;
  const value = document.createElement('span');
  value.className = 'rot-value';
  value.textContent = formatTenths(0);
  el.appendChild(name);
  el.appendChild(value);
  parent.appendChild(el);
  return { el, value, tenths: 0, band: 'dim' };
}

/** Push one axis into its row, touching the DOM only when the displayed value or band changed. */
function updateRow(row: Row, radPerSec: number): void {
  const tenths = quantizeRate(radPerSec);
  if (tenths === row.tenths) return;
  row.tenths = tenths;
  row.value.textContent = formatTenths(tenths);
  const band = bandOfTenths(tenths);
  if (band !== row.band) {
    row.band = band;
    row.el.className = ROW_CLASS[band];
  }
}

export function createRotation(): Instrument {
  let rows: [Row, Row, Row] | null = null;
  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-rotation';
      const head = document.createElement('div');
      head.className = 'rot-head';
      head.textContent = 'ROT    deg/s';
      el.appendChild(head);
      // labels padded to a common width; the layer is white-space: pre
      rows = [buildRow(el, 'PITCH '), buildRow(el, 'YAW   '), buildRow(el, 'ROLL  ')];
      root.appendChild(el);
    },
    draw(ctx: HudContext) {
      if (!rows) return;
      // BODY frame, rad/s. Read only — never written.
      const w = ctx.ship.body.angularVelocity;
      updateRow(rows[0], w.x);
      updateRow(rows[1], w.y);
      updateRow(rows[2], w.z);
    },
  };
}
