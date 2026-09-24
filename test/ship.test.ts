import { describe, it, expect } from 'vitest';
import { Vector3, G0 } from '../src/core/math';
import { prepare, netWrench, massFlow, currentMass, solveControlGroups } from '../src/sim/ship';
import type { ShipSpec, Ship } from '../src/sim/ship';
import { createBody } from '../src/sim/body';
import skiff from '../src/data/skiff.json';

const spec = skiff as ShipSpec;

function shipWith(open: Record<string, number>): Ship {
  const prepared = prepare(spec);
  const throttles = new Float32Array(prepared.length);
  prepared.forEach((p, i) => { throttles[i] = open[p.spec.id] ?? 0; });
  return {
    spec,
    body: createBody({ mass: spec.dryMass + spec.propellantCapacity, inertia: new Vector3(...spec.inertia) }),
    propellant: spec.propellantCapacity,
    prepared,
    throttles,
  };
}

describe('prepare', () => {
  it('computes force, torque and mass flow per thruster', () => {
    const p = prepare(spec).find((t) => t.spec.id === 'main')!;
    expect(p.force.z).toBeCloseTo(-40000, 6);
    // main is on the centreline, so it produces no torque
    expect(p.torque.length()).toBeCloseTo(0, 6);
    // mdot = thrust / (isp * g0)
    expect(p.massFlow).toBeCloseTo(40000 / (320 * G0), 9);
  });
});

describe('thruster geometry', () => {
  it('an opposed pair gives pure torque and no net force', () => {
    // fwd_port pushes +x at the front, aft_stbd pushes -x at the back: a yaw couple
    const w = netWrench(shipWith({ fwd_port: 1, aft_stbd: 1 }));
    expect(w.force.length()).toBeCloseTo(0, 6);
    expect(w.torque.length()).toBeGreaterThan(0);
  });

  it('a parallel pair gives pure force and no torque', () => {
    const w = netWrench(shipWith({ fwd_port: 1, aft_port: 1 }));
    expect(w.force.x).toBeGreaterThan(0);
    expect(w.torque.length()).toBeCloseTo(0, 6);
  });

  it('scales linearly with throttle', () => {
    const full = netWrench(shipWith({ main: 1 })).force.length();
    const half = netWrench(shipWith({ main: 0.5 })).force.length();
    expect(half).toBeCloseTo(full / 2, 6);
  });
});

describe('propellant', () => {
  it('consumes mass only from thrusters that are open', () => {
    expect(massFlow(shipWith({}))).toBe(0);
    expect(massFlow(shipWith({ main: 1 }))).toBeCloseTo(40000 / (320 * G0), 9);
  });

  it('a full burn matches the rocket equation', () => {
    const s = shipWith({ main: 1 });
    const m0 = currentMass(s);
    const dt = 1 / 120;
    let dv = 0;
    while (s.propellant > 0) {
      const mdot = massFlow(s);
      const m = currentMass(s);
      dv += (netWrench(s).force.length() / m) * dt;
      s.propellant = Math.max(0, s.propellant - mdot * dt);
    }
    const expected = 320 * G0 * Math.log(m0 / (m0 - spec.propellantCapacity));
    expect(dv).toBeCloseTo(expected, 0);
    expect(Math.abs(dv - expected) / expected).toBeLessThan(0.005);
  });
});

describe('control groups', () => {
  it('produces a group per axis that cancels everything it is not asking for', () => {
    const prepared = prepare(spec);
    const groups = solveControlGroups(prepared);
    const sum = (idx: number[], key: 'force' | 'torque') =>
      idx.reduce((acc, i) => acc.add(prepared[i]![key]), new Vector3());

    // yaw is rotation about +Y: torque on Y, nothing else
    const yaw = groups.rotateY.positive;
    expect(yaw.length).toBeGreaterThan(0);
    expect(sum(yaw, 'force').length()).toBeCloseTo(0, 3);
    const t = sum(yaw, 'torque');
    expect(Math.abs(t.y)).toBeGreaterThan(0);
    expect(Math.abs(t.x)).toBeLessThan(Math.abs(t.y) * 1e-3);
    expect(Math.abs(t.z)).toBeLessThan(Math.abs(t.y) * 1e-3);

    // lateral translation: force on X, no torque
    const lat = groups.translateX.positive;
    expect(sum(lat, 'torque').length()).toBeCloseTo(0, 3);
    expect(sum(lat, 'force').x).toBeGreaterThan(0);
  });
});

describe('ship data integrity', () => {
  it('has a thruster group for both signs of every axis', () => {
    const groups = solveControlGroups(prepare(spec));
    for (const axis of Object.keys(groups) as (keyof typeof groups)[]) {
      expect(groups[axis].positive.length, `${axis} positive`).toBeGreaterThan(0);
      expect(groups[axis].negative.length, `${axis} negative`).toBeGreaterThan(0);
    }
  });
});
