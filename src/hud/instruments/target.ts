import type { Instrument, HudContext } from '../instrument';

/**
 * Target bracket on screen, edge arrow off screen. Tab cycles targets.
 *
 * Issue #21. Not implemented yet — this file is owned by that issue.
 */
export function createTarget(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-target';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
