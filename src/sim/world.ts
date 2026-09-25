import { netWrench, massFlow, currentMass, type Ship } from './ship';
import { integrate, feltAcceleration, type Wrench } from './body';
import { stepPilot } from './pilot';
import { Vector3, G0 } from '../core/math';
import type { Command } from '../control';

/** Something the HUD can point at and the pilot can dock with. #25 supplies the real one. */
export interface Target {
  name: string;
  /** world frame, metres */
  position: Vector3;
  /** world frame, m/s — zero for a static ring */
  velocity: Vector3;
  /** metres; contact when the ship's docking port is within this of position */
  radius: number;
}

export interface World {
  ships: Ship[];
  /** all selectable targets; Tab cycles (#21) */
  targets: Target[];
  /** index into targets, or -1 for none */
  selected: number;
  /** simulated seconds since start */
  time: number;
}

/** Physics runs here and nowhere else, at a constant rate, independent of frame rate. */
export const STEP = 1 / 120;

export function createWorld(ships: Ship[] = []): World {
  return { ships, targets: [], selected: -1, time: 0 };
}

/**
 * Radius of the v1 play space, in metres: no ship or target may be further than this from
 * the world origin. Decided in issue #17; the README section "Play-space scale" has the
 * reasoning. In short: the sim is float64 and does not care, but every transform reaches
 * the GPU as float32, whose resolution is ~1 mm at 10 km and ~1 cm at 100 km. Jitter turns
 * visible once that approaches the smallest feature the camera can see, so 10 km is an
 * order of magnitude of margin under content that today sits 400 m out. Raise this and you
 * are signing up for a floating origin; do not raise it quietly.
 */
export const PLAY_SPACE_RADIUS = 10_000;

const PLAY_SPACE_RADIUS_SQ = PLAY_SPACE_RADIUS * PLAY_SPACE_RADIUS;

/** Worlds that have already been warned about, so a runaway ship logs once, not 120 times a second. */
const warnedWorlds = new WeakSet<World>();

/**
 * Cheap insurance that the play-space limit is enforced rather than remembered. Returns
 * true when every ship and target is within PLAY_SPACE_RADIUS of the origin. Otherwise
 * console.warns once per world naming the first offender and returns false. Called from
 * step(); costs one lengthSq per body and allocates nothing on the in-bounds path.
 */
export function assertWithinPlaySpace(world: World): boolean {
  let offender: string | null = null;
  let distanceSq = 0;
  for (const ship of world.ships) {
    const d2 = ship.body.position.lengthSq();
    if (d2 > PLAY_SPACE_RADIUS_SQ) {
      offender = `ship "${ship.spec.name}"`;
      distanceSq = d2;
      break;
    }
  }
  if (offender === null) {
    for (const target of world.targets) {
      const d2 = target.position.lengthSq();
      if (d2 > PLAY_SPACE_RADIUS_SQ) {
        offender = `target "${target.name}"`;
        distanceSq = d2;
        break;
      }
    }
  }
  if (offender === null) return true;
  if (!warnedWorlds.has(world)) {
    warnedWorlds.add(world);
    console.warn(
      `[zero-g] ${offender} is ${(Math.sqrt(distanceSq) / 1000).toFixed(1)} km from the origin; ` +
        `the v1 play space is ${PLAY_SPACE_RADIUS / 1000} km. Beyond it float32 render transforms ` +
        `jitter. Move the content inboard, or implement a floating origin — see #17 and the README ` +
        `section "Play-space scale".`,
    );
  }
  return false;
}

/** Scratch wrench, reused every tick so the hot path allocates nothing. */
const scratchWrench: Wrench = { force: new Vector3(), torque: new Vector3() };

/** Scratch per-axis clamp suppression, reused for the same reason. */
const scratchCommanded = { x: false, y: false, z: false };

/** Scratch seat offset in the body frame, reused for the same reason. */
const scratchSeat = new Vector3();

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
    // The zero clamp is suppressed per AXIS, not per ship. "Some thruster is open" is
    // too coarse: the main engine sits on the centreline and produces no torque, so
    // burning it used to disable the rotation clamp about all three axes and let
    // residual spin survive a long burn. An axis is under command exactly when the open
    // thrusters produce net torque about it, which the wrench already tells us.
    scratchCommanded.x = wrench.torque.x !== 0;
    scratchCommanded.y = wrench.torque.y !== 0;
    scratchCommanded.z = wrench.torque.z !== 0;
    integrate(ship.body, wrench, dt, scratchCommanded);

    // 4. burn propellant, floored at zero so mass can never fall below dry mass
    const burned = massFlow(ship) * dt;
    ship.propellant = Math.max(0, ship.propellant - burned);
    ship.body.mass = currentMass(ship);

    // 5. pilot g-load and the tolerance reserve (#23). The g felt at the seat comes from
    //    this step's wrench and the rates the body now has; the pass reads them and
    //    writes only `pilot`, never the body. The seat offset is re-read from the spec
    //    each step so a refit that moves the seat is honoured without a cache to forget.
    //    Hand-built test fixtures carry no pilot, and get no pilot update.
    const { pilot } = ship;
    if (pilot) {
      const seat = ship.spec.seatOffset;
      scratchSeat.set(seat[0], seat[1], seat[2]);
      const felt = feltAcceleration(ship.body, scratchSeat, wrench);
      stepPilot(pilot, felt.length() / G0, dt);
    }
  }

  world.time += dt;
  assertWithinPlaySpace(world);
}
