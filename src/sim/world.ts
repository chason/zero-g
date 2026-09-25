import { netWrench, massFlow, currentMass, dockingPortPosition, type Ship } from './ship';
import { integrate, feltAcceleration, type Wrench } from './body';
import { stepPilot } from './pilot';
import { Vector3, G0 } from '../core/math';
import type { Command } from '../control';

/** Something the HUD can point at and the pilot can dock with. main.ts places the ring (#25). */
export interface Target {
  name: string;
  /** world frame, metres */
  position: Vector3;
  /** world frame, m/s — zero for a static ring */
  velocity: Vector3;
  /** metres; contact when the ship's docking port is within this of position */
  radius: number;
}

/**
 * The moment a ship's docking port first entered a target's contact radius (#25). Filled
 * once, at that step, and never updated: the numbers here are what the run is judged on,
 * so they must be the ones from the instant of contact, not from whatever the body did
 * afterwards. There is no collision response — contact is an outcome to classify, not a
 * physics problem.
 */
export interface Contact {
  /** index into world.targets */
  targetIndex: number;
  /** |ship.velocity - target.velocity| at contact, m/s */
  relativeSpeed: number;
  /** |body.angularVelocity| at contact, in deg/s — the HUD's unit, so the two agree */
  residualRotationDegPerSec: number;
  /** world.time at contact, seconds */
  time: number;
}

/**
 * How a run ends (#26). 'dock' and 'crash' are the two readings of a contact; 'blackout'
 * is the pilot's health reaching zero with no contact made. A run has exactly one.
 */
export type RunOutcome = 'dock' | 'crash' | 'blackout';

/** What the run summary shows once the outcome is decided. Filled at that step, never after. */
export interface RunSummary {
  /** world.time at the outcome, seconds */
  time: number;
  /** kg burned this run: capacity minus what is left in the tanks */
  propellantUsed: number;
  /** highest g the pilot felt this run */
  peakG: number;
  /** m/s at contact; only for 'dock' and 'crash' */
  contactSpeed?: number;
  /** deg/s at contact; only for 'dock' and 'crash' */
  contactRotation?: number;
}

export interface World {
  ships: Ship[];
  /** all selectable targets; Tab cycles (#21) */
  targets: Target[];
  /** index into targets, or -1 for none */
  selected: number;
  /** simulated seconds since start */
  time: number;
  /** the first docking-port contact this run, or null while still flying (#25) */
  contact: Contact | null;
  /** null while the run is live; once set the sim is frozen and only time advances (#26) */
  outcome: RunOutcome | null;
  /** the figures the run ended with, set together with outcome (#26) */
  summary: RunSummary | null;
}

/** Physics runs here and nowhere else, at a constant rate, independent of frame rate. */
export const STEP = 1 / 120;

export function createWorld(ships: Ship[] = []): World {
  return { ships, targets: [], selected: -1, time: 0, contact: null, outcome: null, summary: null };
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * A contact is a dock when it is at or under BOTH of these; over either, it is a crash.
 * Speed is relative to the target; rotation is the magnitude of the body rate, in the
 * HUD's unit so the player is judged on the number they were reading.
 *
 * The rotation state clamp in body.ts (OMEGA_EPSILON, 0.0003 rad/s = 0.017 deg/s) sits
 * two orders of magnitude under the rotation limit, and the speed readout's display
 * rounding (0.01 m/s) is not a state clamp at all. Neither can decide an outcome: a
 * rate the clamp zeroes was already a hundred times too small to matter, so the cheat
 * stays a resolution floor and never a flight assist. test/docking.test.ts asserts the
 * relationship; keep it at least an order of magnitude whatever these are tuned to.
 */
export const DOCK_MAX_SPEED = 0.5;
export const DOCK_MAX_ROTATION_DEG_PER_SEC = 2;

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

/** Scratch docking-port world position and relative velocity, reused for the same reason. */
const scratchPort = new Vector3();
const scratchRelVel = new Vector3();

/**
 * Look for the first ship whose docking port lies within a target's contact radius and
 * record it on the world. Runs after integration, so the pose it tests is the one this
 * step produced, and the speed and spin it records are the ones the ship arrived with.
 * Does nothing once a contact exists: the first contact is the one the run is judged on.
 * Allocation-free; one squared distance per ship x target on the no-contact path.
 */
function detectContact(world: World): void {
  if (world.contact !== null) return;
  const { ships, targets } = world;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    dockingPortPosition(ship, scratchPort);
    for (let j = 0; j < targets.length; j++) {
      const target = targets[j]!;
      if (scratchPort.distanceToSquared(target.position) > target.radius * target.radius) continue;
      scratchRelVel.copy(ship.body.velocity).sub(target.velocity);
      world.contact = {
        targetIndex: j,
        relativeSpeed: scratchRelVel.length(),
        residualRotationDegPerSec: ship.body.angularVelocity.length() * RAD_TO_DEG,
        time: world.time,
      };
      return;
    }
  }
}

