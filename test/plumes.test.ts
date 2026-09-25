import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createShip } from '../src/sim/ship';
import type { Ship, ShipSpec } from '../src/sim/ship';
import skiff from '../src/data/skiff.json';
import {
  createPlumes, plumeScale, fadeIntensity,
  PLUME_LENGTH, PLUME_RADIUS, MIN_SCALE, FADE_MS,
} from '../src/render/plumes';

const spec = skiff as ShipSpec;

function rig(ship: Ship = createShip(spec)) {
  const scene = new THREE.Scene();
  const hull = new THREE.Object3D();
  scene.add(hull);
  const plumes = createPlumes(scene, hull);
  return { scene, hull, plumes, ship };
}

function meshes(plumes: ReturnType<typeof createPlumes>): THREE.Mesh[] {
  return plumes.group.children as THREE.Mesh[];
}

function material(m: THREE.Mesh): THREE.MeshBasicMaterial {
  return m.material as THREE.MeshBasicMaterial;
}

function index(ship: Ship, id: string): number {
  const i = ship.prepared.findIndex((t) => t.spec.id === id);
  expect(i, `thruster ${id} exists in skiff.json`).toBeGreaterThanOrEqual(0);
  return i;
}

const Y = new THREE.Vector3(0, 1, 0);

describe('plume geometry from ship.prepared', () => {
  it('builds nothing until the first update, then one plume per thruster in order', () => {
    const { plumes, ship } = rig();
    expect(plumes.group.children).toHaveLength(0);
    plumes.update(ship, 0);
    expect(plumes.group.children).toHaveLength(ship.prepared.length);
    meshes(plumes).forEach((m, i) => {
      expect(m).toBeInstanceOf(THREE.Mesh);
      expect(m.name).toBe(ship.prepared[i]!.spec.id);
    });
  });

  it('places each plume at its thruster position in the hull frame', () => {
    const { plumes, ship } = rig();
    plumes.update(ship, 0);
    meshes(plumes).forEach((m, i) => {
      const [x, y, z] = ship.prepared[i]!.spec.position;
      expect(m.position.x).toBeCloseTo(x, 12);
      expect(m.position.y).toBeCloseTo(y, 12);
      expect(m.position.z).toBeCloseTo(z, 12);
    });
  });

  it('points each plume opposite its thruster direction', () => {
    const { plumes, ship } = rig();
    plumes.update(ship, 0);
    meshes(plumes).forEach((m, i) => {
      const exhaust = Y.clone().applyQuaternion(m.quaternion);
      const want = new THREE.Vector3(...ship.prepared[i]!.spec.direction).normalize().negate();
      expect(exhaust.x, ship.prepared[i]!.spec.id).toBeCloseTo(want.x, 9);
      expect(exhaust.y, ship.prepared[i]!.spec.id).toBeCloseTo(want.y, 9);
      expect(exhaust.z, ship.prepared[i]!.spec.id).toBeCloseTo(want.z, 9);
    });
  });

  it('normalises a non-unit direction from a hand-edited data file', () => {
    const ship = createShip({
      ...spec,
      thrusters: [{ id: 'odd', position: [0, 0, 0], direction: [0, 0, -2], thrust: 100, isp: 200 }],
    });
    const { plumes } = rig(ship);
    plumes.update(ship, 0);
    const exhaust = Y.clone().applyQuaternion(meshes(plumes)[0]!.quaternion);
    expect(exhaust.length()).toBeCloseTo(1, 9);
    expect(exhaust.z).toBeCloseTo(1, 9);
  });
});

