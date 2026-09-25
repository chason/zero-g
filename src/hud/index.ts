import type { PerspectiveCamera } from 'three';
import type { World } from '../sim/world';
import type { Instrument, HudContext } from './instrument';
import { createRotation } from './instruments/rotation';
import { createVelocity } from './instruments/velocity';
import { createMarkers } from './instruments/markers';
import { createTarget } from './instruments/target';
import { createPropellant } from './instruments/propellant';
import { createThrusters } from './instruments/thrusters';
import { createBoresight } from './instruments/boresight';
import { createSummary } from './instruments/summary';

/**
 * In a no-assist game the HUD is the primary instrument, not decoration. A pilot who
 * can see 3.2 deg/s of residual yaw can null it; one flying blind cannot. In cockpit
 * view it is load-bearing: there is no hull to read attitude off.
 *
 * Displayed rotation resolution is 0.1 deg/s, which is why the state clamp at
 * 0.017 deg/s is invisible rather than generous.
 *
 * This file is a registry only. Each instrument lives in its own file under
 * ./instruments and is owned by its own issue; add new ones here, implement them there.
 */
export interface Hud {
  draw(world: World): void;
}

export function createHud(root: HTMLElement, camera: PerspectiveCamera): Hud {
  const instruments: Instrument[] = [
    createRotation(),
    createVelocity(),
    createMarkers(),
    createTarget(),
    createPropellant(),
    createThrusters(),
    createBoresight(),
    createSummary(),
  ];
  for (const inst of instruments) inst.mount(root);

  const ctx: HudContext = {
    world: undefined as unknown as World,
    ship: undefined as unknown as HudContext['ship'],
    camera,
    width: innerWidth,
    height: innerHeight,
  };
  addEventListener('resize', () => { ctx.width = innerWidth; ctx.height = innerHeight; });

  return {
    draw(world: World) {
      const ship = world.ships[0];
      if (!ship) return;
      ctx.world = world;
      ctx.ship = ship;
      for (const inst of instruments) inst.draw(ctx);
    },
  };
}
