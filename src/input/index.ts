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
  /** V: true on the one sample after the key goes down, then false until it is released and pressed again */
  toggleView: boolean;
  /** Tab: same edge semantics as toggleView; advances world.selected through world.targets */
  cycleTarget: boolean;
  /** Enter: same edge semantics; restarts the run in place, at any time (#34) */
  restart: boolean;
  /**
   * Esc, or the pointer lock going away: the pilot wants the options menu (#56). Edge
   * semantics like the others. One request per frame however it arrived, so the
   * browser's own Esc handling of pointer lock and the keydown it may also deliver
   * cannot open and close the menu in one go.
   */
  menu: boolean;
}

export interface InputDevice {
  /** Called once per rendered frame, never per physics step. `dt` is in seconds. */
  sample(dt: number): AxisState;
  dispose(): void;
}

export const FINE_SCALE = 0.15;
/**
 * A press opens its thruster for at LEAST this long, giving a known quantum of delta-v.
 * Any tap at or under PULSE_MS delivers exactly the same impulse, so taps stay countable.
 */
export const PULSE_MS = 60;
/** The virtual stick recentres over roughly this long with no input. */
export const SPRING_MS = 300;

export function emptyAxes(): AxisState {
  return {
    translate: { x: 0, y: 0, z: 0 },
    rotate: { x: 0, y: 0, z: 0 },
    fine: false,
    cutAll: false,
    toggleView: false,
    cycleTarget: false,
    restart: false,
    menu: false,
  };
}

/** An Esc keydown this soon after the pointer lock went away is the same press that took the lock, not a second one. */
export const ESC_AFTER_UNLOCK_MS = 250;

/** Pixels of pointer travel that move the virtual stick from centre to full deflection. */
export const STICK_RANGE_PX = 400;

/** Keys the translational controller and the roll axis listen to. */
const PULSE_BINDINGS: ReadonlyArray<{
  code: string;
  channel: 'translate' | 'rotate';
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
}> = [
  // The nose is body -Z (the hull is built that way and the cockpit camera looks down
  // -Z), so "forward" is a NEGATIVE z demand. Getting this sign wrong puts the main
  // engine on S; test/handedness.test.ts pins it.
  { code: 'KeyW', channel: 'translate', axis: 'z', sign: -1 },
  { code: 'KeyS', channel: 'translate', axis: 'z', sign: 1 },
  { code: 'KeyD', channel: 'translate', axis: 'x', sign: 1 },
  { code: 'KeyA', channel: 'translate', axis: 'x', sign: -1 },
  { code: 'KeyR', channel: 'translate', axis: 'y', sign: 1 },
  { code: 'KeyF', channel: 'translate', axis: 'y', sign: -1 },
  // Roll right (starboard wing down, clockwise from the seat) is rotation about the
  // nose axis, which is -Z: a NEGATIVE z torque demand.
  { code: 'KeyE', channel: 'rotate', axis: 'z', sign: -1 },
  { code: 'KeyQ', channel: 'rotate', axis: 'z', sign: 1 },
];

export interface KeyBinding {
  /** the key as printed on it */
  key: string;
  /** what it does, for a pilot */
  action: string;
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  KeyW: 'W', KeyS: 'S', KeyA: 'A', KeyD: 'D', KeyR: 'R', KeyF: 'F', KeyQ: 'Q', KeyE: 'E',
};

/** The action each pulse binding performs, worded for the options menu. */
function describe(b: (typeof PULSE_BINDINGS)[number]): string {
  if (b.channel === 'translate') {
    if (b.axis === 'z') return b.sign < 0 ? 'forward (main engine)' : 'retro';
    if (b.axis === 'x') return b.sign > 0 ? 'right' : 'left';
    return b.sign > 0 ? 'up' : 'down';
  }
  return b.sign < 0 ? 'roll right' : 'roll left';
}