describe('plume intensity from ship.throttles', () => {
  it('draws nothing at zero throttle: visible=false, not opacity 0', () => {
    const { plumes, ship } = rig();
    plumes.update(ship, 0);
    for (const m of meshes(plumes)) expect(m.visible).toBe(false);
  });

  it('shows the main engine at full scale and full opacity at throttle 1', () => {
    const { plumes, ship } = rig();
    const main = index(ship, 'main');
    ship.throttles[main] = 1;
    plumes.update(ship, 0);
    const m = meshes(plumes)[main]!;
    expect(m.visible).toBe(true);
    expect(material(m).opacity).toBe(1);
    expect(m.scale.y).toBeCloseTo(PLUME_LENGTH, 12);
    expect(m.scale.x).toBeCloseTo(PLUME_RADIUS, 12);
    expect(m.scale.z).toBeCloseTo(PLUME_RADIUS, 12);
  });

  it('scales length and opacity with a partial throttle', () => {
    const { plumes, ship } = rig();
    const main = index(ship, 'main');
    ship.throttles[main] = 0.5;
    plumes.update(ship, 0);
    const m = meshes(plumes)[main]!;
    expect(m.visible).toBe(true);
    expect(material(m).opacity).toBeCloseTo(0.5, 6);
    expect(m.scale.y).toBeCloseTo(PLUME_LENGTH * 0.5, 6);
  });

  it('makes the main engine plume much bigger than an RCS plume, with a visible floor', () => {
    const { plumes, ship } = rig();
    const main = index(ship, 'main');
    const rcs = index(ship, 'retro_p');
    ship.throttles[main] = 1;
    ship.throttles[rcs] = 1;
    plumes.update(ship, 0);
    const a = meshes(plumes)[main]!;
    const b = meshes(plumes)[rcs]!;
    expect(b.visible).toBe(true);
    expect(a.scale.y).toBeGreaterThan(b.scale.y);
    expect(a.scale.x).toBeGreaterThan(b.scale.x);
    expect(b.scale.y).toBeCloseTo(PLUME_LENGTH * MIN_SCALE, 12);
  });

  it('only touches the thrusters that are open', () => {
    const { plumes, ship } = rig();
    const rcs = index(ship, 'fwd_port');
    ship.throttles[rcs] = 1;
    plumes.update(ship, 0);
    meshes(plumes).forEach((m, i) => expect(m.visible).toBe(i === rcs));
  });

  it('never writes to the ship', () => {
    const { plumes, ship } = rig();
    ship.throttles[index(ship, 'main')] = 0.7;
    const before = Array.from(ship.throttles);
    const prepared = ship.prepared;
    plumes.update(ship, 0);
    plumes.update(ship, 16);
    expect(Array.from(ship.throttles)).toEqual(before);
    expect(ship.prepared).toBe(prepared);
  });
});

describe('plume fade-out', () => {
  it('fadeIntensity: ignition is instant, shutdown decays linearly over FADE_MS', () => {
    expect(fadeIntensity(0, 1, 16)).toBe(1);
    expect(fadeIntensity(1, 1, 16)).toBe(1);
    expect(fadeIntensity(1, 0, FADE_MS / 2)).toBeCloseTo(0.5, 12);
    expect(fadeIntensity(1, 0, FADE_MS)).toBe(0);
    expect(fadeIntensity(1, 0, FADE_MS * 10)).toBe(0);
    expect(fadeIntensity(0.5, 0, 0)).toBe(0.5);
    // A throttle above the decaying value wins; below it, the decay wins.
    expect(fadeIntensity(1, 0.9, 5)).toBeCloseTo(0.95, 12);
    expect(fadeIntensity(1, 0.2, 5)).toBeCloseTo(0.95, 12);
  });

  it('keeps a single-frame pulse on screen for FADE_MS after the thruster closes', () => {
    const { plumes, ship } = rig();
    const rcs = index(ship, 'retro_s');
    const m = () => meshes(plumes)[rcs]!;

    plumes.update(ship, 0);
    ship.throttles[rcs] = 1;
    plumes.update(ship, 16);
    expect(m().visible).toBe(true);
    expect(material(m()).opacity).toBe(1);

    ship.throttles[rcs] = 0;
    plumes.update(ship, 16 + FADE_MS / 2);
    expect(m().visible).toBe(true);
    expect(material(m()).opacity).toBeCloseTo(0.5, 6);
    expect(m().scale.y).toBeCloseTo(PLUME_LENGTH * MIN_SCALE * 0.5, 6);

    plumes.update(ship, 16 + FADE_MS);
    expect(m().visible).toBe(false);
  });

  it('is not fooled by a clock that stands still or runs backwards', () => {
    const { plumes, ship } = rig();
    const rcs = index(ship, 'retro_s');
    ship.throttles[rcs] = 1;
    plumes.update(ship, 100);
    ship.throttles[rcs] = 0;
    plumes.update(ship, 100);
    expect(meshes(plumes)[rcs]!.visible).toBe(true);
    plumes.update(ship, 50);
    expect(meshes(plumes)[rcs]!.visible).toBe(true);
    expect(material(meshes(plumes)[rcs]!).opacity).toBe(1);
  });
});

