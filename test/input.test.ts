import { describe, it, expect } from 'vitest';
import { deadzone, signPow } from '../src/core/math';
import {
  createKeyboardMouse,
  PULSE_MS,
  SPRING_MS,
  STICK_RANGE_PX,
  type EventSourceLike,
} from '../src/input';

/** A stand-in for window/document: collects handlers so a test can fire events by hand. */
class FakeSource implements EventSourceLike {
  private handlers = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, handler: (event: any) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  removeEventListener(type: string, handler: (event: any) => void): void {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(
      type,
      list.filter((h) => h !== handler),
    );
  }
  emit(type: string, event: unknown = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }
  count(type: string): number {
    return (this.handlers.get(type) ?? []).length;
  }
}

/** Fake clock in milliseconds, advanced explicitly by the test. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function harness() {
  const clock = fakeClock();
  const keys = new FakeSource();
  const mouse = new FakeSource();
  const device = createKeyboardMouse(null, {
    now: clock.now,
    keySource: keys,
    mouseSource: mouse,
  });
  return { clock, keys, mouse, device };
}

/**
 * Step the device forward in `stepMs` slices, summing the time during which `read`
 * reports a non-zero demand. Optionally release the key at a given elapsed time.
 */
function runKey(
  h: ReturnType<typeof harness>,
  code: string,
  pressMs: number,
  totalMs: number,
  read: (axes: ReturnType<typeof h.device.sample>) => number,
  stepMs = 5,
): { openMs: number; samples: number[] } {
  const samples: number[] = [];
  let openMs = 0;
  h.keys.emit('keydown', { code });
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    if (elapsed >= pressMs && elapsed - stepMs < pressMs) h.keys.emit('keyup', { code });
    const value = read(h.device.sample(stepMs / 1000));
    samples.push(value);
    if (value !== 0) openMs += stepMs;
    h.clock.advance(stepMs);
  }
  return { openMs, samples };
}

