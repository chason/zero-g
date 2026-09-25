import type * as THREE from 'three';
import type { World } from '../sim/world';

/**
 * Full-screen post pass. Issue #24 (blackout: vignette, desaturation, tunnel to black,
 * driven by the pilot's g reserve). Not implemented yet — this file is owned by that issue.
 *
 * The stub is the identity pass so the renderer works without it.
 */
export interface PostProcess {
  render(scene: THREE.Scene, camera: THREE.Camera, world: World): void;
  resize(): void;
}

export function createPostProcess(renderer: THREE.WebGLRenderer): PostProcess {
  return {
    render(scene, camera, _world) { renderer.render(scene, camera); },
    resize() {},
  };
}
