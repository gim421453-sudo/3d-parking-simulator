import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipToRect, inFront, projectSegment } from '../src/pdc/clip';

const cam = (pos: [number, number, number], look: [number, number, number], fov = 100) => {
  const c = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 300);
  c.position.set(...pos);
  c.lookAt(...look);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
};
const W = 480;
const H = 270;
const inside = (p: { x: number; y: number }) => p.x >= -0.01 && p.x <= W + 0.01 && p.y >= -0.01 && p.y <= H + 0.01;

describe('투영 클리핑 (근평면/화면 경계)', () => {
  const c = cam([0, 1, 0], [0, 0, 5]); // +z 를 바라봄
  it('카메라 뒤쪽 선분은 그리지 않는다', () => {
    expect(projectSegment({ x: 0, y: 0, z: -2 }, { x: 0, y: 0, z: -9 }, c, W, H)).toBeNull();
  });
  it('근평면을 가로지르는 선분은 앞쪽 부분만 남고 모든 점이 화면 안', () => {
    const seg = projectSegment({ x: 0.8, y: 0, z: -3 }, { x: 0.8, y: 0, z: 12 }, c, W, H)!;
    expect(seg).not.toBeNull();
    expect(inside(seg[0]) && inside(seg[1])).toBe(true);
  });
  it('화면 밖(옆)으로 완전히 벗어난 선분은 null', () => {
    expect(projectSegment({ x: 60, y: 0, z: 3 }, { x: 60, y: 0, z: 9 }, c, W, H)).toBeNull();
  });
  it('긴 직선이 화면 가장자리에서 정확히 잘린다 (경계 위 끝점)', () => {
    const seg = projectSegment({ x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: 2 }, c, W, H)!;
    expect(seg).not.toBeNull();
    for (const p of seg) expect(inside(p)).toBe(true);
  });
  it('mirror 는 좌우만 반전', () => {
    const a = projectSegment({ x: 1, y: 0, z: 3 }, { x: 1, y: 0, z: 6 }, c, W, H)!;
    const b = projectSegment({ x: 1, y: 0, z: 3 }, { x: 1, y: 0, z: 6 }, c, W, H, true)!;
    expect(a[0].x + b[0].x).toBeCloseTo(W, 3);
    expect(a[0].y).toBeCloseTo(b[0].y, 3);
  });
  it('inFront 와 clipToRect 기본 동작', () => {
    expect(inFront({ x: 0, y: 0, z: 3 }, c)).toBe(true);
    expect(inFront({ x: 0, y: 0, z: -3 }, c)).toBe(false);
    expect(clipToRect({ x: -50, y: 10 }, { x: -10, y: 20 }, W, H)).toBeNull();
    const r = clipToRect({ x: -50, y: 100 }, { x: 50, y: 100 }, W, H)!;
    expect(r[0].x).toBeCloseTo(0, 5);
  });
});