describe('pulse keys', () => {
  it('a 10 ms tap still fires for exactly PULSE_MS', () => {
    const h = harness();
    const { openMs } = runKey(h, 'KeyW', 10, 400, (a) => a.translate.z);
    expect(openMs).toBe(PULSE_MS);
  });

  it('a tap fires a full pulse even when released before PULSE_MS elapses', () => {
    const h = harness();
    // released at 10 ms, but output must continue to the 60 ms mark and then stop
    const { samples } = runKey(h, 'KeyA', 10, 200, (a) => a.translate.x, 10);
    expect(samples.slice(0, PULSE_MS / 10).every((v) => v === -1)).toBe(true);
    expect(samples.slice(PULSE_MS / 10).every((v) => v === 0)).toBe(true);
  });

  it('a press longer than PULSE_MS is open for the whole press, not just the pulse', () => {
    const h = harness();
    const { openMs, samples } = runKey(h, 'KeyW', 150, 500, (a) => a.translate.z);
    // PULSE_MS is a MINIMUM, not a cap: the thruster is open while the key is down.
    expect(openMs).toBe(150);
    for (let i = 0; i < 150 / 5; i += 1) expect(samples[i]).toBe(1);
    for (let i = 150 / 5; i < samples.length; i += 1) expect(samples[i]).toBe(0);
  });

  it('a 500 ms hold produces 500 ms of continuous output, and stops at release', () => {
    const h = harness();
    const { openMs, samples } = runKey(h, 'KeyW', 500, 700, (a) => a.translate.z);
    // Open from t=0 until release with NO interruption anywhere in the middle: the old
    // rules shut the thruster at PULSE_MS and reopened it at HOLD_MS, a 140 ms dead gap
    // in the middle of a held key (issue #30).
    expect(openMs).toBe(500);
    for (let i = 0; i < 500 / 5; i += 1) expect(samples[i]).toBe(1);
    // and shut on release
    for (let i = 500 / 5; i < samples.length; i += 1) expect(samples[i]).toBe(0);
    // no zero anywhere inside the hold — the dead gap is gone
    expect(samples.slice(0, 500 / 5).includes(0)).toBe(false);
  });

  it('a longer hold lasts as long as the key is down', () => {
    const short = harness();
    const long = harness();
    const a = runKey(short, 'KeyW', 300, 800, (x) => x.translate.z).openMs;
    const b = runKey(long, 'KeyW', 600, 800, (x) => x.translate.z).openMs;
    expect(b - a).toBe(300);
  });

  it('a tap at exactly PULSE_MS is the same quantum as a shorter one', () => {
    const h = harness();
    const short = runKey(h, 'KeyW', 10, 300, (a) => a.translate.z).openMs;
    const exact = runKey(harness(), 'KeyW', PULSE_MS, 300, (a) => a.translate.z).openMs;
    expect(short).toBe(PULSE_MS);
    expect(exact).toBe(PULSE_MS);
  });

  it('three identical taps produce three identical impulse durations', () => {
    const h = harness();
    const durations: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      durations.push(runKey(h, 'KeyD', 10, 300, (a) => a.translate.x).openMs);
    }
    expect(durations).toEqual([PULSE_MS, PULSE_MS, PULSE_MS]);
  });

  it('binds W/S, A/D, R/F to translation and Q/E to roll, with opposed signs', () => {
    const cases: Array<[string, 'translate' | 'rotate', 'x' | 'y' | 'z', number]> = [
      ['KeyW', 'translate', 'z', 1],
      ['KeyS', 'translate', 'z', -1],
      ['KeyD', 'translate', 'x', 1],
      ['KeyA', 'translate', 'x', -1],
      ['KeyR', 'translate', 'y', 1],
      ['KeyF', 'translate', 'y', -1],
      ['KeyE', 'rotate', 'z', 1],
      ['KeyQ', 'rotate', 'z', -1],
    ];
    for (const [code, channel, axis, sign] of cases) {
      const h = harness();
      h.keys.emit('keydown', { code });
      const axes = h.device.sample(0);
      expect(axes[channel][axis]).toBe(sign);
    }
  });

  it('opposed keys held together cancel, and rotation is untouched by translation keys', () => {
    const h = harness();
    h.keys.emit('keydown', { code: 'KeyW' });
    h.keys.emit('keydown', { code: 'KeyS' });
    const axes = h.device.sample(0);
    expect(axes.translate.z).toBe(0);
    expect(axes.rotate.x).toBe(0);
    expect(axes.rotate.y).toBe(0);
  });

  it('sets fine on Shift and cutAll on Space, clearing both on release', () => {
    const h = harness();
    h.keys.emit('keydown', { code: 'ShiftLeft' });
    h.keys.emit('keydown', { code: 'Space' });
    let axes = h.device.sample(0);
    expect(axes.fine).toBe(true);
    expect(axes.cutAll).toBe(true);
    h.keys.emit('keyup', { code: 'ShiftLeft' });
    h.keys.emit('keyup', { code: 'Space' });
    axes = h.device.sample(0);
    expect(axes.fine).toBe(false);
    expect(axes.cutAll).toBe(false);
  });
});

