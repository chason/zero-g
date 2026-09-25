import * as THREE from 'three';
import type { World, Target, Structure, Obstacle } from '../sim/world';
import { createPlumes } from './plumes';
import { createPostProcess } from './post';
import { createVectorLines, createVectorStrokes, hullStrokes, portStrokes, asteroidStrokes, projectedRadiusPx, farFade, setVectorResolution, type VectorStrokes } from './vector';

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

let sprite: THREE.Texture | null = null;
/** A soft radial dot, so points glow on their own without a screen-space bloom. */
function softSprite(): THREE.Texture {
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  sprite = new THREE.CanvasTexture(c);
  return sprite;
}

/** Ring tube radius, metres. Thin enough to read as a hoop, thick enough to survive 400 m. */
/** The assigned port: the one thing on screen that is warm. */
const RING_COLOR = 0xffb347;
/** Every other port: present, but not the eye's target. */
const PORT_COLOR = 0x7f9fae;
/** Structure hulls: dimmer and cooler still, and held at a fraction of full stroke opacity. */
const HULL_COLOR = 0x4f7584;
const HULL_FADE = 0.55;
/** Rocks: neutral and held back, so they read as matter rather than machinery, and never outshine the port. */
const ROCK_COLOR = 0x8c877c;
const ROCK_FADE = 0.7;

export function createRenderer(): Renderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  setVectorResolution(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1e7);

  // Placeholder hull, drawn as vector strokes: twelve spokes and a rim, glowing.
  // `ship` is the object everything positions; the strokes hang off it.
  const hullGeometry = new THREE.ConeGeometry(1.2, 5, 12);
  hullGeometry.rotateX(-Math.PI / 2);
  const ship = new THREE.Group();
  ship.add(createVectorLines(hullGeometry, 0x9fd9cc).group);
  scene.add(ship);
  const plumes = createPlumes(scene, ship);
  const post = createPostProcess(renderer);

  // Targets (#25). One torus per entry in world.targets, keyed by the Target object so a
  // list that is replaced wholesale still maps to the same meshes. Geometry is allocated
  // only when a target appears and disposed only when it leaves; the per-frame path just
  // copies transforms. An unlit material is the right choice for an emissive hoop in
  // space: there are no lights in this scene to react to.
  // Ports (#25, #42): one stroke set per target, keyed by the Target object so a
  // replaced list rebuilds only what changed. The assigned port is drawn warm.
  const targetMeshes = new Map<Target, { strokes: VectorStrokes; assigned: boolean }>();
  const structureMeshes = new Map<Structure, VectorStrokes>();
  const obstacleMeshes = new Map<Obstacle, VectorStrokes>();

  function syncTargets(world: World): void {
    const { targets, structures, assigned } = world;
    for (const [target, mesh] of targetMeshes) {
      const idx = targets.indexOf(target);
      if (idx >= 0 && mesh.assigned === (idx === assigned)) continue;
      scene.remove(mesh.strokes.group);
      mesh.strokes.dispose();
      targetMeshes.delete(target);
    }
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      if (targetMeshes.has(target)) continue;
      const isAssigned = i === assigned;
      const strokes = createVectorStrokes(portStrokes(target.radius, target.tube, target.collar), isAssigned ? RING_COLOR : PORT_COLOR);
      scene.add(strokes.group);
      targetMeshes.set(target, { strokes, assigned: isAssigned });
    }
    for (const [structure, mesh] of structureMeshes) {
      if (structures.includes(structure)) continue;
      scene.remove(mesh.group);
      mesh.dispose();
      structureMeshes.delete(structure);
    }
    for (const structure of structures) {
      if (structureMeshes.has(structure)) continue;
      const strokes = createVectorStrokes(hullStrokes(structure.hull), HULL_COLOR);
      strokes.setFade(HULL_FADE);
      scene.add(strokes.group);
      structureMeshes.set(structure, strokes);
    }
    const { obstacles } = world;
    for (const [obstacle, mesh] of obstacleMeshes) {
      if (obstacles.includes(obstacle)) continue;
      scene.remove(mesh.group);
      mesh.dispose();
      obstacleMeshes.delete(obstacle);
    }
    for (const obstacle of obstacles) {
      if (obstacleMeshes.has(obstacle)) continue;
      const strokes = createVectorStrokes(asteroidStrokes(obstacle.radius, obstacle.seed), ROCK_COLOR);
      strokes.group.position.copy(obstacle.position as unknown as THREE.Vector3);
      strokes.group.quaternion.copy(obstacle.orientation as unknown as THREE.Quaternion);
      scene.add(strokes.group);
      obstacleMeshes.set(obstacle, strokes);
    }
  }

  // Local parallax field: the single most effective speed cue in the whole renderer.
  const dustPos = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < dustPos.length; i++) dustPos[i] = (Math.random() - 0.5) * DUST_BOX;
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 0.32, color: 0x8fa3b0, map: softSprite(), transparent: true, depthWrite: false, alphaTest: 0.02,
  }));
  scene.add(dust);

  // Stars at effectively infinite distance: rotation cues only, correctly unaffected by translation.
  const starPos = new Float32Array(3000 * 3);
  for (let i = 0; i < 3000; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(5e6);
    starPos[i * 3] = v.x; starPos[i * 3 + 1] = v.y; starPos[i * 3 + 2] = v.z;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 14000, color: 0xdfe8ff, map: softSprite(), transparent: true, depthWrite: false, alphaTest: 0.02,
  })));

  // Cockpit is the default: the game is hand-flying a rigid body from inside it.
  let view: ViewMode = 'cockpit';
  ship.visible = false;

  const unitZ = new THREE.Vector3(0, 0, 1);
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

    // Targets and structures are sim state: pose copied out every frame, never owned
    // here. A port's local +Z is its open side; a structure's local +Z is its length.
    syncTargets(world);
    for (let i = 0; i < world.targets.length; i++) {
      const target = world.targets[i]!;
      const mesh = targetMeshes.get(target)!;
      mesh.strokes.group.position.copy(target.position as unknown as THREE.Vector3);
      mesh.strokes.group.quaternion.setFromUnitVectors(unitZ, target.axis as unknown as THREE.Vector3);
      mesh.strokes.setFade(farFade(projectedRadiusPx(target.radius, camera.position.distanceTo(mesh.strokes.group.position), camera.fov, innerHeight)));
    }
    for (const structure of world.structures) {
      const mesh = structureMeshes.get(structure)!;
      mesh.group.position.copy(structure.position as unknown as THREE.Vector3);
      mesh.group.quaternion.copy(structure.orientation as unknown as THREE.Quaternion);
    }
    for (const obstacle of world.obstacles) {
      const mesh = obstacleMeshes.get(obstacle)!;
      mesh.setFade(ROCK_FADE * farFade(projectedRadiusPx(obstacle.radius, camera.position.distanceTo(mesh.group.position), camera.fov, innerHeight)));
    }

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
    setVectorResolution(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
    post.resize();
  }

  addEventListener('resize', resize);
  return { draw, resize, toggleView, canvas: renderer.domElement, camera };
}
