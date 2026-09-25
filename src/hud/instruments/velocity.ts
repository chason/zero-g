import type { Instrument, HudContext } from '../instrument';

/**
 * Speed and range relative to the selected target. Readout rounds below 0.01 m/s; the state never does.
 *
 * Issue #19. Not implemented yet — this file is owned by that issue.
 */
export function createVelocity(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-velocity';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
