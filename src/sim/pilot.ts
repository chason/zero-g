import { clamp } from '../core/math';
import type { Pilot } from './ship';

/**
 * Pilot tolerance — the second fail state (issue #23).
 *
 * Human tolerance is a function of magnitude AND duration, so damage taken from an
 * instantaneous g reading would be both unfair and wrong. Instead, felt acceleration
 * at the seat above G_SAFE drains a reserve, and health falls only once that reserve
 * is empty. The reserve is the warning window: it is what makes a brief violent
 * manoeuvre a legitimate tactic rather than an instant loss.
 *
 *   gLoad <= G_SAFE :  reserve += RECOVER * dt
 *   gLoad >  G_SAFE :  reserve -= DRAIN * (gLoad - G_SAFE)^2 * dt
 *   reserve === 0   :  health  -= HARM * dt
 *
 * Both fields are clamped to 0..1 and health never refills on its own.
 *
 * The square is what makes it steep. With DRAIN = 0.03 a full reserve lasts roughly
 * 130 s at 3 g, 15 s at 4 g, 5 s at 5 g, 1.7 s at 7 g and 0.8 s at 9 g, so a 200 ms
 * spike at 9 g costs about a quarter of the reserve and no health. The suggested
 * starting value of 0.45 emptied it in 53 ms at 9 g, which made every spike lethal;
 * anything above ~0.12 does. Time to empty at g is 1 / (DRAIN * (g - G_SAFE)^2).
 *
 * This module reads a g figure and writes only `pilot`. It never touches the body.
 * Spec: test/pilot.test.ts.
 */

/** Sustained g the pilot tolerates indefinitely. Above it the reserve drains. */
export const G_SAFE = 2.5;
/** Reserve drained per second, per (g above G_SAFE) squared. */
export const DRAIN = 0.03;
/** Reserve refilled per second while at or below G_SAFE. Empty to full in 4 s. */
export const RECOVER = 0.25;
/** Health lost per second while the reserve is empty. Full to dead in 2 s. */
export const HARM = 0.5;

/**
 * Advance the pilot's tolerance state by dt seconds under a felt load of `gLoad` g.
 * Mutates `pilot` in place and depends on nothing but its arguments; the g figure is
 * kept on `pilot.gLoad` for the HUD and the blackout pass.
 */
export function stepPilot(pilot: Pilot, gLoad: number, dt: number): void {
  pilot.gLoad = gLoad;

  if (gLoad <= G_SAFE) {
    pilot.reserve = clamp(pilot.reserve + RECOVER * dt, 0, 1);
    return;
  }

  const excess = gLoad - G_SAFE;
  const rate = DRAIN * excess * excess;
  const drained = rate * dt;

  if (drained < pilot.reserve) {
    pilot.reserve = clamp(pilot.reserve - drained, 0, 1);
    return;
  }

  // The reserve empties partway through this step (or was already empty). Only the
  // remainder of the step harms the pilot, so the outcome does not depend on dt: a
  // whole step of harm charged for a partial one would make the sim's fixed rate a
  // tuning constant.
  const remaining = Math.max(0, dt - pilot.reserve / rate);
  pilot.reserve = 0;
  pilot.health = clamp(pilot.health - HARM * remaining, 0, 1);
}
