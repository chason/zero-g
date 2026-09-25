import { netWrench, massFlow, currentMass, dockingPortPosition, resetShip, type Ship } from './ship';
import { integrate, feltAcceleration, type Wrench } from './body';
import { stepPilot } from './pilot';
import { Vector3, Quaternion, G0 } from '../core/math';
import type { Command } from '../control';

/** One cylindrical section of a structure's hull, along its local +Z, metres from its origin. */
export interface HullSection {
  radius: number;
  from: number;
  to: number;
  label?: string;
  /** degrees per second about the structure's axis; a turning section. Visual only — see spinAngle. */
  spinDegPerSec?: number;
}

/** A docking port as it appears in a structure's data file, in the structure's frame. */
export interface PortSpec {
  id: string;
  /** on the hull surface */
  position: [number, number, number];
  /** unit, pointing out of the hull */
  normal: [number, number, number];
  radius: number;
  tube: number;
  /** metres the ring stands proud of the hull on its collar */
  collar: number;
}

/** A capital ship or station as it appears in a data file. */
export interface StructureSpec {
  name: string;
  hull: HullSection[];
  ports: PortSpec[];
}

/**
 * Something big and solid the ports are mounted on. Its hull is cylinders along its
 * own local +Z; `orientation` takes local to world. Striking it is a crash. #42.
 */
export interface Structure {
  name: string;
  position: Vector3;
  orientation: Quaternion;
  velocity: Vector3;
  hull: HullSection[];
  /** indices into world.targets of the ports mounted on this structure */
  ports: number[];
  /**
   * Current angle of each section about the axis, radians, parallel to `hull`. Only
   * sections with spinDegPerSec move. A cylinder turning about its own axis is the same
   * cylinder to the strike test, so this is render state kept by the sim so that it
   * freezes with the run and is reproducible. Ports on a turning section are refused
   * by addStructure (#45) until they are made to turn with it.
   */
  spinAngle: number[];
}

/**
 * A docking port: something the HUD can point at and the pilot can dock with. The ring
 * has a back — the structure is behind it — so it can only be entered from the open
 * side, and that is enforced by geometry, not by a rule.
 */
export interface Target {
  name: string;
  /** world frame, metres: the centre of the ring */
  position: Vector3;
  /** world frame, m/s */
  velocity: Vector3;
  /** unit vector, world frame, pointing OUT of the ring toward the open side */
  axis: Vector3;
  /** ring radius, metres; a port inside this (less the tube) is through the hoop */
  radius: number;
  /** ring tube radius, metres; the hoop itself is solid */
  tube: number;
  /** index into world.structures, or -1 for a free-floating ring */
  structure: number;
  /** metres from the hull surface to the ring plane, for drawing the collar */
  collar: number;
}

/** A free-floating ring with nothing behind it — for tests and fixtures. */
export function createPort(name: string, position: Vector3, axis: Vector3, radius = 3, tube = 0.18): Target {
  return { name, position: position.clone(), velocity: new Vector3(), axis: axis.clone().normalize(), radius, tube, structure: -1, collar: 0 };
}

/**
 * Add a structure to the world, placed so that the port named `portId` has its ring
 * centred at `ringPosition` facing `ringAxis`. `rollDeg` then turns the structure
 * about that axis, since facing alone leaves it free to spin — 0 is whatever the
 * shortest rotation gives. Returns the structure index and the target index of that port.
 */
export function placeStructure(
  world: World,
  spec: StructureSpec,
  portId: string,
  ringPosition: Vector3,
  ringAxis: Vector3,
  rollDeg = 0,
): { structure: number; port: number } {
  const anchor = spec.ports.find((p) => p.id === portId);
  if (!anchor) throw new Error(`structure ${spec.name} has no port ${portId}`);
  const axis = ringAxis.clone().normalize();
  const facing = new Quaternion().setFromUnitVectors(new Vector3(...anchor.normal).normalize(), axis);
  const roll = new Quaternion().setFromAxisAngle(axis, (rollDeg * Math.PI) / 180);
  const orientation = roll.multiply(facing);
  const anchorRing = new Vector3(...anchor.position).addScaledVector(new Vector3(...anchor.normal).normalize(), anchor.collar);
  const position = ringPosition.clone().sub(anchorRing.applyQuaternion(orientation));
  return addStructure(world, spec, position, orientation, portId);
}

/**
 * Add a structure at a pose given directly. Every port becomes a target. Returns the
 * structure index and, if `portId` names one of its ports, that port's target index.
 */
