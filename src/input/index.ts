/**
 * The ONLY module that knows a keyboard, mouse or gamepad exists.
 *
 * It emits six signed axes in -1..1 plus a few flags. Nothing downstream may read a
 * raw device event: keep that line and adding a HOTAS is a new file here, not a refactor.
 *
 * Sign selects direction; `control` resolves a signed axis to one of the twelve
 * thruster groups. Deadzones, response curves, spring-back and pulse timing all live here.
 */
import { clamp, deadzone, signPow } from '../core/math';

export interface AxisState {
  /** translation demand, body frame: x lateral, y vertical, z fore-aft */
  translate: { x: number; y: number; z: number };
  /** rotation demand, body frame: x pitch, y yaw, z roll */
  rotate: { x: number; y: number; z: number };
  /** Shift held: scale all output to FINE_SCALE */
  fine: boolean;
  /** Space: cut everything this tick */
  cutAll: boolean;
}

export interface InputDevice {
  /** Called once per rendered frame, never per physics step. `dt` is in seconds. */
  sample(dt: number): AxisState;
  dispose(): void;
}

export const FINE_SCALE = 0.15;
/** A tap fires for this long, giving a known quantum of delta-v. */
export const PULSE_MS = 60;
/** Held past this, the thruster opens continuously instead. */
export const HOLD_MS = 200;
/** The virtual stick recentres over roughly this long with no input. */
export const SPRING_MS = 300;

export function emptyAxes(): AxisState {
  return {
    translate: { x: 0, y: 0, z: 0 },
    rotate: { x: 0, y: 0, z: 0 },
    fine: false,
    cutAll: false,
  };
}

/** Pixels of pointer travel that move the virtual stick from centre to full deflection. */
export const STICK_RANGE_PX = 400;

/** Keys the translational controller and the roll axis listen to. */
const PULSE_BINDINGS: ReadonlyArray<{
  code: string;
  channel: 'translate' | 'rotate';
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
}> = [
  { code: 'KeyW', channel: 'translate', axis: 'z', sign: 1 },
  { code: 'KeyS', channel: 'translate', axis: 'z', sign: -1 },
  { code: 'KeyD', channel: 'translate', axis: 'x', sign: 1 },
  { code: 'KeyA', channel: 'translate', axis: 'x', sign: -1 },
  { code: 'KeyR', channel: 'translate', axis: 'y', sign: 1 },
  { code: 'KeyF', channel: 'translate', axis: 'y', sign: -1 },
  { code: 'KeyE', channel: 'rotate', axis: 'z', sign: 1 },
  { code: 'KeyQ', channel: 'rotate', axis: 'z', sign: -1 },
];

/**
 * Anything with addEventListener/removeEventListener. Real code passes `window` and
 * `document`; a test passes a stub, which is what keeps the state machines headless.
 */
export interface EventSourceLike {
  addEventListener(type: string, handler: (event: any) => void): void;
  removeEventListener(type: string, handler: (event: any) => void): void;
}

export interface KeyboardMouseOptions {
  /** Monotonic clock in milliseconds. Injectable so pulse timing can be driven by a fake. */
  now?: () => number;
  /** Where keydown/keyup come from. Defaults to `window`. */
  keySource?: EventSourceLike | null;
  /** Where mousemove / pointerlockchange come from. Defaults to `document`. */
  mouseSource?: EventSourceLike | null;
  /** Response curve exponent for the virtual stick. */
  exponent?: number;
  /** Pixels from centre to full stick deflection. */
  stickRangePx?: number;
}

export interface KeyboardMouseDevice extends InputDevice {
  /** Response curve exponent, settable at runtime. 1 = linear, 2 = default, 3 = finer centre. */
  exponent: number;
  /** Current virtual stick position, unit radius, before deadzone and curve. */
  readonly stick: { x: number; y: number };
  /** True while the pointer is locked (always true when driven headless). */
  readonly locked: boolean;
}

/** One pulse-key's state machine: tap = exactly PULSE_MS, hold past HOLD_MS = until release. */
interface KeyState {
  downAt: number;
  down: boolean;
  held: boolean;
}

/**
 * Rotational controller = mouse (proportional, squared curve, springs to centre).
 * Translational controller = W/S A/D R/F (pulse: tap = PULSE_MS, hold past HOLD_MS = continuous).
 * The two never share an axis, so they compose with no arbitration rule.
 *
 * Both the clock and the event sources are injectable, so the pulse state machine and the
 * spring-back can be unit-tested with a fake clock and no browser.
 */
