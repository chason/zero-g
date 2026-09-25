import type { PerspectiveCamera, Vector3 } from 'three';
import type { World } from '../sim/world';
import type { Ship } from '../sim/ship';
import type { ViewMode } from '../render';

/**
 * Everything an instrument may read. Instruments are read-only views of the
 * simulation: nothing here may be mutated, and nothing here may touch input.
 */
export interface HudContext {
  world: World;
  ship: Ship;
  /** the renderer's view: in the cockpit the dash carries the readouts, so the screen copies hide */
  view: ViewMode;
  /** the live render camera, for projecting world points onto the screen */
  camera: PerspectiveCamera;
  width: number;
  height: number;
}

/**
 * One instrument = one file under src/hud/instruments/. The registry in
 * src/hud/index.ts mounts each into its own container and calls draw every frame.
 * Instruments must not reach into each other's DOM.
 */
export interface Instrument {
  /** Called once with the container this instrument owns. Build DOM here. */
  mount(root: HTMLElement): void;
  /** Called once per rendered frame. Keep it allocation-free where practical. */
  draw(ctx: HudContext): void;
}

export interface Projected {
  /** screen px from the left */
  x: number;
  /** screen px from the top */
  y: number;
  /** true when the point is behind the camera — x/y are then unreliable */
  behind: boolean;
}

/**
 * Project a WORLD-space point through the camera into screen pixels.
 * Shared so every instrument agrees on where a thing is on screen.
 */
export function projectPoint(p: Vector3, ctx: HudContext, out: Projected): Projected {
  const v = p.clone().project(ctx.camera);
  out.behind = v.z > 1;
  out.x = (v.x + 1) * 0.5 * ctx.width;
  out.y = (1 - v.y) * 0.5 * ctx.height;
  return out;
}

/**
 * Project a WORLD-space DIRECTION (unit vector) as if it were a point at infinity.
 * Use for prograde/retrograde markers, which have a direction but no position.
 */
export function projectDirection(dir: Vector3, ctx: HudContext, out: Projected): Projected {
  const far = dir.clone().normalize().multiplyScalar(1e6).add(ctx.camera.position);
  return projectPoint(far, ctx, out);
}

export const RAD_TO_DEG = 180 / Math.PI;
