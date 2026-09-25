import * as THREE from 'three';
import type { World } from '../sim/world';

/**
 * Full-screen post pass: the blackout (issue #24).
 *
 * The pilot's g reserve (Pilot.reserve: 1 = fresh, 0 = out) is made felt rather than
 * read. As it drains the view desaturates, then a vignette closes to a tunnel, and at
 * zero the last of the light goes. One float drives all of it: the FELT reserve, a
 * smoothed copy of the sim's value that chases it quickly on the way down and lags it
 * by a few hundred milliseconds on the way back up, so recovery is a fade and not a
 * light switch.
 *
 * At a full reserve, or with no pilot at all, this is exactly renderer.render(): no
 * render target is bound, no quad is drawn, nothing is allocated. The common path costs
 * nothing.
 *
 * The pure parts — the reserve → effect-strength curve and the lag — are exported below
 * and specified by test/post.test.ts. The GL parts run only in a browser and are checked
 * only by `vite build`.
 *
 * Reads the world; never writes it.
 */
export interface PostProcess {
  render(scene: THREE.Scene, camera: THREE.Camera, world: World): void;
  resize(): void;
}

// ---------------------------------------------------------------------------------------
// Pure parts (tested in node)
// ---------------------------------------------------------------------------------------

/** Strength of each stage of the effect, all 0..1, 0 meaning "not applied". */
export interface BlackoutCurve {
  /** colour drains to luma */
  desaturate: number;
  /** the periphery closes to a tunnel */
  vignette: number;
  /** what is left inside the tunnel goes to black */
  darken: number;
}

/**
 * Where along the DRAIN (0 = full reserve, 1 = empty) each stage begins and completes.
 * They overlap, but in strict order: colour goes first, the tunnel closes next and is
 * fully shut at 85 % drained, and only then does the remaining spot go to black, which
 * is complete exactly at zero reserve. Each stage is a smoothstep across its window, so
 * onset is gentle and nothing flickers at 0.99 reserve.
 */
