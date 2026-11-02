import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Collider } from '../src/core/geometry';
import { localToWorld } from '../src/core/math';
import { frameView, type FrameResult } from '../src/pdc/framing';
import { getVehicle } from '../src/vehicle/spec';

const spec = getVehicle('suv-x6');
const pose = { x: 0, z: 0, heading: 0 };
const box = (x: number, z: number, w: number, d: number, h = 1.4, y0 = 0, id = 'b'): Collider => ({ kind: 'box', id, tag: 'wall', x, z, w, d, rot: 0, y0, h });
const camOf = (f: FrameResult, aspect = 16 / 9) => {
  const c = new THREE.PerspectiveCamera(f.fov, aspect, 0.1, 300);
  c.up.set(f.up.x, f.up.y, f.up.z);
  c.position.set(f.pos.x, f.pos.y, f.pos.z);
  c.lookAt(f.look.x, f.look.y, f.look.z);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
};
const ndc = (c: THREE.PerspectiveCamera, p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z).project(c);
const onScreen = (v: THREE.Vector3) => Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1;
const W = spec.width;

describe('측면 3D 프레이밍: 차체와 장애물 사이의 남은 공간이 보인다', () => {
  for (const gap of [0.6, 1.0, 1.4]) {
    it(`왼쪽 벽까지 ${gap}m: 차체 측면/틈/벽 표면이 모두 화면 안`, () => {
      const wx = W / 2 + gap + 0.25;
      const hits = [-1, -0.5, 0, 0.5, 1].map((z) => ({ x: W / 2 + gap, z }));
      const f = frameView({ view: 'left', pose, spec, hits, colliders: [box(wx, 0, 0.5, 8)], aspect: 16 / 9 });
      expect(f.visible).toBe(true);
      const c = camOf(f);
      for (const p of [
        { x: W / 2, y: 0.6, z: 0 },
        { x: W / 2 + gap / 2, y: 0.25, z: 0 },
        { x: W / 2 + gap, y: 0.6, z: 0 },
      ]) expect(onScreen(ndc(c, p))).toBe(true);
    });
  }
  it('오른쪽도 대칭으로 동작', () => {
    const gap = 0.9;
    const hits = [-0.5, 0, 0.5].map((z) => ({ x: -(W / 2 + gap), z }));
    const f = frameView({ view: 'right', pose, spec, hits, colliders: [box(-(W / 2 + gap + 0.25), 0, 0.5, 8)], aspect: 16 / 9 });
    expect(f.visible).toBe(true);
    const c = camOf(f);
    expect(onScreen(ndc(c, { x: -(W / 2 + gap / 2), y: 0.25, z: 0 }))).toBe(true);
    expect(f.pos.x).toBeLessThan(0); // 오른쪽 시점 카메라는 차량 오른쪽(-x)에 있다
  });
  it('차량 회전(heading)에도 월드 좌표로 올바른 프레이밍', () => {
    const p = { x: 5, z: -3, heading: 1.1 };
    const gap = 0.8;
    const hs = [-0.6, 0, 0.6].map((z) => localToWorld(p.x, p.z, p.heading, W / 2 + gap, z));
    const f = frameView({ view: 'left', pose: p, spec, hits: hs, colliders: [], aspect: 16 / 9 });
    const c = camOf(f);
    const mid = localToWorld(p.x, p.z, p.heading, W / 2 + gap / 2, 0);
    expect(onScreen(ndc(c, { x: mid.x, y: 0.25, z: mid.z }))).toBe(true);
  });
  it('카메라가 장애물 내부/차체 안에 놓이지 않는다', () => {
    const gap = 0.7;
    const hits = [{ x: W / 2 + gap, z: 0 }];
    const cols = [box(W / 2 + gap + 0.25, 0, 0.5, 8)];
    const f = frameView({ view: 'left', pose, spec, hits, colliders: cols, aspect: 16 / 9 });
    const inWall = Math.abs(f.pos.x - cols[0].x) < 0.25 && f.pos.y < cols[0].h;
    expect(inWall).toBe(false);
    expect(Math.abs(f.pos.x) <= W / 2 && f.pos.y < spec.height).toBe(false);
  });
  it('시야가 막히면(낮은 천장판) visible=false → 정책이 탑뷰로 전환', () => {
    const gap = 0.7;
    const hits = [{ x: W / 2 + gap, z: 0 }];
    const slab = box(0, 0, 40, 40, 0.5, 2.0, 'ceil');
    const f = frameView({ view: 'left', pose, spec, hits, colliders: [slab, box(W / 2 + gap + 0.25, 0, 0.5, 8)], aspect: 16 / 9 });
    expect(f.visible).toBe(false);
  });
  it('FOV 는 틈이 좁을수록 좁고(확대), 범위를 벗어나지 않는다', () => {
    const mk = (gap: number) => frameView({ view: 'left', pose, spec, hits: [{ x: W / 2 + gap, z: 0 }], colliders: [], aspect: 16 / 9 });
    const a = mk(0.5);
    const b = mk(1.5);
    for (const f of [a, b]) {
      expect(f.fov).toBeGreaterThanOrEqual(42);
      expect(f.fov).toBeLessThanOrEqual(78);
    }
  });
});

