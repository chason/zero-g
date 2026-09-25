import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { edgeSegmentCount, createVectorLines, createVectorStrokes, torusStrokes, disposeVectorLines, STROKE_PX, CREASE_DEG } from '../src/render/vector';
import { BLOOM_THRESHOLD, PHOSPHOR_DECAY, BLOOM_STRENGTH } from '../src/render/post';

describe('vector strokes', () => {
  it('draws a cone as twelve spokes and a rim, not a fan of triangles', () => {
    const cone = new THREE.ConeGeometry(1.2, 5, 12);
    // 12 radial edges to the apex + 12 rim edges; the cap's 12 spokes are coplanar and dropped
    expect(edgeSegmentCount(cone)).toBe(24);
    // a raw wireframe would be far denser
    const wire = new THREE.WireframeGeometry(cone);
    expect(wire.getAttribute('position').count / 2).toBeGreaterThan(24);
  });

  it('draws a torus as hoops and longitudes, every one present', () => {
    const seg = torusStrokes(3, 0.18, 24, 6, 8, 48);
    expect(seg.length / 6).toBe(24 * 8 + 6 * 48);
    // every point lies on the torus surface: distance from the ring's centre circle == tube
    for (let i = 0; i < seg.length; i += 3) {
      const x = seg[i]!, y = seg[i + 1]!, z = seg[i + 2]!;
      const d = Math.hypot(Math.hypot(x, y) - 3, z);
      expect(d).toBeCloseTo(0.18, 5); // Float32Array storage
    }
    const lines = createVectorStrokes(seg, 0xffffff);
    expect(lines.geometry.getAttribute('instanceStart').count).toBe(seg.length / 6);
    disposeVectorLines(lines);
  });

  it('builds fat-line objects with additive phosphor materials', () => {
    const lines = createVectorLines(new THREE.ConeGeometry(1, 2, 8), 0x9fd9cc);
    const m = lines.material as any;
    expect(m.linewidth).toBe(STROKE_PX);
    expect(m.blending).toBe(THREE.NormalBlending); // additive blew out the distant ring into a blob
    expect(m.depthWrite).toBe(false);
    expect(lines.geometry.getAttribute('instanceStart').count).toBe(edgeSegmentCount(new THREE.ConeGeometry(1, 2, 8)));
    disposeVectorLines(lines);
  });

  it('keeps the look constants in a sane range', () => {
    expect(CREASE_DEG).toBeGreaterThan(0);
    expect(STROKE_PX).toBeGreaterThan(1);
    expect(BLOOM_THRESHOLD).toBeLessThan(0.5); // the scene is mostly black; dim strokes must still bloom
    expect(BLOOM_STRENGTH).toBeGreaterThan(0);
    expect(PHOSPHOR_DECAY).toBeGreaterThanOrEqual(0);
    expect(PHOSPHOR_DECAY).toBeLessThan(0.9); // above this it smears rather than trails
  });
});
