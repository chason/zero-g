import { keyBindings, STICK_RANGE_PX, type KeyboardMouseDevice } from '../input';

/**
 * The options menu (#56): Esc opens it, Esc or a click outside it resumes. While it is
 * open the sim is paused (main.ts owns that) and the pointer is free, so the menu can be
 * clicked. It lists every control, straight from the input module so it cannot drift
 * from the bindings, and holds the three mouse settings the device exposes. Settings
 * persist in localStorage when there is one.
 *
 * DOM only. Nothing here reads a device event or touches the sim.
 */
export interface MenuSettings {
  invertPitch: boolean;
  stickRangePx: number;
  exponent: number;
}

export const STORAGE_KEY = 'zero-g.options';
/** stick range steps, px: fewer is more sensitive */
export const SENSITIVITY_STEPS: readonly number[] = [150, 200, 250, 300, 400, 500, 650, 800];
export const CURVE_STEPS: readonly number[] = [1, 1.5, 2, 2.5, 3];

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_SETTINGS: Readonly<MenuSettings> = { invertPitch: false, stickRangePx: STICK_RANGE_PX, exponent: 2 };

/** Settings from storage, with anything missing or malformed falling back to the defaults. */
export function loadSettings(storage: StorageLike | null | undefined): MenuSettings {
  const out: MenuSettings = { ...DEFAULT_SETTINGS };
  if (!storage) return out;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<Record<keyof MenuSettings, unknown>>;
    if (typeof parsed.invertPitch === 'boolean') out.invertPitch = parsed.invertPitch;
    if (typeof parsed.stickRangePx === 'number' && parsed.stickRangePx > 0) out.stickRangePx = parsed.stickRangePx;
    if (typeof parsed.exponent === 'number' && parsed.exponent > 0) out.exponent = parsed.exponent;
  } catch {
    // unreadable storage is the same as none
  }
  return out;
}

export function saveSettings(storage: StorageLike | null | undefined, settings: MenuSettings): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // a full or blocked storage loses nothing but persistence
  }
}

/** Read the device's current settings. */
export function settingsOf(device: KeyboardMouseDevice): MenuSettings {
  return { invertPitch: device.invertPitch, stickRangePx: device.stickRangePx, exponent: device.exponent };
}

/** Push settings onto the device. */
export function applySettings(device: KeyboardMouseDevice, settings: MenuSettings): void {
  device.invertPitch = settings.invertPitch;
  device.stickRangePx = settings.stickRangePx;
  device.exponent = settings.exponent;
}

/** The next value along `steps` from `current` (or the nearest step when current is off the list), clamped at the ends. */
export function stepAlong(steps: readonly number[], current: number, direction: 1 | -1): number {
  let nearest = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i]! - current) < Math.abs(steps[nearest]! - current)) nearest = i;
  }
  const i = Math.max(0, Math.min(steps.length - 1, nearest + direction));
  return steps[i]!;
}

/** How a setting reads on the menu. */
export function describeSensitivity(stickRangePx: number): string {
  return `${Math.round(stickRangePx)} PX TO FULL STICK`;
}
export function describeCurve(exponent: number): string {
  return exponent === 1 ? 'LINEAR' : `POWER ${exponent}`;
}
export function describePitch(invert: boolean): string {
  return invert ? 'PUSH FORWARD = NOSE UP' : 'PULL BACK = NOSE UP';
}

export interface MenuOptions {
  device: KeyboardMouseDevice;
  storage?: StorageLike | null;
  /** called after the menu hides itself because the pilot clicked outside it: take the mouse back */
  onResume?: () => void;
}

export interface Menu {
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** the root element the menu built, for tests and styling hooks */
  readonly element: HTMLElement;
}

export function createMenu(root: HTMLElement, options: MenuOptions): Menu {
  const { device } = options;
  const storage = options.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : options.storage;
  applySettings(device, loadSettings(storage));

  const el = (tag: string, className: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  root.className = 'menu';
  const panel = el('div', 'menu-panel');
  panel.appendChild(el('div', 'menu-title', 'OPTIONS'));
  panel.appendChild(el('div', 'menu-sub', 'PAUSED'));

  // Controls
  panel.appendChild(el('div', 'menu-head', 'CONTROLS'));
  const table = el('div', 'menu-keys');
  for (const b of keyBindings()) {
    const row = el('div', 'menu-key');
    row.appendChild(el('span', 'menu-key-cap', b.key));
    row.appendChild(el('span', 'menu-key-act', b.action.toUpperCase()));
    table.appendChild(row);
  }
  panel.appendChild(table);

  // Settings
  panel.appendChild(el('div', 'menu-head', 'MOUSE'));
  const settings = el('div', 'menu-settings');
  function settingRow(label: string, read: () => string, less: () => void, more: () => void): () => void {
    const row = el('div', 'menu-setting');
    row.appendChild(el('span', 'menu-setting-label', label));
    const minus = el('button', 'menu-btn', '<');
    const value = el('span', 'menu-setting-value', read());
    const plus = el('button', 'menu-btn', '>');
    row.appendChild(minus);
    row.appendChild(value);
    row.appendChild(plus);
    const refresh = () => { value.textContent = read(); };
    minus.addEventListener('click', () => { less(); refresh(); persist(); });
    plus.addEventListener('click', () => { more(); refresh(); persist(); });
    settings.appendChild(row);
    return refresh;
  }
  const persist = () => saveSettings(storage, settingsOf(device));
  settingRow('PITCH', () => describePitch(device.invertPitch),
    () => { device.invertPitch = !device.invertPitch; },
    () => { device.invertPitch = !device.invertPitch; });
  settingRow('SENSITIVITY', () => describeSensitivity(device.stickRangePx),
    () => { device.stickRangePx = stepAlong(SENSITIVITY_STEPS, device.stickRangePx, 1); }, // more px = less sensitive
    () => { device.stickRangePx = stepAlong(SENSITIVITY_STEPS, device.stickRangePx, -1); });
  settingRow('CURVE', () => describeCurve(device.exponent),
    () => { device.exponent = stepAlong(CURVE_STEPS, device.exponent, -1); },
    () => { device.exponent = stepAlong(CURVE_STEPS, device.exponent, 1); });
  panel.appendChild(settings);

  panel.appendChild(el('div', 'menu-hint', 'ESC OR CLICK OUTSIDE TO RESUME'));
  root.appendChild(panel);

  let open = false;
  const menu: Menu = {
    get open() { return open; },
    element: root,
    show() {
      if (open) return;
      open = true;
      root.classList.add('open');
    },
    hide() {
      if (!open) return;
      open = false;
      root.classList.remove('open');
    },
    toggle() {
      if (open) menu.hide();
      else menu.show();
    },
  };
  // A click on the backdrop, not the panel, resumes and hands the mouse back.
  root.addEventListener('click', (event: { target?: unknown }) => {
    if (event.target !== root) return;
    menu.hide();
    options.onResume?.();
  });
  return menu;
}
