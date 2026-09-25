import type { Instrument, HudContext } from '../instrument';

/**
 * Per-axis rotation rate in deg/s, one decimal. The instrument that makes no-assist flyable.
 *
 * Issue #18. Not implemented yet — this file is owned by that issue.
 */
export function createRotation(): Instrument {
  let el: HTMLElement | null = null;
  return {
    mount(root) {
      el = document.createElement('div');
      el.className = 'inst inst-rotation';
      root.appendChild(el);
    },
    draw(_ctx: HudContext) {
      if (el) el.textContent = '';
    },
  };
}
