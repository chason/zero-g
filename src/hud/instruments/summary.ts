import type { Instrument, HudContext } from '../instrument';
import {
  DOCK_MAX_SPEED,
  DOCK_MAX_ROTATION_DEG_PER_SEC,
  type World,
  type RunOutcome,
  type RunSummary,
} from '../../sim/world';

/**
 * Run summary: the verdict and the numbers behind it.
 *
 * Hidden while `world.outcome` is null. Once the sim decides the run it becomes a centred
 * panel: the outcome in large type, then elapsed time, propellant used and peak g, and
 * for a contact outcome the contact speed and residual rotation with the docking limits
 * printed beside them and the offending row flagged, so a crash tells the player WHICH
 * number lost them the run rather than just that one did.
 *
 * Everything shown comes from `world.summary`, which the sim filled at the outcome step
 * and never touches again, so the panel is written to the DOM once per outcome and then
 * left alone. Nothing in this file writes to the sim.
 *
 * There is no restart here. Restarting the run is a later issue; until it lands, the
 * panel stays up and the player reloads the page.
 *
 * Issue #26.
 */

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  dock: 'DOCKED',
  crash: 'CRASHED',
  blackout: 'BLACKOUT',
};

/** The display strings, already rounded. Pure data so tests need no DOM. */
export interface SummaryFields {
  /** DOCKED / CRASHED / BLACKOUT */
  headline: string;
  /** seconds, one decimal */
  time: string;
  /** kg, one decimal */
  propellant: string;
  /** g, one decimal */
  peakG: string;
  /** m/s at contact, two decimals; '' for a blackout */
  speed: string;
  /** the speed limit, formatted the same way */
  speedLimit: string;
  /** true when the contact speed exceeded the limit */
  speedOver: boolean;
  /** deg/s at contact, one decimal; '' for a blackout */
  rotation: string;
  /** the rotation limit, formatted the same way */
  rotationLimit: string;
  /** true when the residual rotation exceeded the limit */
  rotationOver: boolean;
}

export function freshSummaryFields(): SummaryFields {
  return {
    headline: '', time: '', propellant: '', peakG: '',
    speed: '', speedLimit: '', speedOver: false,
    rotation: '', rotationLimit: '', rotationOver: false,
  };
}

export const formatSeconds = (s: number): string => s.toFixed(1);
export const formatKg = (kg: number): string => kg.toFixed(1);
export const formatG = (g: number): string => g.toFixed(1);
export const formatContactSpeed = (mps: number): string => mps.toFixed(2);
export const formatContactRotation = (dps: number): string => dps.toFixed(1);

/**
 * The display strings for a decided run, or null while the run is live (the instrument
 * then draws nothing). The over-limit flags are decided on the raw figures, not the
 * rounded strings, so 0.504 m/s reads as "0.50" AND is flagged: the sim's verdict and
 * the panel's flag always agree.
 */
export function summaryFields(world: World, out: SummaryFields): SummaryFields | null {
  const { outcome, summary } = world;
  if (outcome === null || summary === null) return null;
  out.headline = OUTCOME_LABELS[outcome];
  out.time = formatSeconds(summary.time);
  out.propellant = formatKg(summary.propellantUsed);
  out.peakG = formatG(summary.peakG);
  out.speedLimit = formatContactSpeed(DOCK_MAX_SPEED);
  out.rotationLimit = formatContactRotation(DOCK_MAX_ROTATION_DEG_PER_SEC);
  if (summary.contactSpeed !== undefined && summary.contactRotation !== undefined) {
    out.speed = formatContactSpeed(summary.contactSpeed);
    out.speedOver = summary.contactSpeed > DOCK_MAX_SPEED;
    out.rotation = formatContactRotation(summary.contactRotation);
    out.rotationOver = summary.contactRotation > DOCK_MAX_ROTATION_DEG_PER_SEC;
  } else {
    out.speed = '';
    out.speedOver = false;
    out.rotation = '';
    out.rotationOver = false;
  }
  return out;
}

// --- DOM ---------------------------------------------------------------------------

/** Right-aligned numeric column so the figures line up under one another. */
const NUM_WIDTH = 7;
const LABEL_WIDTH = 10;

function row(label: string, value: string, unit: string, tail = ''): string {
  return label.padEnd(LABEL_WIDTH) + value.padStart(NUM_WIDTH) + ' ' + unit + tail;
}

interface Panel {
  el: HTMLElement;
  head: HTMLElement;
  time: HTMLElement;
  propellant: HTMLElement;
  peakG: HTMLElement;
  speed: HTMLElement;
  rotation: HTMLElement;
}

export function createSummary(): Instrument {
  let panel: Panel | null = null;
  const fields = freshSummaryFields();
  /** The summary object last written to the DOM; the sim never mutates one, so identity is enough. */
  let shownFor: RunSummary | null = null;

  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-summary';
      el.style.display = 'none';
      const line = (cls: string): HTMLElement => {
        const r = document.createElement('div');
        r.className = cls;
        el.appendChild(r);
        return r;
      };
      panel = {
        el,
        head: line('sum-head'),
        time: line('row'),
        propellant: line('row'),
        peakG: line('row'),
        speed: line('row'),
        rotation: line('row'),
      };
      root.appendChild(el);
    },

    draw(ctx: HudContext) {
      if (!panel) return;
      const { world } = ctx;
      if (summaryFields(world, fields) === null) {
        if (shownFor !== null) {
          shownFor = null;
          panel.el.style.display = 'none';
        }
        return;
      }
      if (shownFor === world.summary) return;
      shownFor = world.summary;

      panel.el.className = `inst inst-summary sum-${world.outcome}`;
      panel.head.textContent = fields.headline;
      panel.time.textContent = row('TIME', fields.time, 's');
      panel.propellant.textContent = row('PROP USED', fields.propellant, 'kg');
      panel.peakG.textContent = row('PEAK G', fields.peakG, 'g');

      const contact = fields.speed !== '';
      panel.speed.style.display = contact ? '' : 'none';
      panel.rotation.style.display = contact ? '' : 'none';
      if (contact) {
        panel.speed.textContent = row(
          'SPEED', fields.speed, 'm/s',
          `   limit ${fields.speedLimit} m/s` + (fields.speedOver ? '  OVER' : ''),
        );
        panel.speed.className = fields.speedOver ? 'row sum-over' : 'row';
        panel.rotation.textContent = row(
          'ROTATION', fields.rotation, 'deg/s',
          ` limit ${fields.rotationLimit} deg/s` + (fields.rotationOver ? '  OVER' : ''),
        );
        panel.rotation.className = fields.rotationOver ? 'row sum-over' : 'row';
      }
      panel.el.style.display = '';
    },
  };
}
