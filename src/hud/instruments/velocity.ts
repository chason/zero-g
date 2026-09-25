import { Vector3 } from '../../core/math';
import type { Instrument, HudContext } from '../instrument';
import type { World, Target } from '../../sim/world';
import type { Ship } from '../../sim/ship';

/**
 * Speed and range relative to the selected target, plus the closing rate. Range and
 * closing rate are the two numbers docking is actually flown with, so they sit together.
 *
 * Everything here is relative to the target. There is no rest frame in deep space, so
 * absolute speed is meaningless: with no target selected the fields read `--`, never
 * world speed.
 *
 * The readout rounds below 0.01 m/s; the state never does. Residual linear drift is
 * harmless — unlike rotation it does not compound — and a clamp on world velocity would
 * be a lie about a frame that does not exist. Nothing in this file writes to the sim.
 *
 * Issue #19.
 */

/** Below this the speed readout shows 0.00. Display resolution only, never applied to state. */
export const SPEED_RESOLUTION = 0.01;

/** Range switches from metres to kilometres from this distance up. */
export const KM_THRESHOLD = 10_000;

/** What every field shows when no target is selected. */
export const UNAVAILABLE = '--';

export interface VelocityReadout {
  /** |ship.velocity - target.velocity|, m/s */
  speed: number;
  /** |target.position - ship.position|, m */
  range: number;
  /** d(range)/dt, m/s: negative when closing, positive when receding */
  closing: number;
}

/** The display strings, already rounded. Pure data so tests need no DOM. */
export interface VelocityFields {
  target: string;
  speed: string;
  range: string;
  closing: string;
}

// Scratch vectors, allocated once: draw() runs every frame and must not allocate.
const relVel = new Vector3();
const lineOfSight = new Vector3();
const readout: VelocityReadout = { speed: 0, range: 0, closing: 0 };

/** The target `world.selected` points at, or null when it is -1 or stale. */
export function selectedTarget(world: World): Target | null {
  if (world.selected < 0) return null;
  return world.targets[world.selected] ?? null;
}

/**
 * Relative speed, range and closing rate of `ship` with respect to `target`.
 *
 * Closing rate is the component of relative velocity along the line to the target,
 * signed so that a shrinking range is negative: it is exactly d(range)/dt. Reads the
 * ship and target, writes only `out`.
 */
export function computeReadout(ship: Ship, target: Target, out: VelocityReadout): VelocityReadout {
  relVel.subVectors(ship.body.velocity, target.velocity);
  lineOfSight.subVectors(target.position, ship.body.position);
  const range = lineOfSight.length();
  out.speed = relVel.length();
  out.range = range;
  // Relative velocity along the line of sight shortens the range, hence the sign flip.
  // At zero range the line has no direction, so report 0 rather than NaN.
  out.closing = range > 0 ? -relVel.dot(lineOfSight) / range : 0;
  return out;
}

/** Unsigned speed to two decimals. Anything below the display resolution reads 0.00. */
export function formatSpeed(mps: number): string {
  return mps < SPEED_RESOLUTION ? '0.00' : mps.toFixed(2);
}

/**
 * Signed rate to two decimals with an explicit + so the sign is never missed.
 * Below the display resolution it reads 0.00, never -0.00.
 */
export function formatRate(mps: number): string {
  if (Math.abs(mps) < SPEED_RESOLUTION) return '0.00';
  return mps > 0 ? '+' + mps.toFixed(2) : mps.toFixed(2);
}

/** Metres to one decimal below 10 km, kilometres to one decimal from there. */
export function formatRange(metres: number): string {
  return metres >= KM_THRESHOLD
    ? (metres / 1000).toFixed(1) + ' km'
    : metres.toFixed(1) + ' m';
}

/**
 * The display strings for the current world state. Pure: no DOM, nothing allocated
 * beyond the strings themselves, and the sim is only read.
 */
export function velocityFields(world: World, ship: Ship, out: VelocityFields): VelocityFields {
  const target = selectedTarget(world);
  if (!target) {
    out.target = UNAVAILABLE;
    out.speed = UNAVAILABLE;
    out.range = UNAVAILABLE;
    out.closing = UNAVAILABLE;
    return out;
  }
  computeReadout(ship, target, readout);
  out.target = target.name;
  out.speed = formatSpeed(readout.speed);
  out.range = formatRange(readout.range);
  out.closing = formatRate(readout.closing);
  return out;
}

// --- DOM ---------------------------------------------------------------------------

/** Right-aligned numeric column so digits sit still while the value changes. */
const NUM_WIDTH = 9;

function row(label: string, value: string, unit: string): string {
  return label + ' ' + value.padStart(NUM_WIDTH) + (unit ? ' ' + unit : '');
}

function rangeRow(value: string): string {
  if (value === UNAVAILABLE) return row('RNG', value, '');
  const sp = value.lastIndexOf(' ');
  return row('RNG', value.slice(0, sp), value.slice(sp + 1));
}

interface Rows {
  target: HTMLElement;
  speed: HTMLElement;
  range: HTMLElement;
  closing: HTMLElement;
}

export function createVelocity(): Instrument {
  let rows: Rows | null = null;
  const fields: VelocityFields = { target: '', speed: '', range: '', closing: '' };
  // What the DOM currently shows, so unchanged strings cost no DOM write.
  const shown: VelocityFields = { target: '', speed: '', range: '', closing: '' };

  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-velocity';
      const line = (): HTMLElement => {
        const r = document.createElement('div');
        r.className = 'row';
        el.appendChild(r);
        return r;
      };
      rows = { target: line(), speed: line(), range: line(), closing: line() };
      root.appendChild(el);
    },
    draw(ctx: HudContext) {
      if (!rows) return;
      velocityFields(ctx.world, ctx.ship, fields);
      if (fields.target !== shown.target) {
        shown.target = fields.target;
        rows.target.textContent = 'REL ' + fields.target;
      }
      if (fields.speed !== shown.speed) {
        shown.speed = fields.speed;
        rows.speed.textContent = row('VEL', fields.speed, fields.speed === UNAVAILABLE ? '' : 'm/s');
      }
      if (fields.range !== shown.range) {
        shown.range = fields.range;
        rows.range.textContent = rangeRow(fields.range);
      }
      if (fields.closing !== shown.closing) {
        shown.closing = fields.closing;
        rows.closing.textContent = row('CLS', fields.closing, fields.closing === UNAVAILABLE ? '' : 'm/s');
      }
    },
  };
}
