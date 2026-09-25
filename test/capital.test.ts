import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from '../src/core/math';
import {
  createWorld, placeStructure, createPort, step, STEP,
  structureStrike, ringStrike, throughRing, targetFrame,
  type StructureSpec, type World,
} from '../src/sim/world';
import { createShip, type ShipSpec, type Ship } from '../src/sim/ship';
import { emptyCommand } from '../src/control';
import { summaryFields, freshSummaryFields } from '../src/hud/instruments/summary';
import { hullStrokes, sectionStrokes, portStrokes, cylinderStrokes } from '../src/render/vector';
import skiff from '../src/data/skiff.json';
import capital from '../src/data/capital.json';

const spec = skiff as ShipSpec;
const cspec = capital as StructureSpec;
const RING = new Vector3(0, 0, -400);
const OPEN = new Vector3(0, 0, 1);
const R = spec.hullRadius!;

function capitalWorld(assignedId = 'F6'): World {
  const world = createWorld([]);
  const { port } = placeStructure(world, cspec, assignedId, RING, OPEN);
  world.assigned = port;
  world.selected = port;
  return world;
}

function withShip(world: World, position: Vector3, velocity = new Vector3()): Ship {
  const ship = createShip(spec);
  ship.body.position.copy(position);
  ship.body.velocity.copy(velocity);
  world.ships.push(ship);
  return ship;
}

function run(world: World, steps: number) {
  const cmd = emptyCommand(world.ships[0]!.prepared.length);
  for (let i = 0; i < steps; i++) step(world, cmd, STEP);
}

describe('the data file', () => {
  it('describes a capital with many ports on the hull surface, facing outward', () => {
    expect(cspec.ports.length).toBeGreaterThan(10);
    for (const p of cspec.ports) {
      const section = cspec.hull.find((h) => p.position[2] >= h.from && p.position[2] <= h.to)!;
      expect(section).toBeDefined();
      const radial = Math.hypot(p.position[0], p.position[1]);
      expect(radial).toBeCloseTo(section.radius, 6);
      // the normal points straight out of the cylinder
      const n = new Vector3(...p.normal);
      expect(n.length()).toBeCloseTo(1, 9);
      expect(n.dot(new Vector3(p.position[0], p.position[1], 0).normalize())).toBeCloseTo(1, 6);
      // a 3 m ring on a 1.5 m collar: the Skiff's hull clears the surface at docking by
      // (collar + port length) - hull radius
      expect(p.collar + Math.abs(spec.dockingPort[2]) - R).toBeGreaterThan(1);
    }
    expect(new Set(cspec.ports.map((p) => p.id)).size).toBe(cspec.ports.length);
  });
});

describe('placeStructure', () => {
  it('puts the anchor port exactly where asked, facing the way asked', () => {
    const world = capitalWorld();
    const port = world.targets[world.assigned]!;
    expect(port.position.distanceTo(RING)).toBeLessThan(1e-9);
    expect(port.axis.distanceTo(OPEN)).toBeLessThan(1e-9);
    expect(port.name).toBe('Yarrow F6');
    expect(port.structure).toBe(0);
    expect(world.structures[0]!.ports.length).toBe(cspec.ports.length);
    expect(world.targets.length).toBe(cspec.ports.length);
  });

  it('carries every other port along rigidly', () => {
    const world = capitalWorld();
    const s = world.structures[0]!;
    for (let i = 0; i < cspec.ports.length; i++) {
      const p = cspec.ports[i]!;
      const t = world.targets[i]!;
      const n = new Vector3(...p.normal);
      const local = new Vector3(...p.position).addScaledVector(n, p.collar);
      const expected = local.applyQuaternion(s.orientation).add(s.position);
      expect(t.position.distanceTo(expected)).toBeLessThan(1e-9);
      expect(t.axis.distanceTo(n.applyQuaternion(s.orientation))).toBeLessThan(1e-9);
      expect(t.axis.length()).toBeCloseTo(1, 9);
    }
  });

  it('the hull surface under the assigned port is collar metres behind its ring', () => {
    const world = capitalWorld();
    const s = world.structures[0]!;
    const f = { axial: 0, radial: 0 };
    // walk 1.5 m into the ring along -axis: that is the hull surface
    const surface = RING.clone().addScaledVector(OPEN, -1.5);
    const inv = s.orientation.clone().invert();
    const local = surface.clone().sub(s.position).applyQuaternion(inv);
    expect(Math.hypot(local.x, local.y)).toBeCloseTo(28, 6); // forebody radius
    void targetFrame;
    void f;
  });
});