describe('탑뷰 프레이밍 (전체 / 확대)', () => {
  const corners = (p = pose) => [
    [W / 2, spec.length / 2],
    [-W / 2, spec.length / 2],
    [-W / 2, -spec.length / 2],
    [W / 2, -spec.length / 2],
  ].map(([x, z]) => localToWorld(p.x, p.z, p.heading, x, z));
  it('전체 탑뷰: 차량 4모서리와 모든 장애물 경계가 화면 안', () => {
    const hits = [
      { x: W / 2 + 0.8, z: 1 },
      { x: -(W / 2 + 0.9), z: -1 },
      { x: 0.3, z: spec.length / 2 + 1.5 },
    ];
    const f = frameView({ view: 'top', pose, spec, hits, colliders: [], aspect: 16 / 9 });
    const c = camOf(f);
    for (const p of [...corners(), ...hits]) expect(onScreen(ndc(c, { x: p.x, y: 0, z: p.z }))).toBe(true);
  });
  it('고정 높이가 아니라 장애물 분포에 따라 높이가 변한다', () => {
    const near = frameView({ view: 'top', pose, spec, hits: [{ x: W / 2 + 0.5, z: 0 }], colliders: [], aspect: 16 / 9 });
    const far = frameView({ view: 'top', pose, spec, hits: [{ x: W / 2 + 0.5, z: 0 }, { x: 0, z: 5.5 }, { x: 0, z: -5.5 }], colliders: [], aspect: 16 / 9 });
    expect(far.pos.y).toBeGreaterThan(near.pos.y);
  });
  it('확대 탑뷰: 전체 탑뷰보다 낮지만 과도하게 확대하지 않는다 (최소 높이)', () => {
    const hits = [{ x: -(W / 2 + 0.4), z: 0.5 }];
    const full = frameView({ view: 'top', pose, spec, hits, colliders: [], aspect: 16 / 9 });
    const zoom = frameView({ view: 'topZoom', pose, spec, hits, colliders: [], aspect: 16 / 9, focusSide: 'right' });
    expect(zoom.pos.y).toBeLessThanOrEqual(full.pos.y);
    expect(zoom.pos.y).toBeGreaterThanOrEqual(5.2);
    const c = camOf(zoom);
    expect(onScreen(ndc(c, { x: hits[0].x, y: 0, z: hits[0].z }))).toBe(true);
    expect(onScreen(ndc(c, { x: -W / 2, y: 0, z: 0.5 }))).toBe(true); // 차체 측면도 함께 보임
  });
  it('초점 방향 쪽으로 중심이 이동한다', () => {
    const hits = [{ x: -(W / 2 + 0.4), z: 0.5 }];
    const zoom = frameView({ view: 'topZoom', pose, spec, hits, colliders: [], aspect: 16 / 9, focusSide: 'right' });
    expect(zoom.look.x).toBeLessThan(0);
  });
});
