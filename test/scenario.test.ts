import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import {
  generateScenario, applyScenario, rng, noseToward, turnedOff, HEADING_OFF_DEG, START_ROLL_DEG,
  START_RANGE, START_CONE_DEG, ASTEROID_COUNT, ASTEROID_RADIUS, START_CLEARANCE, PORT_CLEARANCE, ROCK_SPIN_DEG,
} from '../src/sim/scenario';
import { createWorld, resetRun, step, STEP, structureStrike, obstacleStrike, type StructureSpec } from '../src/sim/world';
import { createShip, type ShipSpec } from '../src/sim/ship';
import { emptyCommand } from '../src/control';
import { summaryFields, freshSummaryFields } from '../src/hud/instruments/summary';
import { asteroidStrokes, asteroidGeometry, ROCK_MIN_SCALE } from '../src/render/vector';
import skiff from '../src/data/skiff.json';
import capital from '../src/data/capital.json';

const spec = skiff as ShipSpec;
const cspec = capital as StructureSpec;
const NOSE = new Vector3(0, 0, -1);

describe('rng', () => {
  it('is deterministic per seed and uniform-ish', () => {
    const a = rng(42), b = rng(42), c = rng(43);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    const r = rng(7);
    let sum = 0;
    for (let i = 0; i < 20000; i++) { const x = r(); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); sum += x; }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
  });
});

describe('noseToward', () => {
  it('points the nose at the target', () => {
    const from = new Vector3(10, 5, -3);
    const at = new Vector3(-40, 20, 90);
    const q = noseToward(from, at);
    const nose = NOSE.clone().applyQuaternion(q);
    expect(nose.distanceTo(at.clone().sub(from).normalize())).toBeLessThan(1e-9);
    // and keeps the pilot roughly upright: local +Y has a positive world-Y component
    expect(new Vector3(0, 1, 0).applyQuaternion(q).y).toBeGreaterThan(0);
  });
});

