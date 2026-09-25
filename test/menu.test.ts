import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createKeyboardMouse, keyBindings, ESC_AFTER_UNLOCK_MS, STICK_RANGE_PX, emptyAxes, type EventSourceLike } from '../src/input';
import {
  createMenu, loadSettings, saveSettings, stepAlong, applySettings, settingsOf, describePitch, describeCurve,
  describeSensitivity, STORAGE_KEY, SENSITIVITY_STEPS, CURVE_STEPS, DEFAULT_SETTINGS, type StorageLike,
} from '../src/menu';

class FakeSource implements EventSourceLike {
  private handlers = new Map<string, ((e: any) => void)[]>();
  addEventListener(type: string, handler: (e: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  removeEventListener(type: string, handler: (e: any) => void) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== handler)); }
  emit(type: string, event: any = {}) { for (const h of [...(this.handlers.get(type) ?? [])]) h(event); }
}

function harness(withCanvas = false) {
  let t = 1000;
  const keys = new FakeSource();
  const mouse = new FakeSource();
  // a canvas and a document that can hold a pointer lock, headless
  const fakeDoc = { pointerLockElement: null as unknown, exitPointerLock() { fakeDoc.pointerLockElement = null; mouse.emit('pointerlockchange'); } };
  const canvas = {
    requests: 0,
    requestPointerLock() { canvas.requests++; fakeDoc.pointerLockElement = canvas; mouse.emit('pointerlockchange'); },
    addEventListener() {}, removeEventListener() {},
  };
  const g = globalThis as unknown as { document?: unknown };
  const saved = g.document;
  if (withCanvas) g.document = fakeDoc;
  const device = createKeyboardMouse(withCanvas ? (canvas as unknown as HTMLCanvasElement) : null, {
    now: () => t, keySource: keys, mouseSource: mouse,
  });
  return {
    device, keys, mouse, canvas, fakeDoc,
    advance(ms: number) { t += ms; },
    restore() { g.document = saved; },
  };
}

describe('the menu key (#56)', () => {
  it('Esc with the pointer free raises the menu flag for exactly one sample', () => {
    const h = harness();
    h.keys.emit('keydown', { code: 'Escape' });
    expect(h.device.sample(1 / 60).menu).toBe(true);
    expect(h.device.sample(1 / 60).menu).toBe(false);
    h.keys.emit('keydown', { code: 'Escape', repeat: true }); // auto-repeat never counts
    expect(h.device.sample(1 / 60).menu).toBe(false);
    expect(emptyAxes().menu).toBe(false);
  });

  it('with the pointer locked, Esc lets go of the mouse, and the lock going away is the request', () => {
    const h = harness(true);
    try {
      h.device.capture();
      expect(h.device.locked).toBe(true);
      expect(h.canvas.requests).toBe(1);
      h.keys.emit('keydown', { code: 'Escape' });
      expect(h.device.locked).toBe(false);
      const a = h.device.sample(1 / 60);
      expect(a.menu).toBe(true);
      // the browser may also deliver the keydown after unlocking on its own: same press, not a second request
      h.keys.emit('keydown', { code: 'Escape' });
      expect(h.device.sample(1 / 60).menu).toBe(false);
      // a real second press, later, counts
      h.advance(ESC_AFTER_UNLOCK_MS + 1);
      h.keys.emit('keydown', { code: 'Escape' });
      expect(h.device.sample(1 / 60).menu).toBe(true);
    } finally { h.restore(); }
  });

  it('losing the lock for any reason (a tab-out) asks for the menu; gaining it does not', () => {
    const h = harness(true);
    try {
      h.device.capture();
      expect(h.device.sample(1 / 60).menu).toBe(false);
      h.fakeDoc.exitPointerLock();
      expect(h.device.sample(1 / 60).menu).toBe(true);
      h.device.capture();
      expect(h.device.sample(1 / 60).menu).toBe(false);
      h.device.release();
      expect(h.device.locked).toBe(false);
    } finally { h.restore(); }
  });

  it('inverting pitch flips the mouse pitch axis and nothing else', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: 0, movementY: 200 }); // toward the pilot
    const a = h.device.sample(1 / 60);
    expect(a.rotate.x).toBeGreaterThan(0); // nose up, joystick convention
    h.device.invertPitch = true;
    h.mouse.emit('mousemove', { movementX: 0, movementY: 200 });
    const b = h.device.sample(1 / 60);
    expect(b.rotate.x).toBeLessThan(0);
    expect(Math.abs(b.rotate.y)).toBe(0);
  });

  it('a shorter stick range is a more sensitive mouse', () => {
    const h = harness();
    expect(h.device.stickRangePx).toBe(STICK_RANGE_PX);
    h.mouse.emit('mousemove', { movementX: 100, movementY: 0 });
    const wide = Math.abs(h.device.sample(1 / 60).rotate.y);
    const h2 = harness();
    h2.device.stickRangePx = STICK_RANGE_PX / 2;
    h2.mouse.emit('mousemove', { movementX: 100, movementY: 0 });
    const narrow = Math.abs(h2.device.sample(1 / 60).rotate.y);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('lists every control, the pulse keys from their bindings, in a pilot\'s order', () => {
    const rows = keyBindings();
    const keys = rows.map((r) => r.key);
    expect(keys.slice(0, 8)).toEqual(['W', 'S', 'A', 'D', 'R', 'F', 'Q', 'E']);
    expect(keys).toEqual(expect.arrayContaining(['MOUSE', 'SHIFT', 'SPACE', 'V', 'TAB', 'ENTER', 'ESC']));
    const action = (k: string) => rows.find((r) => r.key === k)!.action;
    expect(action('W')).toMatch(/forward/);
    expect(action('S')).toMatch(/retro/);
    expect(action('R')).toBe('up');
    expect(action('F')).toBe('down');
    expect(action('E')).toBe('roll right');
    expect(action('Q')).toBe('roll left');
    expect(action('SHIFT')).toMatch(/15%/);
    expect(action('ESC')).toBe('options');
  });
});

