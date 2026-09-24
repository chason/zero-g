import { solveControlGroups } from '../sim/ship';
import type { Ship, ControlGroups, PreparedThruster } from '../sim/ship';
import type { AxisState } from '../input';
import { FINE_SCALE } from '../input';

/** Per-thruster throttle in 0..1, parallel to ship.prepared. */
export interface Command {
  throttles: Float32Array;
}

export function emptyCommand(size: number): Command {
  return { throttles: new Float32Array(size) };
}

/**
 * Control groups are expensive to solve and never change for a given thruster layout,
 * so they are cached. The cache is keyed on the `prepared` ARRAY, not on the ship: if
 * someone swaps ship.prepared (hot-reloaded data file, a refit, a test building a fresh
 * ship from the same spec) the new array misses the cache and is solved afresh, so a
 * stale group list can never be handed back.
 */
const groupCache = new WeakMap<PreparedThruster[], ControlGroups>();

function groupsFor(ship: Ship): ControlGroups {
  const { prepared } = ship;
  let groups = groupCache.get(prepared);
  if (groups === undefined) {
    groups = solveControlGroups(prepared);
    groupCache.set(prepared, groups);
  }
  return groups;
}

/**
 * Turn six signed axis demands into thruster throttles, via the precomputed control groups.
 *
 * Note what this does NOT do: it never decides a rotation rate, and it never fires a
 * thruster the player did not ask for. There is no flight assist anywhere in this file.
 */
export function resolve(ship: Ship, axes: AxisState, out?: Command): Command {
  const count = ship.prepared.length;
  const cmd = out ?? emptyCommand(count);
  const throttles = cmd.throttles;
  throttles.fill(0);

  // cutAll wins over everything else, including a demand held on the stick.
  if (axes.cutAll) return cmd;

  const groups = groupsFor(ship);
  const scale = axes.fine ? FINE_SCALE : 1;

  const demands: [keyof ControlGroups, number][] = [
    ['translateX', axes.translate.x],
    ['translateY', axes.translate.y],
    ['translateZ', axes.translate.z],
    ['rotateX', axes.rotate.x],
    ['rotateY', axes.rotate.y],
    ['rotateZ', axes.rotate.z],
  ];

  for (let d = 0; d < demands.length; d++) {
    const [axis, demand] = demands[d]!;
    if (demand === 0) continue;
    const group = groups[axis];
    const indices = demand > 0 ? group.positive : group.negative;
    const amount = Math.abs(demand) * scale;
    // A thruster serving two axes at once sums; the clamp happens after all six axes
    // have had their say, so nothing is silently dropped on the way.
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      throttles[index] = throttles[index]! + amount;
    }
  }

  for (let i = 0; i < count; i++) {
    if (throttles[i]! > 1) throttles[i] = 1;
  }

  return cmd;
}
