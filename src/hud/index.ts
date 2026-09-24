import type { World } from '../sim/world';

/**
 * In a no-assist game the HUD is the primary instrument, not decoration. A pilot who
 * can see 3.2 deg/s of residual yaw can null it; one flying blind cannot.
 *
 * Displayed resolution is 0.1 deg/s, which is why the rotation clamp at 0.017 deg/s
 * is invisible rather than generous.
 */
export interface Hud {
  draw(world: World): void;
}

export function createHud(el: HTMLElement): Hud {
  return {
    draw(world: World) {
      const s = world.ships[0];
      if (!s) { el.textContent = 'no ship'; return; }
      // TODO: velocity magnitude relative to the selected target, prograde/retrograde
      //       markers projected through the camera, target bracket and off-screen arrow,
      //       closing rate and range, propellant and remaining delta-v, g-load reserve.
      //       Round target-relative speed below 0.01 m/s to zero in the READOUT only —
      //       there is no rest frame in deep space, so never clamp world velocity itself.
      el.textContent = `t ${world.time.toFixed(1)}s`;
    },
  };
}
