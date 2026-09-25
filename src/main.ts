import { createRenderer } from './render';
import { createHud } from './hud';
import { createWorld, resetRun, step, STEP, type World } from './sim/world';
import { emptyCommand, resolve, type Command } from './control';
import { createKeyboardMouse } from './input';
import { createShip, type ShipSpec } from './sim/ship';
import skiffSpec from './data/skiff.json';
import { Vector3 } from './core/math';

const renderer = createRenderer();
const hud = createHud(document.getElementById('hud')!, renderer.camera);

// The Skiff is the only flyable hull for now. Mass and inertia come from the data
// file via createShip — nothing about the ship is hardcoded here.
const skiff = createShip(skiffSpec as ShipSpec);
const world: World = createWorld([skiff]);
// The docking ring (#25): 400 m dead ahead of the starting pose, stationary, 3 m contact
// radius around its centre. The sim tests the ship's docking port against that radius
// and records the first contact; the renderer draws a torus of the same radius so what
// the pilot flies at is exactly what the sim judges. Its axis faces the origin, so the
// approach is straight down -Z from where the Skiff starts.
world.targets.push({ name: 'ring', position: new Vector3(0, 0, -400), velocity: new Vector3(), radius: 3 });
world.selected = 0;
// One throttle slot per thruster on the ship we actually loaded. Reused every frame:
// resolve() writes into it in place, so the flight loop allocates nothing.
const command: Command = emptyCommand(skiff.prepared.length);

// The only thing in the program that touches a raw device event. Bound to the renderer's
// canvas so a click takes pointer lock and the mouse becomes the rotational controller.
const device = createKeyboardMouse(renderer.canvas);

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
  // Clamp before it reaches either the accumulator or the input device: after a tab-out
  // the delta can be minutes, which would otherwise spiral the step loop and snap the
  // virtual stick straight to centre.
  const frameDt = Math.min(now - last, 0.25);
  accumulator += frameDt;
  last = now;

  if (!halted) {
    try {
      // Once per FRAME, never per step. At 240 Hz the loop below often runs zero steps
      // and this command is simply not consumed; at 30 Hz four steps share it. Both are
      // correct — the command is the pilot's demand, not a per-step quantity.
      const axes = device.sample(frameDt);
      // Edge flags are true for exactly the one frame their key went down. The view is a
      // render concern; the target selection is world state the HUD reads (#21).
      if (axes.toggleView) renderer.toggleView();
      if (axes.cycleTarget && world.targets.length > 0) {
        world.selected = (world.selected + 1) % world.targets.length;
      }
      // Restart resets in place, so every reference below stays valid. Legal mid-run too.
      if (axes.restart) resetRun(world);
      resolve(skiff, axes, command);

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