describe('generateScenario', () => {
  const seeds = [1, 2, 3, 99, 12345, 0xdeadbeef];

  it('is a pure function of the seed', () => {
    const a = generateScenario(cspec, 12345);
    const b = generateScenario(cspec, 12345);
    expect(a.shipPosition.distanceTo(b.shipPosition)).toBe(0);
    expect(a.assignedPortId).toBe(b.assignedPortId);
    expect(a.obstacles.length).toBe(b.obstacles.length);
    for (let i = 0; i < a.obstacles.length; i++) expect(a.obstacles[i]!.position.distanceTo(b.obstacles[i]!.position)).toBe(0);
    expect(generateScenario(cspec, 12346).shipPosition.distanceTo(a.shipPosition)).toBeGreaterThan(1);
  });

  it('starts 350-450 m from the assigned ring, inside the cone, nose turned off the ring but the Yarrow in view (#60)', () => {
    const offs: number[] = [];
    const clocks: number[] = [];
    for (const seed of seeds) {
      const sc = generateScenario(cspec, seed);
      const world = createWorld([]);
      const ship = createShip(spec);
      world.ships.push(ship);
      applyScenario(world, cspec, sc, ship);
      const port = world.targets[world.assigned]!;
      expect(port.name.endsWith(` ${sc.assignedPortId}`)).toBe(true);
      const d = ship.body.position.distanceTo(port.position);
      expect(d).toBeGreaterThanOrEqual(START_RANGE[0] - 1e-6);
      expect(d).toBeLessThanOrEqual(START_RANGE[1] + 1e-6);
      // within the cone about the port's axis: the ring faces us
      const toShip = ship.body.position.clone().sub(port.position).normalize();
      expect(toShip.dot(port.axis)).toBeGreaterThanOrEqual(Math.cos((START_CONE_DEG * Math.PI) / 180) - 1e-9);
      // the nose is off the ring by HEADING_OFF_DEG, so W alone is not a plan...
      const nose = NOSE.clone().applyQuaternion(ship.body.orientation);
      const toRing = port.position.clone().sub(ship.body.position).normalize();
      const off = (Math.acos(Math.min(1, nose.dot(toRing))) * 180) / Math.PI;
      expect(off).toBeGreaterThanOrEqual(HEADING_OFF_DEG[0] - 1e-6);
      expect(off).toBeLessThanOrEqual(HEADING_OFF_DEG[1] + 1e-6);
      offs.push(off);
      // ...but the Yarrow is still ahead: its centre within the windscreen's half-width
      const toYarrow = world.structures[0]!.position.clone().sub(ship.body.position).normalize();
      expect((Math.acos(Math.min(1, nose.dot(toYarrow))) * 180) / Math.PI).toBeLessThan(50);
      // which way the nose is off, as a clock angle in the frame that faces the ring
      const aim = noseToward(ship.body.position, port.position);
      const rel = nose.clone().applyQuaternion(aim.clone().invert());
      clocks.push(Math.atan2(rel.y, rel.x));
    }
    // the offset and its direction vary from seed to seed: it is not one fixed skew
    expect(Math.max(...offs) - Math.min(...offs)).toBeGreaterThan(3);
    expect(Math.max(...clocks) - Math.min(...clocks)).toBeGreaterThan(1);
  });

  it('turnedOff: the nose moves by the drawn angle, the roll only spins about it, and it is seeded', () => {
    const aim = noseToward(new Vector3(0, 0, 400), new Vector3(0, 0, 0));
    const q = turnedOff(rng(7), aim);
    const nose = NOSE.clone().applyQuaternion(q);
    const aimed = NOSE.clone().applyQuaternion(aim);
    const off = (Math.acos(nose.dot(aimed)) * 180) / Math.PI;
    expect(off).toBeGreaterThanOrEqual(HEADING_OFF_DEG[0]);
    expect(off).toBeLessThanOrEqual(HEADING_OFF_DEG[1]);
    expect(turnedOff(rng(7), aim).equals(q)).toBe(true);
    expect(turnedOff(rng(8), aim).equals(q)).toBe(false);
    // the roll only spins about the nose: the same draws with the roll left out put the nose in the same place
    const n = rng(7);
    const offDrawn = ((HEADING_OFF_DEG[0] + n() * (HEADING_OFF_DEG[1] - HEADING_OFF_DEG[0])) * Math.PI) / 180;
    const clock = n() * Math.PI * 2;
    const rollDrawn = (n() * 2 - 1) * START_ROLL_DEG;
    expect(Math.abs(rollDrawn)).toBeLessThanOrEqual(START_ROLL_DEG);
    const turnOnly = aim.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(Math.cos(clock), Math.sin(clock), 0), offDrawn));
    expect(NOSE.clone().applyQuaternion(turnOnly).distanceTo(nose)).toBeLessThan(1e-9);
    // and the ship's up differs from the turn-only up by exactly the roll
    const up = new Vector3(0, 1, 0);
    const rolled = (Math.acos(Math.min(1, up.clone().applyQuaternion(turnOnly).dot(up.clone().applyQuaternion(q)))) * 180) / Math.PI;
    expect(rolled).toBeCloseTo(Math.abs(rollDrawn), 6);
  });

  it('assigns the port on the side we are nearest: no other port faces us better', () => {
    for (const seed of seeds) {
      const sc = generateScenario(cspec, seed);
      const world = createWorld([]);
      const ship = createShip(spec);
      world.ships.push(ship);
      applyScenario(world, cspec, sc, ship);
      const assigned = world.targets[world.assigned]!;
      const s = world.structures[0]!;
      const fromCentre = ship.body.position.clone().sub(s.position).normalize();
      const facing = assigned.axis.dot(fromCentre);
      // every port's outward normal faces our bearing no better than the assigned one's
      // does (ties are fine: a row of ports shares a normal)
      for (const t of world.targets) expect(t.axis.dot(fromCentre)).toBeLessThanOrEqual(facing + 1e-6);
      expect(facing).toBeGreaterThan(0);
    }
  });

  it('scatters rocks clear of the start, every ring, and the hull', () => {
    for (const seed of seeds) {
      const sc = generateScenario(cspec, seed);
      expect(sc.obstacles.length).toBe(ASTEROID_COUNT);
      const world = createWorld([]);
      const ship = createShip(spec);
      world.ships.push(ship);
      applyScenario(world, cspec, sc, ship);
      const s = world.structures[0]!;
      for (const o of sc.obstacles) {
        expect(o.radius).toBeGreaterThanOrEqual(ASTEROID_RADIUS[0]);
        expect(o.radius).toBeLessThanOrEqual(ASTEROID_RADIUS[1]);
        expect(o.position.distanceTo(ship.body.position)).toBeGreaterThanOrEqual(START_CLEARANCE + o.radius);
        for (const t of world.targets) expect(o.position.distanceTo(t.position)).toBeGreaterThanOrEqual(PORT_CLEARANCE + o.radius);
        expect(structureStrike(s, o.position, o.radius + 6)).toBeNull();
        expect(obstacleStrike(o, ship.body.position, spec.hullRadius!)).toBe(false);
      }
      // no two rocks overlap
      for (let i = 0; i < sc.obstacles.length; i++) for (let j = i + 1; j < sc.obstacles.length; j++) {
        const a = sc.obstacles[i]!, b = sc.obstacles[j]!;
        expect(a.position.distanceTo(b.position)).toBeGreaterThan(a.radius + b.radius);
      }
    }
  });

  it('spreads assignments across rows and fore/aft, not just the first row', () => {
    const ids = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) ids.add(generateScenario(cspec, seed).assignedPortId);
    // twenty ports; sixty seeds should reach well beyond the four in the first row
    expect(ids.size).toBeGreaterThan(8);
    expect([...ids].some((id) => id.startsWith('A'))).toBe(true);
  });

  it('applyScenario twice reuses the structure and replaces the rocks', () => {
    const world = createWorld([]);
    const ship = createShip(spec);
    world.ships.push(ship);
    applyScenario(world, cspec, generateScenario(cspec, 1), ship);
    const targetsBefore = world.targets.length;
    resetRun(world);
    applyScenario(world, cspec, generateScenario(cspec, 2), ship);
    expect(world.structures.length).toBe(1);
    expect(world.targets.length).toBe(targetsBefore);
    expect(world.obstacles.length).toBe(ASTEROID_COUNT);
    expect(world.outcome).toBeNull();
  });
});

