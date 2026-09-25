import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { projectDirection, projectPoint, type HudContext, type Projected } from '../src/hud/instrument';
import {
  screenDirection,
  clampToEdge,
  isOnScreen,
  relativeVelocity,
  MIN_MARKER_SPEED,
} from '../src/hud/instruments/markers';
import type { Target } from '../src/sim/world';

const W = 800;
const H = 600;

/** A camera like the renderer's: same vertical FOV and, crucially, a far plane beyond the 1e6 m projectDirection uses. */
function makeCtx(width = W, height = H): HudContext {
  const camera = new PerspectiveCamera(70, width / height, 0.1, 1e7);
  camera.updateMatrixWorld();
  return { world: undefined as unknown as HudContext['world'], ship: undefined as unknown as HudContext['ship'], camera, width, height };
}

function projected(x: number, y: number, behind = false): Projected {
  return { x, y, behind };
}

describe('hud overlay: clampToEdge', () => {
  const out = { x: 0, y: 0 };

  it('right edge', () => {
    clampToEdge(W, H, 1, 0, 0, out);
    expect(out.x).toBeCloseTo(W);
    expect(out.y).toBeCloseTo(H / 2);
  });

  it('left edge', () => {
    clampToEdge(W, H, -5, 0, 0, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(H / 2);
  });

  it('top edge', () => {
    clampToEdge(W, H, 0, -1, 0, out);
    expect(out.x).toBeCloseTo(W / 2);
    expect(out.y).toBeCloseTo(0);
  });

  it('bottom edge', () => {
    clampToEdge(W, H, 0, 2, 0, out);
    expect(out.x).toBeCloseTo(W / 2);
    expect(out.y).toBeCloseTo(H);
  });

  it('diagonal lands on the edge crossed first', () => {
    // 45 deg down-right on a landscape screen hits the bottom before the right side
    clampToEdge(W, H, 1, 1, 0, out);
    expect(out.x).toBeCloseTo(700);
    expect(out.y).toBeCloseTo(H);
    // a shallower ray reaches the right side first
    clampToEdge(W, H, 3, 1, 0, out);
    expect(out.x).toBeCloseTo(W);
    expect(out.y).toBeCloseTo(300 + 400 / 3);
  });

  it('honours the margin inset', () => {
    clampToEdge(W, H, 1, 0, 18, out);
    expect(out.x).toBeCloseTo(W - 18);
    clampToEdge(W, H, 0, -1, 18, out);
    expect(out.y).toBeCloseTo(18);
  });

  it('parks a zero or non-finite direction at bottom centre instead of NaN', () => {
    clampToEdge(W, H, 0, 0, 18, out);
    expect(out.x).toBeCloseTo(W / 2);
    expect(out.y).toBeCloseTo(H - 18);
    clampToEdge(W, H, NaN, 1, 18, out);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
  });
});

describe('hud overlay: behind-camera flipping', () => {
  const out = { x: 0, y: 0 };

  it('a point in front keeps its offset from centre', () => {
    screenDirection(projected(700, 100), W, H, out);
    expect(out).toEqual({ x: 300, y: -200 });
  });

  it('a point behind is reflected through the centre', () => {
    screenDirection(projected(700, 100, true), W, H, out);
    expect(out).toEqual({ x: -300, y: 200 });
  });

  it('isOnScreen rejects behind points even when x/y look valid', () => {
    expect(isOnScreen(projected(W / 2, H / 2), W, H)).toBe(true);
    expect(isOnScreen(projected(W / 2, H / 2, true), W, H)).toBe(false);
    expect(isOnScreen(projected(-1, H / 2), W, H)).toBe(false);
    expect(isOnScreen(projected(10, 10), W, H, 18)).toBe(false);
    expect(isOnScreen(projected(NaN, 10), W, H)).toBe(false);
  });
});

describe('hud overlay: projectDirection through a real camera', () => {
  it('straight ahead lands on the screen centre and is not behind', () => {
    const ctx = makeCtx();
    const p = projectDirection(new Vector3(0, 0, -1), ctx, projected(0, 0));
    expect(p.behind).toBe(false);
    expect(p.x).toBeCloseTo(W / 2, 3);
    expect(p.y).toBeCloseTo(H / 2, 3);
  });

  it('straight behind is flagged behind', () => {
    const ctx = makeCtx();
    const p = projectDirection(new Vector3(0, 0, 1), ctx, projected(0, 0));
    expect(p.behind).toBe(true);
  });

  it('follows the camera orientation, not the world axes', () => {
    const ctx = makeCtx();
    ctx.camera.rotation.y = Math.PI; // now looking down +z
    ctx.camera.updateMatrixWorld();
    expect(projectDirection(new Vector3(0, 0, -1), ctx, projected(0, 0)).behind).toBe(true);
    expect(projectDirection(new Vector3(0, 0, 1), ctx, projected(0, 0)).behind).toBe(false);
  });

  it('right and up map to +x and -y on screen', () => {
    const ctx = makeCtx();
    const right = projectDirection(new Vector3(1, 0, -1), ctx, projected(0, 0));
    expect(right.behind).toBe(false);
    expect(right.x).toBeGreaterThan(W / 2);
    expect(right.y).toBeCloseTo(H / 2, 3);
    const up = projectDirection(new Vector3(0, 1, -1), ctx, projected(0, 0));
    expect(up.y).toBeLessThan(H / 2);
  });

  it('a behind-right point, flipped and clamped, sits on the right edge', () => {
    const ctx = makeCtx();
    const p = projectPoint(new Vector3(10, 0, 10), ctx, projected(0, 0));
    expect(p.behind).toBe(true);
    // raw projection is mirrored to the LEFT: drawing it there would point the wrong way
    expect(p.x).toBeLessThan(W / 2);
    const d = screenDirection(p, W, H, { x: 0, y: 0 });
    expect(d.x).toBeGreaterThan(0);
    const e = clampToEdge(W, H, d.x, d.y, 18, { x: 0, y: 0 });
    expect(e.x).toBeCloseTo(W - 18);
  });
});

describe('hud overlay: relative velocity for the markers', () => {
  const out = new Vector3();

  it('subtracts the target velocity', () => {
    const target: Target = { name: 't', position: new Vector3(), velocity: new Vector3(1, 0, 0), radius: 1 };
    relativeVelocity(new Vector3(1, 0, 0), target, out);
    expect(out.length()).toBe(0);
  });

  it('falls back to world velocity with no target', () => {
    const ship = new Vector3(0, 0, -3);
    relativeVelocity(ship, undefined, out);
    expect(out.equals(ship)).toBe(true);
    expect(out).not.toBe(ship); // copied, never aliased
  });

  it('threshold is the documented 0.05 m/s', () => {
    expect(MIN_MARKER_SPEED).toBe(0.05);
  });
});
