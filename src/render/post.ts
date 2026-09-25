import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { World } from '../sim/world';

/**
 * Full-screen post pipeline: the vector-monitor look (#36) and the blackout (#24).
 *
 * The pilot's g reserve (Pilot.reserve: 1 = fresh, 0 = out) is made felt rather than
 * read. As it drains the view desaturates, then a vignette closes to a tunnel, and at
 * zero the last of the light goes. One float drives all of it: the FELT reserve, a
 * smoothed copy of the sim's value that chases it quickly on the way down and lags it
 * by a few hundred milliseconds on the way back up, so recovery is a fade and not a
 * light switch.
 *
 * The look comes first in the chain: a phosphor-persistence pass keeps a fading trace
 * of the last frame, and an optional bloom (off by default; the strokes carry their own
 * halo). The blackout is the last stage because it also performs the sRGB encode for
 * the screen. At a full reserve it is an identity.
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

// ---------------------------------------------------------------------------------------
// Vector-monitor look (#36). All exported so the feel can be tuned without reading code.
// ---------------------------------------------------------------------------------------

/**
 * Bloom: a screen-space blur. Off by default (0) — the glow lives in the strokes
 * themselves (see vector.ts), which is bounded where lines pile up; a blur is not, and
 * turned a distant ring into a sun. Left available as a knob for anyone who wants a
 * little extra on top.
 */
export const BLOOM_STRENGTH = 0;
/** Bloom: halo spread, 0..1. */
export const BLOOM_RADIUS = 0.3;
/** Bloom: luminance above which a pixel blooms. Low, because the scene is mostly black. */
export const BLOOM_THRESHOLD = 0.15;
/**
 * Phosphor persistence: fraction of last frame's light kept each frame. 0 = none.
 * 0.55 decays to under 5% in five frames — a faint trail on fast rotation, no smear.
 */
export const PHOSPHOR_DECAY = 0.55;

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
  // Felt reserve: the single float the blackout is driven by. Starts full.
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
  const blackout = new ShaderPass(
    new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false }),
  );

  // Pipeline: scene -> phosphor persistence -> bloom halo -> blackout (which also does
  // the sRGB encode, so it must stay last). Half float keeps the dark scene free of
  // banding and lets bright strokes exceed 1.0 for the bloom; 4x MSAA matches the
  // antialiased canvas so nothing pops.
  const scratchSize = new THREE.Vector2();
  const size = renderer.getSize(scratchSize);
  const ratio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: THREE.HalfFloatType,
    samples: 4,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(size.x, size.y);

  // RenderPass needs a scene and camera at construction; the real ones are swapped in
  // on every render() so the pass never holds a stale reference.
  const renderPass = new RenderPass(new THREE.Scene(), new THREE.Camera());
  const afterimage = new AfterimagePass(PHOSPHOR_DECAY);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * ratio, size.y * ratio),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  );
  composer.addPass(renderPass);
  if (PHOSPHOR_DECAY > 0) composer.addPass(afterimage);
  if (BLOOM_STRENGTH > 0) composer.addPass(bloom);
  composer.addPass(blackout);

  function fit(): void {
    const s = renderer.getSize(scratchSize);
    // A canvas that has not been laid out yet (hidden pane, first frame) reports 0x0;
    // sizing the chain to that leaves every attachment empty and GL warns on each draw.
    if (s.x < 1 || s.y < 1) return;
    const r = renderer.getPixelRatio();
    composer.setPixelRatio(r);
    composer.setSize(s.x, s.y);
    uniforms.uAspect.value = s.x / s.y;
  }
  fit();

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

      blackoutCurve(felt, curve);
      uniforms.uDesaturate.value = curve.desaturate;
      uniforms.uVignette.value = curve.vignette;
      uniforms.uDarken.value = curve.darken;

      renderPass.scene = scene;
      renderPass.camera = camera;
      composer.render();
    },
    resize() {
      fit();
    },
  };
}