describe('virtual stick', () => {
  it('maps mouse X to yaw and mouse Y to pitch, and nothing to translation', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: STICK_RANGE_PX, movementY: 0 });
    let axes = h.device.sample(0);
    expect(axes.rotate.y).toBeGreaterThan(0);
    expect(axes.rotate.x).toBe(0);
    expect(axes.translate.x).toBe(0);
    expect(axes.translate.y).toBe(0);
    expect(axes.translate.z).toBe(0);

    const g = harness();
    g.mouse.emit('mousemove', { movementX: 0, movementY: -STICK_RANGE_PX });
    axes = g.device.sample(0);
    expect(axes.rotate.x).toBeLessThan(0);
    expect(axes.rotate.y).toBe(0);
  });

  it('clamps the stick to a unit radius however far the mouse travels', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: 10 * STICK_RANGE_PX, movementY: 10 * STICK_RANGE_PX });
    expect(Math.hypot(h.device.stick.x, h.device.stick.y)).toBeCloseTo(1, 10);
    const axes = h.device.sample(0);
    expect(Math.abs(axes.rotate.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(axes.rotate.x)).toBeLessThanOrEqual(1);
  });

  it('shapes each axis with deadzone then signPow, with a settable exponent', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: 0.5 * STICK_RANGE_PX, movementY: 0 });
    expect(h.device.sample(0).rotate.y).toBeCloseTo(signPow(deadzone(0.5, 0.05), 2), 10);
    h.device.exponent = 3;
    expect(h.device.sample(0).rotate.y).toBeCloseTo(signPow(deadzone(0.5, 0.05), 3), 10);
  });

  it('rejects deflection inside the 5% deadzone', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: 0.04 * STICK_RANGE_PX, movementY: 0 });
    expect(h.device.sample(0).rotate.y).toBe(0);
  });

  it('returns to zero after SPRING_MS of no input', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: STICK_RANGE_PX, movementY: STICK_RANGE_PX });
    expect(h.device.sample(0).rotate.y).toBeGreaterThan(0);

    const step = 0.01; // 10 ms frames
    let elapsed = 0;
    let last = 1;
    while (elapsed < SPRING_MS) {
      const axes = h.device.sample(step);
      expect(Math.abs(axes.rotate.y)).toBeLessThanOrEqual(last + 1e-12);
      last = Math.abs(axes.rotate.y);
      elapsed += SPRING_MS / 30;
    }
    const axes = h.device.sample(step);
    expect(h.device.stick.x).toBe(0);
    expect(h.device.stick.y).toBe(0);
    expect(axes.rotate.y).toBe(0);
    expect(axes.rotate.x).toBe(0);
  });

  it('is still deflected part-way through the spring-back', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: STICK_RANGE_PX, movementY: 0 });
    h.device.sample(0);
    h.device.sample(SPRING_MS / 2 / 1000);
    expect(h.device.stick.x).toBeCloseTo(0.5, 10);
    h.device.sample(SPRING_MS / 2 / 1000);
    expect(h.device.stick.x).toBe(0);
  });

  it('restarts the spring from the new position when the mouse moves again', () => {
    const h = harness();
    h.mouse.emit('mousemove', { movementX: STICK_RANGE_PX, movementY: 0 });
    h.device.sample(0);
    h.device.sample(SPRING_MS / 2 / 1000);
    expect(h.device.stick.x).toBeCloseTo(0.5, 10);
    h.mouse.emit('mousemove', { movementX: 0.25 * STICK_RANGE_PX, movementY: 0 });
    h.device.sample(0);
    expect(h.device.stick.x).toBeCloseTo(0.75, 10);
    h.device.sample(SPRING_MS / 1000);
    expect(h.device.stick.x).toBe(0);
  });
});

describe('deadzone and signPow at the boundaries', () => {
  it('deadzone zeroes at and below the threshold and rescales above it', () => {
    expect(deadzone(0, 0.05)).toBe(0);
    expect(deadzone(0.05, 0.05)).toBe(0);
    expect(deadzone(-0.05, 0.05)).toBe(0);
    expect(deadzone(0.049, 0.05)).toBe(0);
    expect(deadzone(1, 0.05)).toBeCloseTo(1, 12);
    expect(deadzone(-1, 0.05)).toBeCloseTo(-1, 12);
    expect(deadzone(0.525, 0.05)).toBeCloseTo(0.5, 12);
  });

  it('deadzone preserves sign for negative input', () => {
    expect(deadzone(-0.5, 0.05)).toBeLessThan(0);
    expect(deadzone(-0.5, 0.05)).toBeCloseTo(-deadzone(0.5, 0.05), 12);
  });

  it('signPow preserves sign and fixes the endpoints', () => {
    expect(signPow(0, 2)).toBe(0);
    expect(signPow(1, 2)).toBe(1);
    expect(signPow(-1, 2)).toBe(-1);
    expect(signPow(-0.5, 2)).toBeCloseTo(-0.25, 12);
    expect(signPow(0.5, 3)).toBeCloseTo(0.125, 12);
    expect(signPow(-0.5, 1)).toBeCloseTo(-0.5, 12);
    expect(signPow(-0.5, 2)).toBeLessThan(0);
  });
});

describe('lifecycle', () => {
  it('dispose removes every listener it registered', () => {
    const h = harness();
    expect(h.keys.count('keydown')).toBe(1);
    expect(h.mouse.count('mousemove')).toBe(1);
    h.device.dispose();
    expect(h.keys.count('keydown')).toBe(0);
    expect(h.keys.count('keyup')).toBe(0);
    expect(h.mouse.count('mousemove')).toBe(0);
    expect(h.mouse.count('pointerlockchange')).toBe(0);
  });
});
