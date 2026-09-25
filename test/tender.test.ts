import { describe, it, expect } from 'vitest';
import { Vector3 } from '../src/core/math';
import {
  createWorld, createTarget, step, STEP, hullStrike, throughRing, targetFrame,
  type TenderSpec, type World,
} from '../src/sim/world';
import { createShip, dockingPortPosition, type ShipSpec, type Ship } from '../src/sim/ship';
import { emptyCommand } from '../src/control';
import { summaryFields, freshSummaryFields } from '../src/hud/instruments/summary';
import { tenderHullStrokes, cylinderStrokes } from '../src/render/vector';
import skiff from '../src/data/skiff.json';
import tender from '../src/data/tender.json';

const spec = skiff as ShipSpec;
const tspec = tender as TenderSpec;
const RING = new Vector3(0, 0, -400);
const OPEN = new Vector3(0, 0, 1); // the open side faces +Z, toward where the Skiff starts

function tenderAt(pos = RING, axis = OPEN) { return createTarget(tspec, pos, axis); }

function worldWithShipAt(position: Vector3, velocity = new Vector3(), yawDeg = 0): { world: World; ship: Ship } {
  const ship = createShip(spec);
  ship.body.position.copy(position);
  ship.body.velocity.copy(velocity);
  if (yawDeg) ship.body.orientation.setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  const world = createWorld([ship]);
  world.targets.push(tenderAt());
  world.selected = 0;
  return { world, ship };
}

function run(world: World, steps: number) {
  const cmd = emptyCommand(world.ships[0]!.prepared.length);
  for (let i = 0; i < steps; i++) step(world, cmd, STEP);
}

describe('the tender has sides', () => {
  it('targetFrame measures behind the ring plane as positive axial', () => {
    const t = tenderAt();
    const f = { axial: 0, radial: 0 };
    targetFrame(t, new Vector3(0, 0, -390), f); // 10 m on the open side
    expect(f.axial).toBeCloseTo(-10, 9);
    expect(f.radial).toBeCloseTo(0, 9);
    targetFrame(t, new Vector3(2, 0, -410), f); // 10 m behind, 2 m off axis
    expect(f.axial).toBeCloseTo(10, 9);
    expect(f.radial).toBeCloseTo(2, 9);
  });

  it('the data file describes a hull that extends behind the ring only', () => {
    expect(tspec.hull.length).toBeGreaterThan(0);
    for (const h of tspec.hull) {
      expect(h.from).toBeGreaterThanOrEqual(0);
      expect(h.to).toBeGreaterThan(h.from);
    }
    // the neck starts behind the ring plane and is narrower than the hoop: the port can
    // pass the hoop without the Skiff's hull touching anything
    expect(tspec.hull[0]!.radius).toBeLessThan(tspec.ring.radius - tspec.ring.tube);
  });
});

describe('strikes', () => {
  const R = spec.hullRadius!;

  it('the Skiff inside the main body is a strike, naming the section', () => {
    const t = tenderAt();
    expect(hullStrike(t, new Vector3(0, 0, -400 - 15), R)).toBe('body');
    expect(hullStrike(t, new Vector3(0, 0, -400 - 4), R)).toBe('neck');
    expect(hullStrike(t, new Vector3(0, 0, -400 - 30), R)).toBe('tail');
  });

  it('clear of every section is no strike', () => {
    const t = tenderAt();
    expect(hullStrike(t, new Vector3(0, 0, -380), R)).toBeNull();            // open side, on axis
    expect(hullStrike(t, new Vector3(4.6 + R + 0.5, 0, -415), R)).toBeNull(); // beside the body, just clear
    expect(hullStrike(t, new Vector3(0, 0, -400 - 33 - R - 0.1), R)).toBeNull(); // past the tail
  });

  it('the hoop itself is solid: a hull touching the tube is a strike', () => {
    const t = tenderAt();
    // At the moment of docking the centre of mass is a port-length on the open side.
    const comZ = -400 + Math.abs(spec.dockingPort[2]);
    // 3 m off axis there: the hull overlaps the tube
    expect(hullStrike(t, new Vector3(3, 0, comZ), R)).toBe('ring');
    // on the axis there: inside the hoop, clear of the tube (3 - 0.18 > 2.6) and of the neck
    expect(hullStrike(t, new Vector3(0, 0, comZ), R)).toBeNull();
    // whereas a hull centred IN the plane does reach the neck, which starts 0.6 m behind it
    expect(hullStrike(t, new Vector3(0, 0, -400), R)).toBe('neck');
  });
});