export function addStructure(
  world: World,
  spec: StructureSpec,
  position: Vector3,
  orientation: Quaternion,
  portId?: string,
): { structure: number; port: number } {
  for (const p of spec.ports) {
    const z = p.position[2];
    const on = spec.hull.find((h) => z >= h.from && z <= h.to && (h.spinDegPerSec ?? 0) !== 0);
    if (on) throw new Error(`port ${p.id} sits on turning section "${on.label ?? 'hull'}"; ports on turning sections are not supported yet`);
  }
  const structureIndex = world.structures.length;
  const structure: Structure = {
    name: spec.name,
    position,
    orientation,
    velocity: new Vector3(),
    hull: spec.hull.map((h) => ({ ...h })),
    ports: [],
    spinAngle: spec.hull.map(() => 0),
  };
  world.structures.push(structure);

  let anchorTarget = -1;
  for (const p of spec.ports) {
    const normal = new Vector3(...p.normal).normalize();
    const local = new Vector3(...p.position).addScaledVector(normal, p.collar);
    const target: Target = {
      name: `${spec.name} ${p.id}`,
      position: local.applyQuaternion(orientation).add(position),
      velocity: new Vector3(),
      axis: normal.clone().applyQuaternion(orientation),
      radius: p.radius,
      tube: p.tube,
      structure: structureIndex,
      collar: p.collar,
    };
    const idx = world.targets.length;
    world.targets.push(target);
    structure.ports.push(idx);
    if (p.id === portId) anchorTarget = idx;
  }
  return { structure: structureIndex, port: anchorTarget };
}

/**
 * A rock. Judged as a sphere of `radius`; drawn as a lumpy polyhedron that fits inside
 * that sphere, shaped by `seed` and tumbled by `orientation`.
 */
export interface Obstacle {
  name: string;
  position: Vector3;
  radius: number;
  orientation: Quaternion;
  seed: number;
}

/** How the run ended in contact: through the ring, or into something solid. */
export type ContactKind = 'ring' | 'hull';

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
  /** 'ring' = the port passed the ring plane inside the hoop; 'hull' = a solid strike */
  kind: ContactKind;
  /** for 'hull': which section (or 'ring' for the hoop itself) */
  struck?: string;
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
export type RunOutcome = 'dock' | 'crash' | 'blackout' | 'wrong-port';

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
  /** for a crash into something solid: what was hit */
  struck?: string;
  /** for a wrong-port dock: the port that was entered */
  port?: string;
}