/**
 * Every control, as the options menu lists it (#56): the pulse keys straight from
 * PULSE_BINDINGS, so a rebinding there shows here with no second table to forget, then
 * the mouse and the fixed keys.
 */
export function keyBindings(): KeyBinding[] {
  const find = (channel: 'translate' | 'rotate', axis: 'x' | 'y' | 'z', sign: 1 | -1) =>
    PULSE_BINDINGS.find((b) => b.channel === channel && b.axis === axis && b.sign === sign);
  const order = [
    find('translate', 'z', -1), find('translate', 'z', 1),
    find('translate', 'x', -1), find('translate', 'x', 1),
    find('translate', 'y', 1), find('translate', 'y', -1),
    find('rotate', 'z', 1), find('rotate', 'z', -1),
  ];
  const rows: KeyBinding[] = [];
  for (const b of order) {
    if (b) rows.push({ key: KEY_LABELS[b.code] ?? b.code, action: describe(b) });
  }
  for (const b of PULSE_BINDINGS) {
    if (!order.includes(b)) rows.push({ key: KEY_LABELS[b.code] ?? b.code, action: describe(b) });
  }
  rows.push(
    { key: 'MOUSE', action: 'yaw and pitch, proportional' },
    { key: 'SHIFT', action: `fine: ${Math.round(FINE_SCALE * 100)}% thrust while held` },
    { key: 'SPACE', action: 'cut all thrust' },
    { key: 'V', action: 'cockpit / chase view' },
    { key: 'TAB', action: 'cycle target' },
    { key: 'ENTER', action: 'restart with a new seed' },
    { key: 'ESC', action: 'options' },
  );
  return rows;
}

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
  /** Mouse toward the pilot is nose UP by default (joystick convention); true flips it (#56). */
  invertPitch: boolean;
  /** Pixels from centre to full stick deflection, settable at runtime: fewer is more sensitive (#56). */
  stickRangePx: number;
  /** Current virtual stick position, unit radius, before deadzone and curve. */
  readonly stick: { x: number; y: number };
  /** True while the pointer is locked (always true when driven headless). */
  readonly locked: boolean;
  /** Take the pointer, if there is a canvas to take it for: what a click on it does. */
  capture(): void;
  /** Let the pointer go. */
  release(): void;
}

/** One pulse-key's state machine: open while down, for a minimum of PULSE_MS. */
interface KeyState {
  downAt: number;
  down: boolean;
}

