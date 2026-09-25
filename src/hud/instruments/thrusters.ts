import type { Instrument, HudContext } from '../instrument';

/**
 * Per-thruster indicator lights, laid out from ship.prepared. The cockpit's substitute for seeing plumes.
 *
 * Issue #32. Not implemented yet — this file is owned by that issue.
 */
export function createThrusters(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-thrusters';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
