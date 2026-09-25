import type { PerspectiveCamera } from 'three';
import type { ViewMode } from '../render';
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
  /** `view` is the renderer's: in the cockpit the dash carries the readouts (#54) */
  draw(world: World, view?: ViewMode): void;
}

/**
 * Instruments the cockpit's dash draws for itself (src/render/dash.ts). In cockpit view
 * their screen copies are hidden; in chase view, with no dash, they show. The boresight,
 * brackets, markers and summary track the world, so they stay on screen in both.
 */
export const DASH_BORNE = new Set(['rotation', 'velocity', 'propellant', 'thrusters']);

export function createHud(root: HTMLElement, camera: PerspectiveCamera): Hud {
  const instruments: { name: string; inst: Instrument; box: HTMLElement }[] = [
    { name: 'rotation', inst: createRotation() },
    { name: 'velocity', inst: createVelocity() },
    { name: 'markers', inst: createMarkers() },
    { name: 'target', inst: createTarget() },
    { name: 'propellant', inst: createPropellant() },
    { name: 'thrusters', inst: createThrusters() },
    { name: 'boresight', inst: createBoresight() },
    { name: 'summary', inst: createSummary() },
  ].map((entry) => {
    // Each instrument mounts into a box of its own, so the registry can hide it without
    // knowing its DOM. The box is unpositioned, so the instrument's own absolute
    // placement still resolves against #hud.
    const box = document.createElement('div');
    box.className = 'inst-box inst-box-' + entry.name;
    root.appendChild(box);
    entry.inst.mount(box);
    return { ...entry, box };
  });

  const ctx: HudContext = {
    world: undefined as unknown as World,
    ship: undefined as unknown as HudContext['ship'],
    view: 'chase',
    camera,
    width: innerWidth,
    height: innerHeight,
  };
  addEventListener('resize', () => { ctx.width = innerWidth; ctx.height = innerHeight; });
  let shownFor: ViewMode | null = null;

  return {
    draw(world: World, view: ViewMode = 'chase') {
      const ship = world.ships[0];
      if (!ship) return;
      ctx.world = world;
      ctx.ship = ship;
      ctx.view = view;
      if (view !== shownFor) {
        shownFor = view;
        for (const { name, box } of instruments) {
          box.style.display = view === 'cockpit' && DASH_BORNE.has(name) ? 'none' : '';
        }
      }
      for (const { inst } of instruments) inst.draw(ctx);
    },
  };
}
