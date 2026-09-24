import { createRenderer } from './render';
import { createHud } from './hud';
import { createWorld, step, STEP, type World } from './sim/world';
import { emptyCommand, type Command } from './control';
import { createShip, type ShipSpec } from './sim/ship';
import skiffSpec from './data/skiff.json';

const renderer = createRenderer();
const hud = createHud(document.getElementById('hud')!);

// The Skiff is the only flyable hull for now. Mass and inertia come from the data
// file via createShip — nothing about the ship is hardcoded here.
const skiff = createShip(skiffSpec as ShipSpec);
const world: World = createWorld([skiff]);
// One throttle slot per thruster on the ship we actually loaded.
const command: Command = emptyCommand(skiff.prepared.length);

let accumulator = 0;
let last = performance.now() / 1000;
let halted: string | null = null;

/**
 * Fixed timestep, clamped accumulator, interpolated render.
 *
 * Physics runs at a constant STEP regardless of display rate. On a 240 Hz monitor
 * roughly every other frame runs zero steps, which is exactly why render.draw takes
 * an interpolation alpha — without it you get duplicated frames and visible judder.
 *
 * Input is sampled once per FRAME, not once per step: at 240 Hz you sometimes run no
 * steps, at 30 Hz you run four with the same command, and both are correct.
 */
function frame() {
  requestAnimationFrame(frame);

  const now = performance.now() / 1000;
  accumulator += Math.min(now - last, 0.25); // clamp: never spiral after a tab-out
  last = now;

  if (!halted) {
    try {
      // TODO: const axes = device.sample(dt); resolve(ship, axes, command);
      while (accumulator >= STEP) {
        step(world, command, STEP);
        accumulator -= STEP;
      }
    } catch (err) {
      halted = err instanceof Error ? err.message : String(err);
    }
  }

  renderer.draw(world, accumulator / STEP);

  if (halted) {
    document.getElementById('hud')!.textContent =
      `SIM HALTED\n\n${halted}\n\nRun \`npm test\` — the failing tests are the spec.`;
  } else {
    hud.draw(world);
  }
}

requestAnimationFrame(frame);