describe('strikes in the structure frame', () => {
  it('a ship inside the refinery section is a strike naming it, at any orientation', () => {
    const world = capitalWorld();
    const s = world.structures[0]!;
    const inside = new Vector3(0, 0, 170).applyQuaternion(s.orientation).add(s.position);
    expect(structureStrike(s, inside, R)).toBe('refinery');
    const bow = new Vector3(5, 0, 20).applyQuaternion(s.orientation).add(s.position);
    expect(structureStrike(s, bow, R)).toBe('bow');
  });

  it('just clear of the hull is no strike; the assigned port at docking is clear', () => {
    const world = capitalWorld();
    const s = world.structures[0]!;
    const clear = new Vector3(28 + R + 0.5, 0, 90).applyQuaternion(s.orientation).add(s.position);
    expect(structureStrike(s, clear, R)).toBeNull();
    // centre of mass where it sits when the port meets the ring
    const com = RING.clone().addScaledVector(OPEN, Math.abs(spec.dockingPort[2]));
    expect(structureStrike(s, com, R)).toBeNull();
    expect(ringStrike(world.targets[world.assigned]!, com, R)).toBe(false);
  });

  it('every port hoop is solid', () => {
    const world = capitalWorld();
    for (const t of world.targets) {
      const onTube = t.position.clone().addScaledVector(new Vector3(0, 0, 1).cross(t.axis).normalize(), t.radius);
      expect(ringStrike(t, onTube, R)).toBe(true);
    }
  });
});

describe('the assignment', () => {
  it('docking at the assigned port is a dock', () => {
    const world = capitalWorld();
    withShip(world, RING.clone().addScaledVector(OPEN, 12), OPEN.clone().multiplyScalar(-0.3));
    run(world, 6000);
    expect(world.outcome).toBe('dock');
  });

  it('a clean entry into any other port is WRONG PORT, naming it', () => {
    const world = capitalWorld('F6');
    // fly into F2 instead: place the ship on F2's axis, 12 m out, closing gently
    const f2 = world.targets.find((t) => t.name.endsWith(' F2'))!;
    const f2i = world.targets.indexOf(f2);
    expect(f2i).not.toBe(world.assigned);
    withShip(world, f2.position.clone().addScaledVector(f2.axis, 12), f2.axis.clone().multiplyScalar(-0.3));
    // point the nose down F2's axis so the port leads
    const ship = world.ships[0]!;
    ship.body.orientation.setFromUnitVectors(new Vector3(0, 0, -1), f2.axis.clone().negate());
    run(world, 6000);
    expect(world.contact?.kind).toBe('ring');
    expect(world.contact?.targetIndex).toBe(f2i);
    expect(world.outcome).toBe('wrong-port');
    expect(world.summary?.port).toBe('Yarrow F2');
    const f = freshSummaryFields();
    expect(summaryFields(world, f)!.headline).toBe('WRONG PORT: YARROW F2');
  });

  it('with no assignment, any port docks', () => {
    const world = capitalWorld();
    world.assigned = -1;
    const f2 = world.targets.find((t) => t.name.endsWith(' F2'))!;
    withShip(world, f2.position.clone().addScaledVector(f2.axis, 12), f2.axis.clone().multiplyScalar(-0.3));
    world.ships[0]!.body.orientation.setFromUnitVectors(new Vector3(0, 0, -1), f2.axis.clone().negate());
    run(world, 6000);
    expect(world.outcome).toBe('dock');
  });

  it('a fast entry into the wrong port is still a crash: speed is judged first', () => {
    const world = capitalWorld();
    const f2 = world.targets.find((t) => t.name.endsWith(' F2'))!;
    withShip(world, f2.position.clone().addScaledVector(f2.axis, 12), f2.axis.clone().multiplyScalar(-3));
    world.ships[0]!.body.orientation.setFromUnitVectors(new Vector3(0, 0, -1), f2.axis.clone().negate());
    run(world, 600);
    expect(world.outcome).toBe('crash');
  });
});

describe('the hull blocks the far side', () => {
  it('approaching the assigned port from inside the ship is a strike long before the ring', () => {
    const world = capitalWorld();
    // 15 m behind the ring is inside the forebody (ring at 29.5 m from the axis on a
    // 28 m hull); a ship there flying outward toward the ring strikes at once
    const start = RING.clone().addScaledVector(OPEN, -15);
    withShip(world, start, OPEN.clone().multiplyScalar(2));
    run(world, 1);
    expect(world.contact?.kind).toBe('hull');
    expect(world.contact?.struck).toBe('forebody');
    expect(world.outcome).toBe('crash');
    // and from clear space on the far side, the hull is met long before the ring:
    // start 70 m behind (past the far side of the hull) flying toward the ring
    const w2 = capitalWorld();
    withShip(w2, RING.clone().addScaledVector(OPEN, -70), OPEN.clone().multiplyScalar(2));
    run(w2, 3000);
    expect(w2.contact?.kind).toBe('hull');
    expect(w2.outcome).toBe('crash');
  });
});