describe('through the ring', () => {
  it('the port at the plane, inside the hoop, ship on the open side: through', () => {
    const t = tenderAt();
    expect(throughRing(t, new Vector3(0, 0, -400), new Vector3(0, 0, -397.4))).toBe(true);
    expect(throughRing(t, new Vector3(1.5, 0.5, -400.3), new Vector3(1.5, 0.5, -397.7))).toBe(true);
  });
  it('not through: port short of the plane, or too close to the tube, or ship behind', () => {
    const t = tenderAt();
    expect(throughRing(t, new Vector3(0, 0, -398), new Vector3(0, 0, -395.4))).toBe(false); // 2 m short
    expect(throughRing(t, new Vector3(2.9, 0, -400), new Vector3(2.9, 0, -397.4))).toBe(false); // grazing the tube
    expect(throughRing(t, new Vector3(0, 0, -400), new Vector3(0, 0, -402.6))).toBe(false); // ship behind the plane
  });
});

describe('flown approaches', () => {
  it('nose-first from the open side docks cleanly', () => {
    const { world } = worldWithShipAt(new Vector3(0, 0, -390), new Vector3(0, 0, -0.3));
    run(world, 3000);
    expect(world.contact?.kind).toBe('ring');
    expect(world.outcome).toBe('dock');
  });

  it('coming in fast is still a crash, and the summary shows the speed', () => {
    const { world } = worldWithShipAt(new Vector3(0, 0, -390), new Vector3(0, 0, -3));
    run(world, 400);
    expect(world.contact?.kind).toBe('ring');
    expect(world.outcome).toBe('crash');
    expect(world.summary?.struck).toBeUndefined();
  });

  it('approaching from behind never reaches the ring: the tail is in the way', () => {
    // start 60 m behind the tender, flying toward the ring along +Z
    const { world } = worldWithShipAt(new Vector3(0, 0, -460), new Vector3(0, 0, 2));
    run(world, 3000);
    expect(world.contact?.kind).toBe('hull');
    expect(world.contact?.struck).toBe('tail');
    expect(world.outcome).toBe('crash');
    const f = freshSummaryFields();
    expect(summaryFields(world, f)!.headline).toBe('STRUCK TAIL');
  });

  it('missing the hoop and hitting the body is a strike, however slow', () => {
    // 4 m off axis, drifting in at 0.1 m/s: passes beside the hoop and meets the body
    const { world } = worldWithShipAt(new Vector3(4, 0, -395), new Vector3(0, 0, -0.1));
    run(world, 30000);
    expect(world.contact?.kind).toBe('hull');
    expect(world.outcome).toBe('crash');
  });

  it('a strike is judged before the ring, so clipping the hoop on the way in is a crash', () => {
    // port aimed just inside the hoop but the hull overlaps the tube
    const { world, ship } = worldWithShipAt(new Vector3(2.75, 0, -390), new Vector3(0, 0, -0.5));
    run(world, 4000);
    expect(world.contact).not.toBeNull();
    expect(world.contact!.kind).toBe('hull');
    expect(world.contact!.struck).toBe('ring');
    void ship;
  });
});

describe('tender strokes', () => {
  it('a cylinder is hoops at both ends plus longitudes, along -Z', () => {
    const out: number[] = [];
    cylinderStrokes(2, 1, 9, out, 8, 4, 24);
    // length 8 at 4 m spacing -> 3 hoops of 24 segments, + 8 longitudes
    expect(out.length / 6).toBe(3 * 24 + 8);
    const zs = new Set<number>();
    for (let i = 2; i < out.length; i += 3) zs.add(Math.round(out[i]! * 1000) / 1000);
    expect([...zs].every((z) => z <= -1 && z >= -9)).toBe(true);
  });
  it('the tender hull is one stroke buffer covering every section, with spokes at radius steps', () => {
    const seg = tenderHullStrokes(tspec.hull);
    expect(seg.length % 6).toBe(0);
    expect(seg.length / 6).toBeGreaterThan(100);
    // nothing on the open side of the ring plane
    for (let i = 2; i < seg.length; i += 3) expect(seg[i]).toBeLessThanOrEqual(0);
  });
});