describe('plume parenting', () => {
  it('hangs off the scene, not the hull, and follows the hull transform', () => {
    const { scene, hull, plumes, ship } = rig();
    plumes.update(ship, 0);
    expect(plumes.group.parent).toBe(scene);
    expect(hull.children).not.toContain(plumes.group);
    for (const m of meshes(plumes)) expect(m.parent).toBe(plumes.group);

    hull.position.set(10, -20, 30);
    hull.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3);
    plumes.update(ship, 16);
    expect(plumes.group.position.equals(hull.position)).toBe(true);
    expect(plumes.group.quaternion.equals(hull.quaternion)).toBe(true);
  });

  it('stays drawable while the hull is hidden, as in cockpit view', () => {
    const { hull, plumes, ship } = rig();
    hull.visible = false;
    ship.throttles[index(ship, 'main')] = 1;
    plumes.update(ship, 0);
    expect(plumes.group.visible).toBe(true);
    expect(meshes(plumes)[index(ship, 'main')]!.visible).toBe(true);
    // The world matrix is what the renderer draws with; it must be reachable without the hull.
    hull.position.set(5, 6, 7);
    plumes.update(ship, 16);
    plumes.group.updateMatrixWorld(true);
    const world = new THREE.Vector3().setFromMatrixPosition(
      meshes(plumes)[index(ship, 'main')]!.matrixWorld,
    );
    const [x, y, z] = ship.prepared[index(ship, 'main')]!.spec.position;
    expect(world.x).toBeCloseTo(5 + x, 9);
    expect(world.y).toBeCloseTo(6 + y, 9);
    expect(world.z).toBeCloseTo(7 + z, 9);
  });
});

describe('plume rebuild', () => {
  it('keeps the same meshes while ship.prepared is the same array', () => {
    const { plumes, ship } = rig();
    plumes.update(ship, 0);
    const first = meshes(plumes).slice();
    plumes.update(ship, 16);
    plumes.update(ship, 32);
    expect(meshes(plumes)).toEqual(first);
    meshes(plumes).forEach((m, i) => expect(m).toBe(first[i]));
  });

  it('rebuilds when ship.prepared is a different array', () => {
    const { plumes, ship } = rig();
    plumes.update(ship, 0);
    const first = meshes(plumes).slice();
    expect(first).toHaveLength(spec.thrusters.length);

    const smaller = createShip({ ...spec, thrusters: spec.thrusters.slice(0, 3) });
    smaller.throttles[0] = 1;
    plumes.update(smaller, 16);
    expect(plumes.group.children).toHaveLength(3);
    for (const m of meshes(plumes)) expect(first).not.toContain(m);
    for (const m of first) expect(m.parent).toBeNull();
    expect(meshes(plumes)[0]!.visible).toBe(true);
    expect(meshes(plumes)[1]!.visible).toBe(false);

    // Same spec, new prepared array: still a rebuild, keyed on identity not content.
    const again = createShip(spec);
    plumes.update(again, 32);
    expect(plumes.group.children).toHaveLength(spec.thrusters.length);
    meshes(plumes).forEach((m, i) => {
      expect(m.name).toBe(again.prepared[i]!.spec.id);
      expect(m.visible).toBe(false);
    });
  });

  it('handles a ship with no thrusters', () => {
    const ship = createShip({ ...spec, thrusters: [] });
    const { plumes } = rig(ship);
    plumes.update(ship, 0);
    expect(plumes.group.children).toHaveLength(0);
  });
});

describe('plumeScale', () => {
  it('gives the largest thruster full size and floors the rest at MIN_SCALE', () => {
    const max = Math.max(...spec.thrusters.map((t) => t.thrust));
    expect(plumeScale(max, max)).toBe(1);
    expect(plumeScale(500, 40000)).toBe(MIN_SCALE);
    expect(plumeScale(0, 40000)).toBe(MIN_SCALE);
    expect(plumeScale(1, 0)).toBe(MIN_SCALE);
    expect(plumeScale(10000, 40000)).toBeCloseTo(0.5, 12);
    expect(plumeScale(80000, 40000)).toBe(1);
  });

  it('is monotonic in thrust', () => {
    let prev = 0;
    for (const t of [1, 100, 1000, 5000, 20000, 40000]) {
      const s = plumeScale(t, 40000);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
  });
});
