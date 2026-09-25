import type * as THREE from 'three';
import type { Ship } from '../sim/ship';

/**
 * Visible exhaust from every open thruster, scaled by throttle.
 * Issue #16. Not implemented yet — this file is owned by that issue.
 *
 * Build one plume per entry in ship.prepared at its position, pointing opposite its
 * direction; intensity tracks ship.throttles[i]; nothing renders at zero.
 */
export interface Plumes {
  update(ship: Ship): void;
}

export function createPlumes(_scene: THREE.Scene, _hull: THREE.Object3D): Plumes {
  return { update(_ship) {} };
}
