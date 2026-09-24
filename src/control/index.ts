import type { Ship } from '../sim/ship';
import type { AxisState } from '../input';

/** Per-thruster throttle in 0..1, parallel to ship.prepared. */
export interface Command {
  throttles: Float32Array;
}

export function emptyCommand(size: number): Command {
  return { throttles: new Float32Array(size) };
}

/**
 * Turn six signed axis demands into thruster throttles, via the precomputed control groups.
 *
 * Note what this does NOT do: it never decides a rotation rate, and it never fires a
 * thruster the player did not ask for. There is no flight assist anywhere in this file.
 *
 * TODO — implement:
 *   - for each axis, pick the positive or negative group by sign
 *   - set those thrusters to |demand|, scaled by FINE_SCALE when axes.fine
 *   - a thruster serving two axes at once sums, then clamps to 1
 *   - axes.cutAll zeroes everything
 */
export function resolve(_ship: Ship, _axes: AxisState, _out?: Command): Command {
  throw new Error('control/index.ts resolve() is not implemented yet — see test/control.test.ts');
}