/**
 * Rotational controller = mouse (proportional, squared curve, springs to centre).
 * Translational controller = W/S A/D R/F (open while held, minimum PULSE_MS per press).
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
  /** the options menu was asked for since the last sample() */
  let menuPending = false;
  let lockLostAt = -Infinity;

  /**
   * Edge-triggered keys. `down` blocks auto-repeat and a second keydown while held;
   * `pending` latches the press until the next sample() reads and clears it, so a tap
   * shorter than one frame still registers exactly once.
   */
  const edge = {
    view: { down: false, pending: false },
    target: { down: false, pending: false },
    restart: { down: false, pending: false },
  };

  function press(e: { down: boolean; pending: boolean }, repeat: boolean | undefined): void {
    if (repeat || e.down) return;
    e.down = true;
    e.pending = true;
  }

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
    stick.x += dx / device.stickRangePx;
    stick.y += dy / device.stickRangePx;
    clampStick();
    movedThisFrame = true;
  }

  function onPointerLockChange(): void {
    if (!hasDom || !canvas) return;
    const was = locked;
    locked = document.pointerLockElement === canvas;
    if (!locked) {
      stick.x = 0;
      stick.y = 0;
      springFrom.x = 0;
      springFrom.y = 0;
      springElapsed = SPRING_MS;
      // Losing the lock — Esc, which the browser may handle without telling us, or a
      // tab-out — is a request for the menu: the pilot is no longer flying.
      if (was) {
        menuPending = true;
        lockLostAt = now();
      }
    }
  }

  function capture(): void {
    if (!hasDom || !canvas) return;
    if (document.pointerLockElement !== canvas) {
      // Returns a promise in newer browsers; a refusal (asked too soon after an Esc,
      // say) just leaves the pointer free, and the next click asks again.
      const result = canvas.requestPointerLock() as unknown;
      if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(() => {});
    }
  }

  function release(): void {
    if (!hasDom) return;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function onCanvasClick(): void {
    capture();
  }

  function onKeyDown(event: {
    code?: string;
    key?: string;
    repeat?: boolean;
    preventDefault?: () => void;
  }): void {
    const code = event.code ?? event.key ?? '';
    if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Shift') {
      shift = true;
      return;
    }
    if (code === 'Space') {
      space = true;
      return;
    }
    if (code === 'KeyV') {
      press(edge.view, event.repeat);
      return;
    }
    if (code === 'Tab') {
      // Tab would otherwise walk browser focus off the canvas.
      event.preventDefault?.();
      press(edge.target, event.repeat);
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      press(edge.restart, event.repeat);
      return;
    }
    if (code === 'Escape') {
      if (hasDom && document.pointerLockElement) {
        // Let go of the mouse; the lock change is what raises the menu.
        document.exitPointerLock();
      } else if (!event.repeat && now() - lockLostAt > ESC_AFTER_UNLOCK_MS) {
        menuPending = true;
      }
      return;
    }
    if (event.repeat) return;
    if (!PULSE_BINDINGS.some((b) => b.code === code)) return;
    const state = keys.get(code);
    if (state && state.down) return;
    keys.set(code, { downAt: now(), down: true });
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
    if (code === 'KeyV') {
      edge.view.down = false;
      return;
    }
    if (code === 'Tab') {
      edge.target.down = false;
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      edge.restart.down = false;
      return;
    }
    const state = keys.get(code);
    if (!state) return;
    state.down = false;
    // The state stays until sample() sees the minimum PULSE_MS spent: a tap released
    // early must keep firing to the 60 ms mark, and a longer press ends here.
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
    invertPitch: false,
    stickRangePx: options.stickRangePx ?? STICK_RANGE_PX,
    get stick() {
      return { x: stick.x, y: stick.y };
    },
    get locked() {
      return locked;
    },
    capture,
    release,
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

      // Stick right = yaw right = nose toward +X. For a nose on -Z that is rotation
      // about -Y, so the demand is negated. Stick back (mouse toward the pilot, +y)
      // = pitch up = rotation about +X: joystick convention, sign as-is.
      axes.rotate.y = shape(-stick.x, device.exponent); // shape() returns +0 for a centred stick
      axes.rotate.x = shape(device.invertPitch ? -stick.y : stick.y, device.exponent);

      for (const binding of PULSE_BINDINGS) {
        const state = keys.get(binding.code);
        if (!state) continue;
        const elapsed = t - state.downAt;
        // The thruster is open while the key is down, with a MINIMUM open time of
        // PULSE_MS. Released early, it stays open to exactly the PULSE_MS mark, so every
        // tap at or under 60 ms is the same quantum of delta-v and taps stay countable.
        // Held longer, it is open continuously from t=0 until release: there is no point
        // at which a held key stops thrusting, which is what the old HOLD_MS gate got
        // wrong (issue #30).
        const open = state.down || elapsed < PULSE_MS;
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
      // Edge flags: read once, then cleared, so each press is seen by exactly one frame.
      axes.toggleView = edge.view.pending;
      edge.view.pending = false;
      axes.cycleTarget = edge.target.pending;
      edge.target.pending = false;
      axes.restart = edge.restart.pending;
      edge.restart.pending = false;
      axes.menu = menuPending;
      menuPending = false;
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
      edge.view.down = edge.view.pending = false;
      edge.target.down = edge.target.pending = false;
      edge.restart.down = edge.restart.pending = false;
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
