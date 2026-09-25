import type { Instrument, HudContext } from '../instrument';

/**
 * Prograde and retrograde markers projected through the camera.
 *
 * Issue #20. Not implemented yet — this file is owned by that issue.
 */
export function createMarkers(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-markers';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
