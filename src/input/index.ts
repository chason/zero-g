/**
 * The ONLY module that knows a keyboard, mouse or gamepad exists.
 *
 * It emits six signed axes in -1..1 plus a few flags. Nothing downstream may read a
 * raw device event: keep that line and adding a HOTAS is a new file here, not a refactor.
 *
 * Sign selects direction; `control` resolves a signed axis to one of the twelve
 * thruster groups. Deadzones, response curves, spring-back and pulse timing all live here.
 */
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
  /** Called once per rendered frame, never per physics step. */
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

/**
 * Rotational controller = mouse (proportional, squared curve, springs to centre).
 * Translational controller = W/S A/D R/F (pulse: tap = PULSE_MS, hold past HOLD_MS = continuous).
 * The two never share an axis, so they compose with no arbitration rule.
 *
 * TODO — implement:
 *   - request pointer lock on the canvas, accumulate relative deltas into a virtual stick
 *   - clamp the stick to a unit radius, apply deadzone() then signPow()
 *   - spring the stick back to centre over SPRING_MS when no input arrives
 *   - track key down/up timestamps to distinguish a tap from a hold
 */
export function createKeyboardMouse(_canvas: HTMLCanvasElement): InputDevice {
  throw new Error('input/index.ts createKeyboardMouse() is not implemented yet');
}

/**
 * Deferred until after milestone 6. A twin-stick pad or a HOTAS drives all six axes
 * proportionally; a HOTAS is literally an RHC and a THC in hardware. Same interface,
 * so nothing outside this module changes.
 */
export function createGamepad(_index = 0): InputDevice {
  throw new Error('input/index.ts createGamepad() is not implemented yet');
}
