import { netWrench, massFlow, currentMass, type Ship } from './ship';
import { integrate, type Wrench } from './body';
import { Vector3 } from '../core/math';
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

/** Scratch wrench, reused every tick so the hot path allocates nothing. */
const scratchWrench: Wrench = { force: new Vector3(), torque: new Vector3() };

/**
 * Advance the whole world by exactly `dt` seconds. Never call with a variable dt.
 *
 * Order is load-bearing. Mass is read fresh at the top of every step and the
 * propellant burn is subtracted only AFTER integration, so a ship accelerates
 * harder as its tanks empty instead of coasting on a mass cached at load time.
 */
export function step(world: World, command: Command, dt: number): void {
  for (const ship of world.ships) {
    // 1. apply the incoming command to this ship's throttles
    const { throttles } = ship;
    const n = Math.min(throttles.length, command.throttles.length);
    for (let i = 0; i < n; i++) throttles[i] = command.throttles[i]!;
    for (let i = n; i < throttles.length; i++) throttles[i] = 0;

    // 2. net wrench from whatever is open, in the body frame
    const wrench = netWrench(ship, scratchWrench);

    // 3. integrate at the mass the ship has RIGHT NOW, before this step's burn
    ship.body.mass = currentMass(ship);
    let firing = false;
    for (let i = 0; i < throttles.length; i++) {
      if (throttles[i] !== 0) { firing = true; break; }
    }
    integrate(ship.body, wrench, dt, firing);

    // 4. burn propellant, floored at zero so mass can never fall below dry mass
    const burned = massFlow(ship) * dt;
    ship.propellant = Math.max(0, ship.propellant - burned);
    ship.body.mass = currentMass(ship);

    // 5. pilot g-load and the tolerance reserve — issue #23, not implemented here.
    //    Call site: feltAcceleration(ship.body, new Vector3(...ship.spec.seatOffset), wrench)
    //    divided by G0 gives the g felt at the seat; the health system consumes it.
  }

  world.time += dt;
}
