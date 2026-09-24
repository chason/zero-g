import * as THREE from 'three';
import type { World } from '../sim/world';

/**
 * Reads world state, never writes it. Three.js transforms are an OUTPUT of the
 * simulation, copied once per frame. If ship position ever lives in mesh.position,
 * the physics is coupled to the frame rate and is no longer testable.
 */
export interface Renderer {
  draw(world: World, alpha: number): void;
  resize(): void;
  canvas: HTMLCanvasElement;
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

  const camOffset = new THREE.Vector3(0, 2.2, 11);
  const smoothed = new THREE.Quaternion();

  function draw(world: World, alpha: number) {
    const s = world.ships[0];
    if (s) {
      // TODO: interpolate between the previous and current physics state using `alpha`
      //       (lerp position, slerp orientation) or 240Hz displays will judder.
      void alpha;
      ship.position.copy(s.body.position as unknown as THREE.Vector3);
      ship.quaternion.copy(s.body.orientation as unknown as THREE.Quaternion);

      // Camera lag: trail the ship's rotation slightly instead of following rigidly.
      smoothed.slerp(ship.quaternion, 0.12);
      camera.position.copy(ship.position).add(camOffset.clone().applyQuaternion(smoothed));
      camera.quaternion.copy(smoothed);

      // Wrap the dust field around the camera so parallax exists everywhere.
      dust.position.set(
        Math.floor(camera.position.x / DUST_BOX) * DUST_BOX,
        Math.floor(camera.position.y / DUST_BOX) * DUST_BOX,
        Math.floor(camera.position.z / DUST_BOX) * DUST_BOX,
      );
    }
    // TODO: thruster plumes, driven by ship.throttles
    renderer.render(scene, camera);
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  addEventListener('resize', resize);
  return { draw, resize, canvas: renderer.domElement };
}
