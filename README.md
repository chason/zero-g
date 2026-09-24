# zero-g

A browser-based Newtonian spaceflight simulator. Six degrees of freedom, real rigid-body
physics, finite propellant, and **no flight assist** — the computer never fires a thruster
you did not ask for.

This repository is a scaffold. The architecture, types and test suite are in place; the
simulation itself is not written yet. The failing tests are the specification.

## Getting started

```bash
npm install
npm test        # red — every stub throws
npm run dev     # boots, renders, shows which stub halted the sim
```

## Where to start

Implement in this order; each step turns a block of tests green.

| Step | File | Tests |
| --- | --- | --- |
| 1 | `src/sim/body.ts` — `integrate` | `test/body.test.ts` |
| 2 | `src/sim/body.ts` — `angularMomentum`, `feltAcceleration` | `test/body.test.ts` |
| 3 | `src/sim/ship.ts` — `prepare`, `netWrench`, `massFlow` | `test/ship.test.ts` |
| 4 | `src/sim/ship.ts` — `solveControlGroups` | `test/ship.test.ts` |
| 5 | `src/sim/world.ts` — `step` | `test/world.test.ts` |
| 6 | `src/control/index.ts` — `resolve` | `test/control.test.ts` |
| 7 | `src/input/index.ts` — `createKeyboardMouse` | flying it |

## Rules the architecture depends on

**Physics state is plain numbers that know nothing about Three.js.** Renderer transforms are
an output, copied once per frame. If ship position ever lives in `mesh.position`, the
simulation is coupled to the frame rate and stops being testable.

**Fixed timestep, always.** 120 Hz in an accumulator loop, independent of display rate.
The moment `dt` varies, handling differs between machines and the tests stop being
reproducible. Render interpolates with the leftover `alpha`.

**Nothing outside `src/input` reads a raw device event.** That module emits six signed axes
in −1..1; everything downstream consumes only those. Keep this and gamepad or HOTAS support
is a new file rather than a refactor.

**Never hardcode mass, inertia, centre of mass or thruster geometry.** All of it is recomputed
from the current loadout. This is what makes ship design and cargo mechanics additive later
instead of a rewrite.

**No drag, anywhere.** If velocity ever shrinks without a burn, something multiplies it by a
factor below 1 and needs finding.

## Input model

Rotation and translation use different controllers and never share an axis, the way Apollo
and the Shuttle split a Rotational Hand Controller from a Translational one.

| Role | Device | Axes | Behaviour |
| --- | --- | --- | --- |
| Rotational | mouse, pointer-locked | yaw, pitch | proportional, squared curve, springs to centre |
| Rotational | Q / E | roll | pulse |
| Translational | W/S, A/D, R/F | fore–aft, lateral, vertical | tap = 60 ms impulse, hold = continuous |
| Both | Shift | all | fine control, 15% output |
| Both | Space | all | cut all thrusters |

## Falling into zero

Three different things, only one of which is assist:

- Input deadzone at 5% — device noise rejection, not a lie.
- Rotation state clamp below 0.0003 rad/s (~0.017°/s) — six times finer than the HUD
  resolves, so it is invisible rather than generous. Worth doing because residual rotation
  compounds into 10° of drift over ten minutes.
- Translation — the readout rounds below 0.01 m/s, the state never does. There is no rest
  frame in deep space, so clamping world velocity would be meaningless.
