import { createRenderer } from './render';
import { createHud } from './hud';
import { createWorld, resetRun, step, STEP, type World, type StructureSpec } from './sim/world';
import { generateScenario, applyScenario } from './sim/scenario';
import capitalSpec from './data/capital.json';
import { emptyCommand, resolve, type Command } from './control';
import { createKeyboardMouse, emptyAxes } from './input';
import { createMenu } from './menu';
import { createShip, type ShipSpec } from './sim/ship';
import skiffSpec from './data/skiff.json';

const renderer = createRenderer();
const hud = createHud(document.getElementById('hud')!, renderer.camera);

// The Skiff is the only flyable hull for now. Mass and inertia come from the data
// file via createShip — nothing about the ship is hardcoded here.
const skiff = createShip(skiffSpec as ShipSpec);
const world: World = createWorld([skiff]);
// The docking ring (#25): 400 m dead ahead of the starting pose, stationary, 3 m contact
// radius around its centre. The sim tests the ship's docking port against that radius
// The Yarrow, a capital mining ship with twenty docking ports. Each run is a scenario
// from a seed: which port we are assigned (the side we are nearest), where we start
// (350-450 m out, ring in front of us), and where the rocks are (#43). Enter rolls a
// new one. The seed is logged so a start can be reproduced.
const capital = capitalSpec as StructureSpec;
let seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
function newRun(): void {
  resetRun(world);
  applyScenario(world, capital, generateScenario(capital, seed), skiff);
  console.info(`zero-g run seed ${seed}: assigned ${world.targets[world.assigned]?.name}`);
}
newRun();
// One throttle slot per thruster on the ship we actually loaded. Reused every frame:
// resolve() writes into it in place, so the flight loop allocates nothing.
const command: Command = emptyCommand(skiff.prepared.length);

// The only thing in the program that touches a raw device event. Bound to the renderer's
// canvas so a click takes pointer lock and the mouse becomes the rotational controller.
const device = createKeyboardMouse(renderer.canvas);
// Esc opens the options menu (#56); while it is open the sim is paused and the pointer
// is free. Closing it hands the mouse back. Mouse settings persist in localStorage.
const menu = createMenu(document.getElementById('menu')!, { device, onResume: () => device.capture() });
/** what the ship is told while the menu is up: nothing */
const idle = emptyAxes();

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
      // Esc (or losing the mouse) toggles the menu; a click on the canvas that takes the
      // mouse back closes it. Open, the menu pauses the sim: the accumulator is drained so
      // no time is owed when it closes, and the ship is commanded to do nothing.
      if (axes.menu) {
        menu.toggle();
        if (!menu.open) device.capture();
      }
      if (menu.open && device.locked) menu.hide();
      if (menu.open) {
        resolve(skiff, idle, command);
        accumulator = 0;
      } else {
        // Edge flags are true for exactly the one frame their key went down. The view is a
        // render concern; the target selection is world state the HUD reads (#21).
        if (axes.toggleView) renderer.toggleView();
        if (axes.cycleTarget && world.targets.length > 0) {
          world.selected = (world.selected + 1) % world.targets.length;
        }
        // Restart resets in place, so every reference below stays valid. Legal mid-run too.
        if (axes.restart) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          newRun();
        }
        resolve(skiff, axes, command);

        while (accumulator >= STEP) {
          step(world, command, STEP);
          accumulator -= STEP;
        }
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
    hud.draw(world, renderer.view);
  }
}

requestAnimationFrame(frame);

// Dev only: a handle for poking the running sim from the console — teleport the ship,
// read the world, tune a constant. Stripped from production builds by Vite.
if (import.meta.env.DEV) {
  (window as unknown as { zeroG: unknown }).zeroG = { world, ship: skiff, renderer, resetRun: newRun, replay: (s: number) => { seed = s >>> 0; newRun(); } };
}