export function createKeyboardMouse(
  canvas?: HTMLCanvasElement | null,
  options: KeyboardMouseOptions = {},
): KeyboardMouseDevice {
  const now = options.now ?? (() => performance.now());
  const stickRange = options.stickRangePx ?? STICK_RANGE_PX;

  const hasDom = typeof document !== 'undefined';
  const keySource =
    options.keySource !== undefined
      ? options.keySource
      : hasDom && typeof window !== 'undefined'
        ? (window as unknown as EventSourceLike)
        : null;
  const mouseSource =
    options.mouseSource !== undefined
      ? options.mouseSource
      : hasDom
        ? (document as unknown as EventSourceLike)
        : null;

  /** Without a real canvas there is nothing to lock to, so treat the stick as live. */
  let locked = !(canvas && hasDom);

  const stick = { x: 0, y: 0 };
  /** Stick position when input last stopped; spring-back interpolates from it. */
  const springFrom = { x: 0, y: 0 };
  let springElapsed = 0;
  let movedThisFrame = false;

  const keys = new Map<string, KeyState>();
  let shift = false;
  let space = false;

  function clampStick(): void {
    const r = Math.hypot(stick.x, stick.y);
    if (r > 1) {
      stick.x /= r;
      stick.y /= r;
    }
  }

  function onMouseMove(event: { movementX?: number; movementY?: number }): void {
    if (!locked) return;
    const dx = event.movementX ?? 0;
    const dy = event.movementY ?? 0;
    if (dx === 0 && dy === 0) return;
    stick.x += dx / stickRange;
    stick.y += dy / stickRange;
    clampStick();
    movedThisFrame = true;
  }

  function onPointerLockChange(): void {
    if (!hasDom || !canvas) return;
    locked = document.pointerLockElement === canvas;
    if (!locked) {
      stick.x = 0;
      stick.y = 0;
      springFrom.x = 0;
      springFrom.y = 0;
      springElapsed = SPRING_MS;
    }
  }

  function onCanvasClick(): void {
    if (!hasDom || !canvas) return;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  }

  function onKeyDown(event: { code?: string; key?: string; repeat?: boolean }): void {
    const code = event.code ?? event.key ?? '';
    if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Shift') {
      shift = true;
      return;
    }
    if (code === 'Space') {
      space = true;
      return;
    }
    if (code === 'Escape') {
      if (hasDom && document.pointerLockElement) document.exitPointerLock();
      return;
    }
    if (event.repeat) return;
    if (!PULSE_BINDINGS.some((b) => b.code === code)) return;
    const state = keys.get(code);
    if (state && state.down) return;
    keys.set(code, { downAt: now(), down: true, held: false });
  }

  function onKeyUp(event: { code?: string; key?: string }): void {
    const code = event.code ?? event.key ?? '';
    if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Shift') {
      shift = false;
      return;
    }
    if (code === 'Space') {
      space = false;
      return;
    }
    const state = keys.get(code);
    if (!state) return;
    state.down = false;
    // A hold ends on release; a tap keeps firing until its PULSE_MS is spent.
    if (state.held) keys.delete(code);
  }

  if (keySource) {
    keySource.addEventListener('keydown', onKeyDown);
    keySource.addEventListener('keyup', onKeyUp);
  }
  if (mouseSource) {
    mouseSource.addEventListener('mousemove', onMouseMove);
    mouseSource.addEventListener('pointerlockchange', onPointerLockChange);
  }
  if (canvas && hasDom) canvas.addEventListener('click', onCanvasClick);

  function shape(x: number, exponent: number): number {
    return clamp(signPow(deadzone(x, 0.05), exponent), -1, 1);
  }

  const device: KeyboardMouseDevice = {
    exponent: 2,
    get stick() {
      return { x: stick.x, y: stick.y };
    },
    get locked() {
      return locked;
    },
    /** `dt` is the frame time in SECONDS, matching the rest of the sim. */
    sample(dt: number): AxisState {
      const axes = emptyAxes();
      const t = now();
      const dtMs = Math.max(0, dt) * 1000;

      // Spring-back: with no movement this frame the stick returns to centre linearly,
      // reaching exactly zero after SPRING_MS of silence. Without it, pointer lock leaves
      // the player with no physical centre to feel for.
      if (movedThisFrame) {
        springFrom.x = stick.x;
        springFrom.y = stick.y;
        springElapsed = 0;
        movedThisFrame = false;
      } else if (springElapsed < SPRING_MS) {
        springElapsed = Math.min(SPRING_MS, springElapsed + dtMs);
        const k = 1 - springElapsed / SPRING_MS;
        stick.x = springFrom.x * k;
        stick.y = springFrom.y * k;
      }

      axes.rotate.y = shape(stick.x, device.exponent);
      axes.rotate.x = shape(stick.y, device.exponent);

      for (const binding of PULSE_BINDINGS) {
        const state = keys.get(binding.code);
        if (!state) continue;
        const elapsed = t - state.downAt;
        // Tap and hold cannot be told apart before HOLD_MS, and a press shorter than
        // HOLD_MS must fire for exactly PULSE_MS and no longer. So the thruster shuts at
        // PULSE_MS regardless, and reopens only once the press outlives HOLD_MS. That
        // makes every tap the same impulse, which is what lets a player count them.
        if (state.down && elapsed >= HOLD_MS) state.held = true;
        const open = state.held ? state.down : elapsed < PULSE_MS;
        if (open) {
          axes[binding.channel][binding.axis] = clamp(
            axes[binding.channel][binding.axis] + binding.sign,
            -1,
            1,
          );
        } else if (!state.down) {
          keys.delete(binding.code);
        }
      }

      axes.fine = shift;
      axes.cutAll = space;
      return axes;
    },
    dispose(): void {
      if (keySource) {
        keySource.removeEventListener('keydown', onKeyDown);
        keySource.removeEventListener('keyup', onKeyUp);
      }
      if (mouseSource) {
        mouseSource.removeEventListener('mousemove', onMouseMove);
        mouseSource.removeEventListener('pointerlockchange', onPointerLockChange);
      }
      if (canvas && hasDom) canvas.removeEventListener('click', onCanvasClick);
      keys.clear();
    },
  };

  if (options.exponent !== undefined) device.exponent = options.exponent;
  return device;
}

/**
 * Deferred until after milestone 6. A twin-stick pad or a HOTAS drives all six axes
 * proportionally; a HOTAS is literally an RHC and a THC in hardware. Same interface,
 * so nothing outside this module changes.
 */
export function createGamepad(_index = 0): InputDevice {
  throw new Error('input/index.ts createGamepad() is not implemented yet');
}