describe('turning sections', () => {
  it('the refinery turns at its data rate, its outer drums the other way and faster, nothing else moves, and it freezes with the run (#57)', () => {
    const world = capitalWorld();
    withShip(world, RING.clone().addScaledVector(OPEN, 100));
    const s = world.structures[0]!;
    const i = s.hull.findIndex((h) => h.label === 'refinery');
    expect(s.hull[i]!.spinDegPerSec).toBe(6);
    // the drums either side of it are the same radius, so the seams show the counter-rotation
    const drums = [i - 1, i + 1];
    for (const d of drums) {
      expect(s.hull[d]!.label).toMatch(/refinery .* drum/);
      expect(s.hull[d]!.radius).toBe(s.hull[i]!.radius);
      expect(Math.sign(s.hull[d]!.spinDegPerSec!)).toBe(-Math.sign(s.hull[i]!.spinDegPerSec!));
      expect(Math.abs(s.hull[d]!.spinDegPerSec!)).toBeGreaterThan(Math.abs(s.hull[i]!.spinDegPerSec!));
      expect(Math.abs(s.hull[d]!.spinDegPerSec!)).toBeLessThan(2 * Math.abs(s.hull[i]!.spinDegPerSec!)); // slightly faster, not a blur
    }
    expect(s.hull[i - 1]!.to).toBe(s.hull[i]!.from);
    expect(s.hull[i + 1]!.from).toBe(s.hull[i]!.to);
    expect(s.spinAngle.every((a) => a === 0)).toBe(true);
    run(world, 120); // one second
    expect(s.spinAngle[i]).toBeCloseTo((6 * Math.PI) / 180, 6);
    for (const d of drums) expect(s.spinAngle[d]).toBeCloseTo((s.hull[d]!.spinDegPerSec! * Math.PI) / 180, 6);
    s.spinAngle.forEach((a, k) => { if (k !== i && !drums.includes(k)) expect(a).toBe(0); });
    // a turning cylinder is the same cylinder to the strike test
    const inside = new Vector3(20, 0, 170).applyQuaternion(s.orientation).add(s.position);
    expect(structureStrike(s, inside, R)).toBe('refinery');
    // frozen run: the angle stops
    world.ships[0]!.pilot!.health = 0;
    run(world, 1);
    const frozen = s.spinAngle[i]!;
    run(world, 120);
    expect(s.spinAngle[i]).toBe(frozen);
  });

  it('refuses a port on a turning section, loudly', () => {
    const bad: StructureSpec = {
      ...cspec,
      ports: [...cspec.ports, { id: 'R1', position: [38, 0, 170], normal: [1, 0, 0], radius: 3, tube: 0.18, collar: 1.5 }],
    };
    const world = createWorld([]);
    expect(() => placeStructure(world, bad, 'F6', RING, OPEN)).toThrow(/turning section/);
  });
});

describe('strokes', () => {
  it('cylinderStrokes runs between the signed z values it is given', () => {
    const out: number[] = [];
    cylinderStrokes(2, 10, 30, out, 4, 10, 8);
    const zs = new Set<number>();
    for (let i = 2; i < out.length; i += 3) zs.add(out[i]!);
    expect(Math.min(...zs)).toBe(10);
    expect(Math.max(...zs)).toBe(30);
  });
  it('a port is a ring plus a collar reaching back to the hull surface', () => {
    const withCollar = portStrokes(3, 0.18, 1.5);
    const bare = portStrokes(3, 0.18, 0);
    expect(withCollar.length).toBeGreaterThan(bare.length);
    let minZ = 0;
    for (let i = 2; i < withCollar.length; i += 3) minZ = Math.min(minZ, withCollar[i]!);
    expect(minZ).toBeCloseTo(-1.5, 6);
  });
  it('a skipped section is left out of the hull buffer and drawn on its own', () => {
    const all = hullStrokes(cspec.hull);
    const without = hullStrokes(cspec.hull, 12, 12, 10, new Set([2]));
    const alone = sectionStrokes(cspec.hull[2]!);
    expect(without.length).toBeLessThan(all.length);
    expect(without.length + alone.length).toBe(all.length);
  });

  it('the capital hull is one buffer along +Z with a sane stroke count', () => {
    const seg = hullStrokes(cspec.hull);
    expect(seg.length % 6).toBe(0);
    const n = seg.length / 6;
    expect(n).toBeGreaterThan(500);
    expect(n).toBeLessThan(6000);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < seg.length; i += 3) { minZ = Math.min(minZ, seg[i]!); maxZ = Math.max(maxZ, seg[i]!); }
    expect(minZ).toBe(0);
    expect(maxZ).toBe(320);
  });
});

describe('free-floating port fixture', () => {
  it('createPort has nothing behind it', () => {
    const p = createPort('ring', RING, OPEN);
    expect(p.structure).toBe(-1);
    expect(p.collar).toBe(0);
    void Quaternion;
  });
});
