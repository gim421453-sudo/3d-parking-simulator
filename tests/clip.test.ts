import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipToRect, inFront, projectPolygon, projectSegment } from '../src/pdc/clip';

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

describe('수직 경고 패널: 3D 다각형 근평면 클리핑 (v0.4.8)', () => {
  const c = cam([0, 1, 0], [0, 0.8, 5]);
  const quad = (z0: number, z1: number, x0 = -1, x1 = 1) => [
    { x: x0, y: 0, z: z0 },
    { x: x1, y: 0, z: z1 },
    { x: x1, y: 1.2, z: z1 },
    { x: x0, y: 1.2, z: z0 },
  ];
  it('앞에 있는 수직 패널은 4개 꼭짓점으로 투영되고, 윗변이 밑변보다 화면 위에 있다 (바닥에 누운 것이 아님)', () => {
    const p = projectPolygon(quad(3, 3), c, W, H)!;
    expect(p).toHaveLength(4);
    const ys = p.map((q) => q.y);
    expect(Math.min(p[0].y, p[1].y)).toBeGreaterThan(Math.max(p[2].y, p[3].y)); // 밑변 y(아래) > 윗변 y(위)
    expect(ys.every((y) => Number.isFinite(y))).toBe(true);
  });
  it('수직 패널의 높이가 커지면 화면상 세로 길이가 커진다 (바닥 사각형과 달리 폭만 늘지 않음)', () => {
    const lo = projectPolygon([{ x: -1, y: 0, z: 3 }, { x: 1, y: 0, z: 3 }, { x: 1, y: 0.5, z: 3 }, { x: -1, y: 0.5, z: 3 }], c, W, H)!;
    const hi = projectPolygon([{ x: -1, y: 0, z: 3 }, { x: 1, y: 0, z: 3 }, { x: 1, y: 1.2, z: 3 }, { x: -1, y: 1.2, z: 3 }], c, W, H)!;
    const h = (p: { y: number }[]) => Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y));
    expect(h(hi)).toBeGreaterThan(h(lo) * 2);
  });
  it('카메라 뒤로 넘어간 부분은 근평면에서 잘라내고 남은 점은 모두 유한값', () => {
    const p = projectPolygon(quad(-2, 4), c, W, H)!;
    expect(p).not.toBeNull();
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  });
  it('전부 카메라 뒤면 null, mirror 는 좌우만 반전', () => {
    expect(projectPolygon(quad(-3, -6), c, W, H)).toBeNull();
    const a = projectPolygon(quad(3, 3, -1, 0.5), c, W, H, false)!;
    const b = projectPolygon(quad(3, 3, -1, 0.5), c, W, H, true)!;
    expect(a[0].x + b[0].x).toBeCloseTo(W, 4);
    expect(a[0].y).toBeCloseTo(b[0].y, 6);
  });
});
