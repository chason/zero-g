import type { Ship } from './ship';
import type { Command } from '../control';

export interface World {
  ships: Ship[];
  /** simulated seconds since start */
  time: number;
}

/** Physics runs here and nowhere else, at a constant rate, independent of frame rate. */
export const STEP = 1 / 120;

export function createWorld(ships: Ship[] = []): World {
  return { ships, time: 0 };
}

/**
 * Advance the whole world by exactly `dt` seconds. Never call with a variable dt.
 *
 * TODO — implement:
 *   1. apply `command` to each ship's throttles
 *   2. netWrench -> integrate
 *   3. burn propellant, update mass
 *   4. update pilot g-load and the tolerance reserve
 *   5. world.time += dt
 */
export function step(_world: World, _command: Command, _dt: number): void {
  throw new Error('sim/world.ts step() is not implemented yet — see test/world.test.ts');
}
