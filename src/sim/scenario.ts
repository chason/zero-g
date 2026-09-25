import { Vector3, Quaternion, Matrix4 } from '../core/math';
import { rng } from '../core/random';
import { addStructure, createWorld, structureStrike, type World, type StructureSpec, type Obstacle } from './world';
import type { Ship } from './ship';

/**
 * A run's starting situation: where the capital is, which port is ours, where we
 * start, and where the rocks are. Everything comes from one seed, so a start can be
 * reproduced exactly from its number. #43.
 */

/** Distance from the assigned ring to the start, metres. */
export const START_RANGE: readonly [number, number] = [350, 450];
/** The start lies within this half-angle of the port's axis, so the ring faces us. */
export const START_CONE_DEG = 40;
export const ASTEROID_COUNT = 40;
export const ASTEROID_RADIUS: readonly [number, number] = [4, 18];
/** Rocks are scattered inside this radius about the midpoint of the approach. */
export const FIELD_RADIUS = 320;
/** No rock this close to the start, so the first seconds are never a surprise. */
export const START_CLEARANCE = 40;
/** No rock this close to any ring, so every port stays enterable. */
export const PORT_CLEARANCE = 14;

export interface Scenario {
  seed: number;
  structurePosition: Vector3;
  structureOrientation: Quaternion;
  assignedPortId: string;
  shipPosition: Vector3;
  shipOrientation: Quaternion;
  obstacles: Obstacle[];
}

export { rng };

function randomUnit(next: () => number, out: Vector3): Vector3 {
  const z = next() * 2 - 1;
  const t = next() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), r * Math.sin(t), z);
}

/** A unit vector within `halfAngleDeg` of `axis`, uniform over the cap. */
function randomInCone(next: () => number, axis: Vector3, halfAngleDeg: number, out: Vector3): Vector3 {
  const cosMax = Math.cos((halfAngleDeg * Math.PI) / 180);
  const cosT = 1 - next() * (1 - cosMax);
  const sinT = Math.sqrt(1 - cosT * cosT);
  const phi = next() * Math.PI * 2;
  // an orthonormal basis about the axis
  const a = Math.abs(axis.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = new Vector3().crossVectors(axis, a).normalize();
  const v = new Vector3().crossVectors(axis, u);
  return out.copy(axis).multiplyScalar(cosT).addScaledVector(u, sinT * Math.cos(phi)).addScaledVector(v, sinT * Math.sin(phi));
}

/** Orientation whose -Z (the nose) points from `from` to `at`, with +Y kept as up as possible. */
export function noseToward(from: Vector3, at: Vector3): Quaternion {
  const forward = at.clone().sub(from).normalize();
  const up = Math.abs(forward.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const right = new Vector3().crossVectors(forward, up).normalize();
  const trueUp = new Vector3().crossVectors(right, forward);
  // basis columns: right, up, back — the nose (and the camera) look down local -Z
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, trueUp, forward.clone().negate()));
}

/**
 * Build a scenario from a seed. The capital sits at the origin with her length along
 * world X. A random bearing from her picks the port whose outward normal faces it
 * best — the side we are nearest — and the start is then 350–450 m out along that
 * port's axis, within a 40° cone so the ring is in front of us. Rocks fill a field
 * about the approach, kept clear of the start, every ring, and the hull.
 */
export function generateScenario(spec: StructureSpec, seed: number): Scenario {
  const next = rng(seed);
  const structurePosition = new Vector3(0, 0, 0);
  const structureOrientation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(1, 0, 0));

  // Which side are we on? The ports whose normals best face a random bearing — a whole
  // row shares one normal, so among those that tie, one is drawn at random; otherwise
  // the first row in the file would win every run.
  const bearing = randomUnit(next, new Vector3());
  const facing = spec.ports.map((p) => new Vector3(...p.normal).normalize().applyQuaternion(structureOrientation).dot(bearing));
  const bestDot = Math.max(...facing);
  const candidates = spec.ports.filter((_, i) => facing[i]! >= bestDot - 1e-6);
  const best = candidates[Math.floor(next() * candidates.length)]!;
  const normal = new Vector3(...best.normal).normalize().applyQuaternion(structureOrientation);
  const ring = new Vector3(...best.position).addScaledVector(new Vector3(...best.normal).normalize(), best.collar)
    .applyQuaternion(structureOrientation).add(structurePosition);

  const range = START_RANGE[0] + next() * (START_RANGE[1] - START_RANGE[0]);
  const dir = randomInCone(next, normal, START_CONE_DEG, new Vector3());
  const shipPosition = ring.clone().addScaledVector(dir, range);
  const shipOrientation = noseToward(shipPosition, ring);

  // Rocks: a probe world holds the structure so the hull test is the real one.
  const probe = createWorld();
  addStructure(probe, spec, structurePosition, structureOrientation);
  const structure = probe.structures[0]!;
  const rings = probe.targets.map((t) => t.position);

  const centre = ring.clone().lerp(shipPosition, 0.5);
  const obstacles: Obstacle[] = [];
  let attempts = 0;
  while (obstacles.length < ASTEROID_COUNT && attempts < ASTEROID_COUNT * 40) {
    attempts++;
    const radius = ASTEROID_RADIUS[0] + next() * (ASTEROID_RADIUS[1] - ASTEROID_RADIUS[0]);
    const p = randomUnit(next, new Vector3()).multiplyScalar(Math.cbrt(next()) * FIELD_RADIUS).add(centre);
    if (p.distanceTo(shipPosition) < START_CLEARANCE + radius) continue;
    if (rings.some((r) => p.distanceTo(r) < PORT_CLEARANCE + radius)) continue;
    if (structureStrike(structure, p, radius + 6) !== null) continue;
    if (obstacles.some((o) => p.distanceTo(o.position) < o.radius + radius + 4)) continue;
    const orientation = new Quaternion().setFromAxisAngle(randomUnit(next, new Vector3()), next() * Math.PI * 2);
    obstacles.push({ name: 'asteroid', position: p, radius, orientation, seed: Math.floor(next() * 0x7fffffff) });
  }

  return { seed, structurePosition, structureOrientation, assignedPortId: best.id, shipPosition, shipOrientation, obstacles };
}

/**
 * Put a scenario into a world: the structure (once — a second call with the same spec
 * reuses it), the assignment, the ship's start, and the rocks. Call after resetRun.
 */
export function applyScenario(world: World, spec: StructureSpec, scenario: Scenario, ship: Ship): void {
  if (world.structures.length === 0) {
    addStructure(world, spec, scenario.structurePosition, scenario.structureOrientation);
  } else {
    world.structures[0]!.position.copy(scenario.structurePosition);
    world.structures[0]!.orientation.copy(scenario.structureOrientation);
  }
  const port = world.targets.findIndex((t) => t.name.endsWith(` ${scenario.assignedPortId}`));
  world.assigned = port;
  world.selected = port;
  ship.body.position.copy(scenario.shipPosition);
  ship.body.orientation.copy(scenario.shipOrientation);
  ship.body.previous.position.copy(scenario.shipPosition);
  ship.body.previous.orientation.copy(scenario.shipOrientation);
  world.obstacles.length = 0;
  for (const o of scenario.obstacles) world.obstacles.push(o);
}