export const DESATURATE_WINDOW: readonly [number, number] = [0, 0.55];
export const VIGNETTE_WINDOW: readonly [number, number] = [0.25, 0.85];
export const DARKEN_WINDOW: readonly [number, number] = [0.6, 1];

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = x <= edge0 ? 0 : x >= edge1 ? 1 : (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

/**
 * Map a (felt) reserve onto the three effect strengths. Reserve 1 gives all zeros, 0
 * gives all ones, every component is monotonic in between. Out-of-range and NaN input
 * clamp — a broken pilot value must never paint the screen black.
 *
 * Pass `out` from the hot path so no object is allocated per frame.
 */
export function blackoutCurve(
  reserve: number,
  out: BlackoutCurve = { desaturate: 0, vignette: 0, darken: 0 },
): BlackoutCurve {
  let drain = 1 - reserve;
  // NaN fails the first comparison and lands on "no effect".
  if (!(drain > 0)) drain = 0;
  else if (drain > 1) drain = 1;
  out.desaturate = smoothstep(DESATURATE_WINDOW[0], DESATURATE_WINDOW[1], drain);
  out.vignette = smoothstep(VIGNETTE_WINDOW[0], VIGNETTE_WINDOW[1], drain);
  out.darken = smoothstep(DARKEN_WINDOW[0], DARKEN_WINDOW[1], drain);
  return out;
}

/**
 * Time constants, in seconds, of the felt reserve chasing the real one. Onset is quick:
 * the sim's reserve already models the physiological delay, and doubling it up would
 * feel mushy. Recovery is the lag the design asks for — a few hundred milliseconds —
 * so vision comes back as a fade rather than a switch.
 */
export const ONSET_TAU = 0.08;
export const RECOVERY_TAU = 0.35;
/** Within this of the target the felt value snaps onto it, so a full reserve is reached EXACTLY and the pass switches itself off. */
export const SETTLE = 1e-3;

/**
 * One step of the lag: move `current` toward `target` over `dt` seconds with first-order
 * exponential smoothing. The exponential form is exact, so ten 10 ms steps land where one
 * 100 ms step does — frame-rate independent — and it can never overshoot for any dt ≥ 0.
 * Non-positive or NaN dt returns `current` unchanged.
 */
export function chase(current: number, target: number, dt: number): number {
  if (!(dt > 0)) return current;
  // Falling reserve is onset; rising reserve is recovery.
  const tau = target < current ? ONSET_TAU : RECOVERY_TAU;
  const next = current + (target - current) * (1 - Math.exp(-dt / tau));
  return Math.abs(target - next) < SETTLE ? target : next;
}

/** Pilot.reserve is documented 0..1; clamp anyway, and read NaN as a full reserve. */
function safeReserve(v: number): number {
  return v >= 1 ? 1 : v > 0 ? v : v <= 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------
// Audio hook
// ---------------------------------------------------------------------------------------

let amount = 0;

/**
 * AUDIO HOOK. The design low-passes the mix as the pilot greys out. There is no audio
 * module yet, so this getter is the seam: 0 = clear, 1 = blacked out, already smoothed
 * with the same lag as the picture. Sample it once per frame and map it onto the filter
 * cutoff. It reflects the most recent post.render() call.
 */
export function blackoutAmount(): number {
  return amount;
}

// ---------------------------------------------------------------------------------------
// GL parts (browser only)
// ---------------------------------------------------------------------------------------

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // One clip-space triangle that covers the screen; no camera matrices involved.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uDesaturate;
uniform float uVignette;
uniform float uDarken;
uniform float uAspect;
varying vec2 vUv;

void main() {
  vec4 src = texture2D(tDiffuse, vUv);

  // Grey-out: colour goes first. Rec. 709 luma.
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(src.rgb, vec3(luma), uDesaturate);

  // Tunnel: radial distance, 0 at the centre and 1 at the corners, aspect-corrected so
  // the opening stays round on a wide screen. The lit radius starts beyond the corners
  // (so a zero vignette is invisible) and closes to a small soft spot.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p) / (0.5 * length(vec2(uAspect, 1.0)));
  float radius = mix(1.5, 0.1, uVignette);
  float soft = mix(0.5, 0.1, uVignette);
  rgb *= 1.0 - smoothstep(radius - soft, radius, r);

  // Blackout: the last of the light goes.
  rgb *= 1.0 - uDarken;

  gl_FragColor = vec4(rgb, src.a);
  // The scene was rendered into the target in the working (linear) colour space; encode
  // for the screen here exactly as the scene's own materials would have done.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createPostProcess(renderer: THREE.WebGLRenderer): PostProcess {
  // Felt reserve: the single float the whole effect is driven by. Starts full.
  let felt = 1;
  let lastTime = NaN;
  const curve: BlackoutCurve = { desaturate: 0, vignette: 0, darken: 0 };

  const uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    uDesaturate: { value: 0 },
    uVignette: { value: 0 },
    uDarken: { value: 0 },
    uAspect: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  // A single oversized triangle instead of a two-triangle quad: no diagonal seam, and
  // the vertex shader places it in clip space directly, so the camera below is only
  // there because renderer.render() needs one.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Created the first time the effect is needed, never on the common path.
  let target: THREE.WebGLRenderTarget | null = null;
  const scratchSize = new THREE.Vector2();

  /** Match the render target to the drawing buffer: CSS size times the renderer's pixel ratio. */
  function fit(): THREE.WebGLRenderTarget {
    const size = renderer.getSize(scratchSize);
    const ratio = renderer.getPixelRatio();
    const width = Math.max(1, Math.floor(size.x * ratio));
    const height = Math.max(1, Math.floor(size.y * ratio));
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {
        // Half float keeps the linear scene free of banding in the darks, which is where
        // this effect lives; 4x MSAA matches the antialiased canvas so nothing pops when
        // the pass engages.
        type: THREE.HalfFloatType,
        samples: 4,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      uniforms.tDiffuse.value = target.texture;
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
    }
    uniforms.uAspect.value = width / height;
    return target;
  }

  return {
    render(scene, camera, world) {
      const pilot = world.ships[0]?.pilot;
      const wanted = pilot ? safeReserve(pilot.reserve) : 1;
      // The lag runs on simulated time, the clock the reserve itself moves on: a paused
      // sim holds the picture still, and the fade is identical at 30 and 240 Hz. The
      // first frame has no previous time and simply adopts the value.
      const dt = world.time - lastTime;
      lastTime = world.time;
      felt = Number.isNaN(dt) ? wanted : chase(felt, wanted, dt);
      amount = 1 - felt;

      if (felt >= 1) {
        // Common path: identical to having no post pass at all.
        renderer.render(scene, camera);
        return;
      }

      blackoutCurve(felt, curve);
      uniforms.uDesaturate.value = curve.desaturate;
      uniforms.uVignette.value = curve.vignette;
      uniforms.uDarken.value = curve.darken;

      renderer.setRenderTarget(fit());
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(quad, quadCamera);
    },
    resize() {
      // Nothing to resize until the effect has been needed once; fit() then sizes it.
      if (target) fit();
    },
  };
}