/**
 * Decide the run from what the step just produced, and freeze it if it is over.
 *
 * A contact is judged on the numbers recorded at the instant it happened, against the
 * limits above. Without a contact, a pilot at zero health is a blackout. A contact and
 * a blackout on the same step read as the contact: the ship arrived, and how it arrived
 * is the more specific verdict. The summary is taken from the player's ship (ships[0]),
 * which is the ship the renderer and HUD already assume.
 *
 * Throttles are closed at the outcome so nothing downstream — plumes, the thruster
 * schematic — shows a frozen ship as still firing. The command keeps arriving from the
 * input layer; the frozen step simply never applies it.
 */
function resolveOutcome(world: World): void {
  const { contact } = world;
  if (contact !== null) {
    const clean =
      contact.relativeSpeed <= DOCK_MAX_SPEED &&
      contact.residualRotationDegPerSec <= DOCK_MAX_ROTATION_DEG_PER_SEC;
    endRun(world, clean ? 'dock' : 'crash', contact);
    return;
  }
  for (const ship of world.ships) {
    if (ship.pilot && ship.pilot.health <= 0) {
      endRun(world, 'blackout', null);
      return;
    }
  }
}

function endRun(world: World, outcome: RunOutcome, contact: Contact | null): void {
  const player = world.ships[0];
  const summary: RunSummary = {
    time: world.time,
    propellantUsed: player ? player.spec.propellantCapacity - player.propellant : 0,
    peakG: player?.pilot?.peakG ?? 0,
  };
  if (contact !== null) {
    summary.contactSpeed = contact.relativeSpeed;
    summary.contactRotation = contact.residualRotationDegPerSec;
  }
  world.outcome = outcome;
  world.summary = summary;
  for (const ship of world.ships) {
    ship.throttles.fill(0);
    // integrate() will not run again, so `previous` would stay a step behind the final
    // pose and the renderer's alpha lerp would wobble a frozen ship by up to one step of
    // travel every frame. Pin it to the pose the run ended on.
    ship.body.previous.position.copy(ship.body.position);
    ship.body.previous.orientation.copy(ship.body.orientation);
  }
}

/**
 * Advance the whole world by exactly `dt` seconds. Never call with a variable dt.
 *
 * Order is load-bearing. Mass is read fresh at the top of every step and the
 * propellant burn is subtracted only AFTER integration, so a ship accelerates
 * harder as its tanks empty instead of coasting on a mass cached at load time.
 *
 * A decided run is frozen: no throttles applied, no integration, no burn, no pilot
 * pass. Only the clock advances, because the HUD's lag and the blackout fade are
 * driven off world.time and must keep settling on the final frame. Restarting is a
 * later issue; this function never un-freezes a world.
 */
export function step(world: World, command: Command, dt: number): void {
  if (world.outcome !== null) {
    world.time += dt;
    return;
  }

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
      // Peak for the run summary (#26): tracked here rather than in stepPilot, which
      // owns the tolerance dynamics and nothing else.
      if (pilot.gLoad > pilot.peakG) pilot.peakG = pilot.gLoad;
    }
  }

  world.time += dt;

  // 6. contact (#25): tested against the pose the integration above just produced, and
  //    stamped with the time that pose belongs to, which is why this follows the clock.
  detectContact(world);

  // 7. outcome (#26): a contact is judged at once, on the numbers it was recorded with;
  //    otherwise a pilot at zero health ends the run. Either freezes every later step.
  resolveOutcome(world);

  assertWithinPlaySpace(world);
}