describe('rocks tumble', () => {
  it('each rock turns slowly about its own axis, and the field is never in sync', () => {
    const world = createWorld([]);
    const ship = createShip(spec);
    world.ships.push(ship);
    applyScenario(world, cspec, generateScenario(cspec, 11), ship);
    const rocks = world.obstacles;
    const rates = rocks.map((o) => (o.spin.length() * 180) / Math.PI);
    for (const r of rates) {
      expect(r).toBeGreaterThanOrEqual(ROCK_SPIN_DEG[0] - 1e-9);
      expect(r).toBeLessThanOrEqual(ROCK_SPIN_DEG[1] + 1e-9);
    }
    // axes differ: the largest pairwise alignment among the first ten is well short of parallel
    let maxAlign = 0;
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) {
      maxAlign = Math.max(maxAlign, Math.abs(rocks[i]!.spin.clone().normalize().dot(rocks[j]!.spin.clone().normalize())));
    }
    expect(maxAlign).toBeLessThan(0.99);

    const before = rocks.map((o) => o.orientation.clone());
    const cmd = emptyCommand(ship.prepared.length);
    for (let i = 0; i < 120; i++) step(world, cmd, STEP); // one second
    rocks.forEach((o, i) => {
      // rotated by exactly its rate about its axis: the angle between the two orientations
      const angle = 2 * Math.acos(Math.min(1, Math.abs(before[i]!.dot(o.orientation))));
      expect(angle).toBeCloseTo(o.spin.length(), 5);
      // and the axis is preserved: the world-frame delta (new * old^-1) leaves its own
      // spin vector where it was. three applies quaternions innermost-first, so old^-1
      // goes on first and new second.
      const axis = o.spin.clone().normalize();
      const rotated = axis.clone().applyQuaternion(before[i]!.clone().invert()).applyQuaternion(o.orientation);
      expect(rotated.distanceTo(axis)).toBeLessThan(1e-6);
      expect(o.orientation.length()).toBeCloseTo(1, 9);
    });
  });

  it('stops turning when the run ends', () => {
    const world = createWorld([]);
    const ship = createShip(spec);
    world.ships.push(ship);
    applyScenario(world, cspec, generateScenario(cspec, 11), ship);
    ship.pilot!.health = 0;
    const cmd = emptyCommand(ship.prepared.length);
    step(world, cmd, STEP);
    const frozen = world.obstacles[0]!.orientation.clone();
    for (let i = 0; i < 120; i++) step(world, cmd, STEP);
    expect(world.obstacles[0]!.orientation.equals(frozen)).toBe(true);
  });
});