describe('menu settings (#56)', () => {
  function memory(): StorageLike & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
  }

  it('loads defaults with no storage, a blank one, or garbage in it', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = memory();
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.data[STORAGE_KEY] = 'not json';
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.data[STORAGE_KEY] = JSON.stringify({ invertPitch: 'yes', stickRangePx: -3, exponent: 2.5 });
    expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, exponent: 2.5 });
  });

  it('round-trips through storage and onto a device', () => {
    const s = memory();
    saveSettings(s, { invertPitch: true, stickRangePx: 250, exponent: 3 });
    expect(loadSettings(s)).toEqual({ invertPitch: true, stickRangePx: 250, exponent: 3 });
    const h = harness();
    applySettings(h.device, loadSettings(s));
    expect(settingsOf(h.device)).toEqual({ invertPitch: true, stickRangePx: 250, exponent: 3 });
  });

  it('steps along a list, snapping an off-list value to its nearest step and clamping at the ends', () => {
    expect(stepAlong(SENSITIVITY_STEPS, 400, 1)).toBe(500);
    expect(stepAlong(SENSITIVITY_STEPS, 400, -1)).toBe(300);
    expect(stepAlong(SENSITIVITY_STEPS, 410, 1)).toBe(500);
    expect(stepAlong(SENSITIVITY_STEPS, 150, -1)).toBe(150);
    expect(stepAlong(SENSITIVITY_STEPS, 800, 1)).toBe(800);
    expect(stepAlong(CURVE_STEPS, 2, 1)).toBe(2.5);
    expect(describePitch(false)).toMatch(/PULL BACK/);
    expect(describePitch(true)).toMatch(/PUSH FORWARD/);
    expect(describeCurve(1)).toBe('LINEAR');
    expect(describeCurve(2)).toBe('POWER 2');
    expect(describeSensitivity(400)).toBe('400 PX TO FULL STICK');
  });
});

describe('the menu on screen (#56)', () => {
  class El {
    children: El[] = []; className = ''; textContent = ''; style: Record<string, string> = {};
    handlers = new Map<string, ((e: any) => void)[]>();
    classes = new Set<string>();
    classList = {
      add: (c: string) => { this.classes.add(c); },
      remove: (c: string) => { this.classes.delete(c); },
      contains: (c: string) => this.classes.has(c),
    };
    appendChild(c: El) { this.children.push(c); return c; }
    addEventListener(t: string, h: (e: any) => void) { this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]); }
    click(target?: El) { for (const h of this.handlers.get('click') ?? []) h({ target: target ?? this }); }
    find(className: string): El[] {
      const out: El[] = [];
      for (const c of this.children) { if (c.className === className) out.push(c); out.push(...c.find(className)); }
      return out;
    }
  }
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  beforeAll(() => { saved = g.document; g.document = { createElement: () => new El() }; });
  afterAll(() => { g.document = saved; });

  it('builds a row per binding, opens and closes, and a click on the backdrop resumes', () => {
    const h = harness();
    const root = new El();
    let resumed = 0;
    const menu = createMenu(root as unknown as HTMLElement, { device: h.device, storage: null, onResume: () => { resumed++; } });
    expect(root.find('menu-key').length).toBe(keyBindings().length);
    expect(root.find('menu-key-cap').map((e) => e.textContent)).toContain('ESC');
    expect(menu.open).toBe(false);
    menu.show();
    expect(menu.open).toBe(true);
    expect(root.classes.has('open')).toBe(true);
    menu.toggle();
    expect(menu.open).toBe(false);
    expect(root.classes.has('open')).toBe(false);
    menu.show();
    root.click(root.children[0]); // on the panel: stays open
    expect(menu.open).toBe(true);
    expect(resumed).toBe(0);
    root.click(); // on the backdrop: resumes
    expect(menu.open).toBe(false);
    expect(resumed).toBe(1);
  });

  it('its buttons change the device and persist, and stored settings are applied on creation', () => {
    const s = { data: {} as Record<string, string>, getItem: (k: string) => s.data[k] ?? null, setItem: (k: string, v: string) => { s.data[k] = v; } };
    s.data[STORAGE_KEY] = JSON.stringify({ invertPitch: true, stickRangePx: 300, exponent: 1 });
    const h = harness();
    const root = new El();
    createMenu(root as unknown as HTMLElement, { device: h.device, storage: s });
    expect(h.device.invertPitch).toBe(true);
    expect(h.device.stickRangePx).toBe(300);
    expect(h.device.exponent).toBe(1);
    const rows = root.find('menu-setting');
    expect(rows.length).toBe(3);
    const [pitch, sensitivity, curve] = rows;
    const buttons = (row: El) => row.find('menu-btn');
    const value = (row: El) => row.find('menu-setting-value')[0]!.textContent;
    buttons(pitch!)[0]!.click();
    expect(h.device.invertPitch).toBe(false);
    expect(value(pitch!)).toMatch(/PULL BACK/);
    buttons(sensitivity!)[1]!.click(); // '>' is more sensitive: fewer px
    expect(h.device.stickRangePx).toBe(250);
    expect(value(sensitivity!)).toBe('250 PX TO FULL STICK');
    buttons(curve!)[1]!.click();
    expect(h.device.exponent).toBe(1.5);
    expect(JSON.parse(s.data[STORAGE_KEY]!)).toEqual({ invertPitch: false, stickRangePx: 250, exponent: 1.5 });
  });
});
