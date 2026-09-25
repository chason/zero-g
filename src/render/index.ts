import * as THREE from 'three';
import type { World } from '../sim/world';
import { createPlumes } from './plumes';
import { createPostProcess } from './post';

/**
 * Reads world state, never writes it. Three.js transforms are an OUTPUT of the
 * simulation, copied once per frame. If ship position ever lives in mesh.position,
 * the physics is coupled to the frame rate and is no longer testable.
 */
export type ViewMode = 'cockpit' | 'chase';

export interface Renderer {
  draw(world: World, alpha: number): void;
  resize(): void;
  /** Flip between the pilot's seat and the lagged chase camera. Returns the mode now active. */
  toggleView(): ViewMode;
  canvas: HTMLCanvasElement;
  /** read-only: the HUD projects world points through this */
  camera: THREE.PerspectiveCamera;
}

/** Dust is the only real speed cue in empty space. It wraps around the camera forever. */
const DUST_COUNT = 1200;
const DUST_BOX = 240;

export function createRenderer(): Renderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1e7);

  // Placeholder hull. Untextured geometry reads perfectly well in space.
  const ship = new THREE.Mesh(
    new THREE.ConeGeometry(1.2, 5, 12),
    new THREE.MeshBasicMaterial({ color: 0x9fd9cc, wireframe: true }),
  );
  ship.geometry.rotateX(-Math.PI / 2);
  scene.add(ship);
  const plumes = createPlumes(scene, ship);
  const post = createPostProcess(renderer);

  // Local parallax field: the single most effective speed cue in the whole renderer.
  const dustPos = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < dustPos.length; i++) dustPos[i] = (Math.random() - 0.5) * DUST_BOX;
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.12, color: 0x5f7080 }));
  scene.add(dust);

  // Stars at effectively infinite distance: rotation cues only, correctly unaffected by translation.
  const starPos = new Float32Array(3000 * 3);
  for (let i = 0; i < 3000; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(5e6);
    starPos[i * 3] = v.x; starPos[i * 3 + 1] = v.y; starPos[i * 3 + 2] = v.z;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 9000, color: 0xdfe8ff })));

  // Cockpit is the default: the game is hand-flying a rigid body from inside it.
  let view: ViewMode = 'cockpit';
  ship.visible = false;

  const camOffset = new THREE.Vector3(0, 2.2, 11);
  const smoothed = new THREE.Quaternion();
  // Scratch space for the per-frame pose. draw() runs at display rate and allocates nothing.
  const offset = new THREE.Vector3();
  const seat = new THREE.Vector3();

  function draw(world: World, alpha: number) {
    const s = world.ships[0];
    if (s) {
      // Physics ran at a fixed STEP; this frame falls `alpha` of the way from the pose at
      // the start of the last step to the pose at its end. Interpolating between the two
      // is what stops a 144 or 240 Hz display from showing the same pose on consecutive
      // frames. Clamped because a halted sim keeps accumulating time without stepping.
      const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      const { previous, position, orientation } = s.body;
      ship.position.lerpVectors(
        previous.position as unknown as THREE.Vector3,
        position as unknown as THREE.Vector3,
        t,
      );
      ship.quaternion.slerpQuaternions(
        previous.orientation as unknown as THREE.Quaternion,
        orientation as unknown as THREE.Quaternion,
        t,
      );

      if (view === 'cockpit') {
        // Bolted to the hull: the seat offset rotated into the world by the ship's own
        // orientation, and that orientation verbatim. No lag and no smoothing of any kind;
        // the pilot's head is part of the rigid body and must feel every rate the sim
        // produces. The cone's nose was rotated onto -Z at build time, which is the axis a
        // Three.js camera looks down, so no extra rotation is needed. The hull is hidden
        // because from the seat it would fill the view.
        ship.visible = false;
        const so = s.spec.seatOffset;
        camera.position
          .copy(ship.position)
          .add(seat.set(so[0], so[1], so[2]).applyQuaternion(ship.quaternion));
        camera.quaternion.copy(ship.quaternion);
      } else {
        ship.visible = true;
        // Camera lag: trail the ship's rotation slightly instead of following rigidly.
        smoothed.slerp(ship.quaternion, 0.12);
        camera.position.copy(ship.position).add(offset.copy(camOffset).applyQuaternion(smoothed));
        camera.quaternion.copy(smoothed);
      }

      // Wrap the dust field around the camera so parallax exists everywhere.
      dust.position.set(
        Math.floor(camera.position.x / DUST_BOX) * DUST_BOX,
        Math.floor(camera.position.y / DUST_BOX) * DUST_BOX,
        Math.floor(camera.position.z / DUST_BOX) * DUST_BOX,
      );
    }
    if (s) plumes.update(s);
    post.render(scene, camera, world);
  }

  function toggleView(): ViewMode {
    view = view === 'cockpit' ? 'chase' : 'cockpit';
    // Start the chase camera square behind the hull rather than swinging in from wherever
    // the lag left it the last time chase was active.
    if (view === 'chase') smoothed.copy(ship.quaternion);
    return view;
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.resize();
  }

  addEventListener('resize', resize);
  return { draw, resize, toggleView, canvas: renderer.domElement, camera };
}