describe('rocks are solid', () => {
  it('flying into one is STRUCK ASTEROID', () => {
    const world = createWorld([]);
    const ship = createShip(spec);
    world.ships.push(ship);
    applyScenario(world, cspec, generateScenario(cspec, 5), ship);
    const rock = world.obstacles[0]!;
    // park just outside it and drift in
    const dir = new Vector3(1, 0, 0);
    ship.body.position.copy(rock.position).addScaledVector(dir, rock.radius + spec.hullRadius! + 0.5);
    ship.body.velocity.copy(dir).multiplyScalar(-1);
    const cmd = emptyCommand(ship.prepared.length);
    for (let i = 0; i < 200; i++) step(world, cmd, STEP);
    expect(world.contact?.kind).toBe('hull');
    expect(world.contact?.struck).toBe('asteroid');
    expect(world.outcome).toBe('crash');
    expect(summaryFields(world, freshSummaryFields())!.headline).toBe('STRUCK ASTEROID');
  });
});

describe('asteroid strokes', () => {
  it('is a lumpy polyhedron that fits inside its collision sphere', () => {
    const seg = asteroidStrokes(10, 4242);
    expect(seg.length % 6).toBe(0);
    expect(seg.length / 6).toBeGreaterThan(40); // a faceted rock, not a few circles
    let maxR = 0, minR = Infinity;
    for (let i = 0; i < seg.length; i += 3) {
      const r = Math.hypot(seg[i]!, seg[i + 1]!, seg[i + 2]!);
      maxR = Math.max(maxR, r);
      minR = Math.min(minR, r);
    }
    expect(maxR).toBeLessThanOrEqual(10 + 1e-6);      // never outside what the sim judges
    expect(maxR).toBeGreaterThan(8);                    // but uses most of it
    expect(minR).toBeGreaterThanOrEqual(10 * ROCK_MIN_SCALE * 0.78 - 1e-6); // dents and squash bounded
    expect(maxR - minR).toBeGreaterThan(1);             // visibly irregular
  });

  it('is dented: concave somewhere, on every seed (#49 drew back from convex hulls)', () => {
    for (const seed of [1, 2, 3, 77, 4242]) {
      const g = asteroidGeometry(10, seed);
      const p = g.getAttribute('position');
      const verts: Vector3[] = [];
      for (let i = 0; i < p.count; i++) verts.push(new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      // some triangle's plane has a vertex on its outer side
      let concave = false;
      for (let i = 0; i + 2 < p.count && !concave; i += 3) {
        const a = verts[i]!, b = verts[i + 1]!, c = verts[i + 2]!;
        const n = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
        const d = n.dot(a);
        concave = verts.some((v) => n.dot(v) - d > 1e-3);
      }
      expect(concave).toBe(true);
      g.dispose();
    }
  });

  it('is the same rock for the same seed and a different rock for another', () => {
    const a = asteroidStrokes(10, 1), b = asteroidStrokes(10, 1), c = asteroidStrokes(10, 2);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('every rock in a scenario carries its own shape seed', () => {
    const sc = generateScenario(cspec, 9);
    expect(new Set(sc.obstacles.map((o) => o.seed)).size).toBeGreaterThan(ASTEROID_COUNT * 0.9);
  });
});
