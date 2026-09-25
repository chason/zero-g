import type { Instrument, HudContext } from '../instrument';

/**
 * Propellant, current mass, remaining delta-v from the rocket equation.
 *
 * Issue #22. Not implemented yet — this file is owned by that issue.
 */
export function createPropellant(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-propellant';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
