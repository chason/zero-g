# Contributing

Work is done one issue at a time, often by an agent that sees only that issue. So the
rules below are stated with their failure mode attached: knowing *what* breaks is the
only thing that makes a rule survive contact with a narrow task.

Read the README first. This file is what the README's architecture section means in
practice.

## Workflow

One issue per branch, branched from `main`, named for the issue. Acceptance is exactly
this: **the tests named in the issue go green, and no other test that was green goes
red.** Run `npm test` before and after, and compare — the suite is red by design right
now, so "tests fail" is not a signal on its own. "The tests I was given pass and nothing
else moved" is.

```bash
npm run typecheck   # must be clean
npm test            # the named block green, the rest no worse than before
```

## The invariants

**Physics state is plain numbers.** Positions, velocities, quaternions and masses live in
the sim as ordinary numeric fields that know nothing about Three.js. Renderer transforms
are an *output*, copied out once per rendered frame. Put ship position in `mesh.position`
and the simulation is now coupled to the frame rate and can only be tested by standing up
a renderer — which means it stops being tested at all.

**Fixed 120 Hz timestep, in an accumulator loop.** `STEP` is `1/120`, and `step()` is
called with exactly that. Never derive `dt` from the display rate or from a frame delta.
Do it once and the ship handles differently on a 60 Hz laptop than on a 144 Hz monitor,
and every test that asserts a number after N steps becomes irreproducible. Rendering
interpolates with the leftover `alpha`; it does not shorten or lengthen a step.

**No drag, anywhere.** Nothing multiplies a velocity or an angular velocity by a factor
below 1 as a matter of course — not as smoothing, not as a stability fix, not as "just a
tiny bit so it feels better". If speed ever decreases without propellant being spent, the
game has silently become arcade and the bug is a single stray coefficient that is very
hard to find later. (The rotation clamp below 0.0003 rad/s is a state clamp at the
resolution floor, not damping; see the README.)

**Only `src/input` touches a raw device event.** No `addEventListener`, no `KeyboardEvent`,
no gamepad API outside that module. It emits six signed axes in −1..1 plus the `fine` and
`cutAll` flags, and everything downstream consumes only that. Hold the line and adding
gamepad or HOTAS support is a new file next to the keyboard one; break it and it is a
refactor through the control and sim layers.

**Mass, inertia, centre of mass and thruster geometry are always derived from the current
loadout.** Never hardcode them, never cache them past a loadout change, never tune a
constant to make one ship feel right. Every hardcoded value is a ship design or cargo
feature that can no longer be added without a rewrite — the whole point of deriving them
is that later mechanics stay additive.

**No stabilisation in `src/control`.** `resolve()` maps demand to throttles and does
nothing else. It must never fire a thruster the player did not ask for: no rate damping,
no attitude hold, no counter-burn to null a residual spin, no "help" of any kind. There is
no flight assist in this game — the difficulty of hand-flying a rigid body is the game.
An assist added here is invisible in a diff and unremovable once players learn around it.

**Tests in `test/` are the specification.** They were written before the code and describe
the intended behaviour, including exact numbers. If a test fails, the implementation is
wrong. Editing, loosening or skipping a test to get a green run is a failed issue, not a
finished one — it deletes the requirement instead of meeting it. If you believe a test is
genuinely wrong, say so in the issue and stop; do not change it and carry on.

## Scope

Change what the issue asks for and leave the rest alone. Do not reformat files you did not
otherwise touch, do not add dependencies, and do not "fix" adjacent stubs — another branch
owns them, and the merge conflict costs more than the tidy-up saves.
