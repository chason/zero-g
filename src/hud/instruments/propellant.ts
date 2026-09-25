import { G0 } from '../../core/math';
import { currentMass } from '../../sim/ship';
import type { Instrument, HudContext } from '../instrument';
import type { Ship } from '../../sim/ship';

/**
 * Propellant remaining, current total mass, and the delta-v the tanks still hold.
 *
 * Delta-v is the rocket equation, dv = isp * g0 * ln(m_now / m_dry), at the main
 * engine's Isp. It is what turns every input into a decision rather than a free
 * correction: the pilot sees exactly how much manoeuvring is left.
 *
 * Mass is read through currentMass(ship) on every draw and never cached: cargo will
 * move it later, and a delta-v computed from a stale mass would be quietly wrong.
 * Nothing in this file writes to the sim.
 *
 * Issue #22.
 */

export interface PropellantReadout {
  /** kg in the tanks */
  propellant: number;
  /** propellant / capacity, clamped to 0..1 */
  fraction: number;
  /** kg, currentMass(ship) */
  mass: number;
  /** seconds, the Isp delta-v is computed at */
  isp: number;
  /** m/s remaining */
  deltaV: number;
}

/** The display strings, already rounded, plus the bar fraction. Pure data so tests need no DOM. */
export interface PropellantFields {
  propellant: string;
  percent: string;
  mass: string;
  deltaV: string;
  fraction: number;
}

const readout: PropellantReadout = { propellant: 0, fraction: 0, mass: 0, isp: 0, deltaV: 0 };

/**
 * The Isp delta-v is quoted at: the thruster whose id is 'main', or failing that the
 * highest-thrust thruster on the ship. 0 for a ship with no thrusters at all.
 * Looked up per call rather than cached, so a loadout change is picked up immediately.
 */
export function mainIsp(ship: Ship): number {
  const { prepared } = ship;
  let strongest = -1;
  for (let i = 0; i < prepared.length; i++) {
    const t = prepared[i]!;
    if (t.spec.id === 'main') return t.spec.isp;
    if (strongest < 0 || t.spec.thrust > prepared[strongest]!.spec.thrust) strongest = i;
  }
  return strongest < 0 ? 0 : prepared[strongest]!.spec.isp;
}

/**
 * Tsiolkovsky: dv = isp * g0 * ln(massNow / massDry).
 * Zero once the tanks are dry (massNow == massDry), and never negative or NaN if
 * the mass is somehow below dry.
 */
export function deltaV(isp: number, massNow: number, massDry: number): number {
  if (massDry <= 0 || massNow <= massDry) return 0;
  return isp * G0 * Math.log(massNow / massDry);
}

/** Delta-v left in the tanks right now, at the main engine's Isp. Mass is read fresh. */
export function remainingDeltaV(ship: Ship): number {
  return deltaV(mainIsp(ship), currentMass(ship), ship.spec.dryMass);
}

/** Everything the instrument shows, as numbers. Reads the ship, writes only `out`. */
export function computeReadout(ship: Ship, out: PropellantReadout): PropellantReadout {
  const capacity = ship.spec.propellantCapacity;
  out.propellant = ship.propellant;
  out.fraction = capacity > 0 ? Math.min(1, Math.max(0, ship.propellant / capacity)) : 0;
  out.mass = currentMass(ship);
  out.isp = mainIsp(ship);
  out.deltaV = deltaV(out.isp, out.mass, ship.spec.dryMass);
  return out;
}

/** The display strings for the current ship state. Pure: no DOM, nothing allocated beyond the strings. */
export function propellantFields(ship: Ship, out: PropellantFields): PropellantFields {
  computeReadout(ship, readout);
  out.propellant = readout.propellant.toFixed(1);
  out.percent = Math.round(readout.fraction * 100).toString();
  out.mass = readout.mass.toFixed(1);
  out.deltaV = readout.deltaV.toFixed(1);
  out.fraction = readout.fraction;
  return out;
}

// --- DOM ---------------------------------------------------------------------------

/** Right-aligned numeric column so digits sit still while the value changes. */
const NUM_WIDTH = 8;

function row(label: string, value: string, unit: string): string {
  return label + ' ' + value.padStart(NUM_WIDTH) + ' ' + unit;
}

interface Rows {
  propellant: HTMLElement;
  fill: HTMLElement;
  mass: HTMLElement;
  deltaV: HTMLElement;
}

export function createPropellant(): Instrument {
  let rows: Rows | null = null;
  const fields: PropellantFields = { propellant: '', percent: '', mass: '', deltaV: '', fraction: 0 };
  // What the DOM currently shows, so unchanged strings cost no DOM write.
  const shown: Omit<PropellantFields, 'fraction'> = { propellant: '', percent: '', mass: '', deltaV: '' };

  return {
    mount(root) {
      const el = document.createElement('div');
      el.className = 'inst inst-propellant';
      const line = (): HTMLElement => {
        const r = document.createElement('div');
        r.className = 'row';
        el.appendChild(r);
        return r;
      };
      const propellant = line();
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'fill';
      bar.appendChild(fill);
      el.appendChild(bar);
      rows = { propellant, fill, mass: line(), deltaV: line() };
      root.appendChild(el);
    },
    draw(ctx: HudContext) {
      if (!rows) return;
      propellantFields(ctx.ship, fields);
      if (fields.propellant !== shown.propellant || fields.percent !== shown.percent) {
        shown.propellant = fields.propellant;
        shown.percent = fields.percent;
        rows.propellant.textContent = row('PROP', fields.propellant, 'kg') + fields.percent.padStart(4) + '%';
        // the bar moves with the integer percent, which is the resolution the eye reads it at
        rows.fill.style.width = fields.percent + '%';
      }
      if (fields.mass !== shown.mass) {
        shown.mass = fields.mass;
        rows.mass.textContent = row('MASS', fields.mass, 'kg');
      }
      if (fields.deltaV !== shown.deltaV) {
        shown.deltaV = fields.deltaV;
        rows.deltaV.textContent = row('DV  ', fields.deltaV, 'm/s');
      }
    },
  };
}