export interface World {
  ships: Ship[];
  /** all selectable targets (docking ports); Tab cycles (#21) */
  targets: Target[];
  /** index into targets, or -1 for none */
  selected: number;
  /** the port this run must dock at, or -1 for any (#42) */
  assigned: number;
  /** the solid things ports are mounted on */
  structures: Structure[];
  /** rocks; touching one is a crash (#43) */
  obstacles: Obstacle[];
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

/**
 * Start the run over without rebuilding anything. Ships reset in place, the clock and
 * every per-run record clear; targets and the selection are exactly as they were.
 * Legal at any time, not only after an outcome — bailing out of a bad approach is a
 * normal use. Issue #34.
 */
export function resetRun(world: World): void {
  for (const ship of world.ships) resetShip(ship);
  world.time = 0;
  world.contact = null;
  world.outcome = null;
  world.summary = null;
}

export function createWorld(ships: Ship[] = []): World {
  return { ships, targets: [], selected: -1, assigned: -1, structures: [], obstacles: [], time: 0, contact: null, outcome: null, summary: null };
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
/** Hull radius to use for a ship whose spec does not give one. */
const DEFAULT_HULL_RADIUS = 2.5;
/** The port must be this far inside the hoop's inner edge to count as through it. */
export const RING_CLEARANCE = 0.2;
/** The port counts as at the ring plane within this axial distance of it. */
export const RING_PLANE_TOLERANCE = 0.5;

const scratchRel = new Vector3();

/**
 * Position `p` in a target's frame: `axial` is metres BEHIND the ring plane (negative on
 * the open side), `radial` is distance from the axis. Writes nothing; returns via out.
 */
export function targetFrame(target: Target, p: Vector3, out: { axial: number; radial: number }): void {
  scratchRel.copy(p).sub(target.position);
  const along = scratchRel.dot(target.axis);
  out.axial = -along;
  scratchRel.addScaledVector(target.axis, -along);
  out.radial = scratchRel.length();
}

const frameCom = { axial: 0, radial: 0 };
const framePort = { axial: 0, radial: 0 };

const scratchLocal = new Vector3();
const scratchZero = new Vector3();
const scratchInv = new Quaternion();

/**
 * A solid strike against a structure: the ship's hull sphere overlapping a hull
 * section. Measured in the structure's own frame. Returns the section label, or null.
 */
export function structureStrike(structure: Structure, com: Vector3, shipRadius: number): string | null {
  scratchInv.copy(structure.orientation).invert();
  scratchLocal.copy(com).sub(structure.position).applyQuaternion(scratchInv);
  const axial = scratchLocal.z;
  const radial = Math.hypot(scratchLocal.x, scratchLocal.y);
  for (const section of structure.hull) {
    if (axial < section.from - shipRadius || axial > section.to + shipRadius) continue;
    if (radial <= section.radius + shipRadius) return section.label ?? 'hull';
  }
  return null;
}

/** A rock is a sphere: overlapping it with the ship's hull sphere is a strike. */
export function obstacleStrike(obstacle: Obstacle, com: Vector3, shipRadius: number): boolean {
  const reach = obstacle.radius + shipRadius;
  return com.distanceToSquared(obstacle.position) <= reach * reach;
}

/** The hoop of a port is solid: the ship's hull sphere touching its tube is a strike. */
export function ringStrike(target: Target, com: Vector3, shipRadius: number): boolean {
  targetFrame(target, com, frameCom);
  if (Math.abs(frameCom.axial) > shipRadius + target.tube) return false;
  return Math.abs(frameCom.radial - target.radius) <= target.tube + shipRadius;
}

/**
 * The port through the hoop: at the ring plane, inside the hoop with clearance, and
 * the ship on the open side — which nose-first approach guarantees, since the port
 * leads the centre of mass; a backwards ship has already struck the hull.
 */
export function throughRing(target: Target, port: Vector3, com: Vector3): boolean {
  targetFrame(target, port, framePort);
  if (Math.abs(framePort.axial) > RING_PLANE_TOLERANCE) return false;
  if (framePort.radial > target.radius - target.tube - RING_CLEARANCE) return false;
  targetFrame(target, com, frameCom);
  return frameCom.axial < 0;
}

function recordContact(world: World, ship: Ship, targetIndex: number, relativeTo: Vector3, kind: ContactKind, struck?: string): void {
  scratchRelVel.copy(ship.body.velocity).sub(relativeTo);
  world.contact = {
    targetIndex,
    kind,
    ...(struck !== undefined ? { struck } : {}),
    relativeSpeed: scratchRelVel.length(),
    residualRotationDegPerSec: ship.body.angularVelocity.length() * RAD_TO_DEG,
    time: world.time,
  };
}

function detectContact(world: World): void {
  if (world.contact !== null) return;
  const { ships, targets, structures, obstacles } = world;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    const shipRadius = ship.spec.hullRadius ?? DEFAULT_HULL_RADIUS;
    dockingPortPosition(ship, scratchPort);
    for (let k = 0; k < obstacles.length; k++) {
      if (obstacleStrike(obstacles[k]!, ship.body.position, shipRadius)) {
        recordContact(world, ship, world.assigned, scratchZero, 'hull', obstacles[k]!.name);
        return;
      }
    }
    // Strikes are judged before any ring, so clipping a hoop or the hull on the way in
    // is a crash, not a dock.
    for (let k = 0; k < structures.length; k++) {
      const structure = structures[k]!;
      const struck = structureStrike(structure, ship.body.position, shipRadius);
      if (struck !== null) {
        recordContact(world, ship, structure.ports[0] ?? -1, structure.velocity, 'hull', struck);
        return;
      }
    }
    for (let j = 0; j < targets.length; j++) {
      const target = targets[j]!;
      if (ringStrike(target, ship.body.position, shipRadius)) {
        recordContact(world, ship, j, target.velocity, 'hull', 'ring');
        return;
      }
    }
    for (let j = 0; j < targets.length; j++) {
      const target = targets[j]!;
      if (throughRing(target, scratchPort, ship.body.position)) {
        recordContact(world, ship, j, target.velocity, 'ring');
        return;
      }
    }
  }
}

function resolveOutcome(world: World): void {
  const { contact } = world;
  if (contact !== null) {
    if (contact.kind === 'hull') {
      endRun(world, 'crash', contact);
      return;
    }
    const clean =
      contact.relativeSpeed <= DOCK_MAX_SPEED &&
      contact.residualRotationDegPerSec <= DOCK_MAX_ROTATION_DEG_PER_SEC;
    if (!clean) {
      endRun(world, 'crash', contact);
      return;
    }
    // A clean entry into a port that is not the assigned one is its own failure: the
    // flying was fine, the navigation was not.
    const wrongPort = world.assigned >= 0 && contact.targetIndex !== world.assigned;
    endRun(world, wrongPort ? 'wrong-port' : 'dock', contact);
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
    if (contact.kind === 'hull') summary.struck = contact.struck ?? 'hull';
    if (outcome === 'wrong-port') summary.port = world.targets[contact.targetIndex]?.name ?? 'unknown';
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

  // Turning sections (#45): angle only. A cylinder about its own axis is the same
  // cylinder to the strike test, so the geometry below does not change.
  for (const structure of world.structures) {
    for (let i = 0; i < structure.hull.length; i++) {
      const rate = structure.hull[i]!.spinDegPerSec;
      if (rate) structure.spinAngle[i] = (structure.spinAngle[i]! + ((rate * Math.PI) / 180) * dt) % (Math.PI * 2);
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
