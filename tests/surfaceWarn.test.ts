import { describe, expect, it } from 'vitest';
import { findVehicleCollision, type BoxCollider, type Collider, type CylCollider } from '../src/core/geometry';
import { readSensors, DEFAULT_SENSOR_CONFIG } from '../src/sensors/sensorSystem';
import { buildSurfaceWarnings, SURF_EPS, SURF_H_MAX } from '../src/pdc/surfaceWarn';
import { buildCameraTiles } from '../src/pdc/overlay';
import { getVehicle } from '../src/vehicle/spec';
import { worldToLocal } from '../src/core/math';
import { pointToObbGap } from '../src/pdc/risk';

const spec = getVehicle('sedan');
const pose = { x: 0, z: 0, heading: 0 };
const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
const snapOf = (cols: Collider[]) => readSensors(pose, spec.sensors, spec.sensorHeight, cols, DEFAULT_SENSOR_CONFIG);
const byId = (cols: Collider[]) => (id: string) => cols.find((c) => c.id === id);
const wall = (deg: number, dist = 0.9, id = 'w'): BoxCollider => {
  // 앞범퍼(hl) 앞 dist 에 중심이 오고 deg 만큼 회전한 4m × 0.3m 벽
  return { kind: 'box', id, tag: 'wall', x: 0, z: body.hl + dist, w: 4, d: 0.3, rot: (deg * Math.PI) / 180, y0: 0, h: 2 };
};
/** 판 밑변(corners[3]→[2])이 상자 면 위(면에서 SURF_EPS 바깥)에 있고 면과 평행한가 */
const onBoxFace = (c: BoxCollider, a: { x: number; z: number }, b: { x: number; z: number }): boolean => {
  const la = worldToLocal(c.x, c.z, c.rot, a.x, a.z);
  const lb = worldToLocal(c.x, c.z, c.rot, b.x, b.z);
  const onX = (p: { x: number }) => Math.abs(Math.abs(p.x) - (c.w / 2 + SURF_EPS)) < 1e-6;
  const onZ = (p: { z: number }) => Math.abs(Math.abs(p.z) - (c.d / 2 + SURF_EPS)) < 1e-6;
  return (onX(la) && onX(lb) && Math.sign(la.x) === Math.sign(lb.x)) || (onZ(la) && onZ(lb) && Math.sign(la.z) === Math.sign(lb.z));
};

describe('PDC 경고가 실제 표면에 붙는다 (v0.6.1, 스크린샷 S1~S7 원인 수정)', () => {
  for (const deg of [0, 30, 45, -30]) {
    it(`앞 벽 ${deg}° 회전: 판은 벽 하나당 1장, 밑변이 벽 앞면 위에 있고 벽과 평행 (차량 축 방향 고정 판 아님)`, () => {
      const c = wall(deg);
      const z = buildSurfaceWarnings(snapOf([c]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([c]) });
      expect(z.length).toBe(1);
      expect(onBoxFace(c, z[0].corners[3], z[0].corners[2])).toBe(true);
      expect(z[0].colliderIds).toEqual(['w']);
      // 바닥 띠는 표면에서 차량 쪽으로 (판이 벽 뒤나 공중에 생기지 않는다)
      const mid = { x: (z[0].corners[0].x + z[0].corners[1].x) / 2, z: (z[0].corners[0].z + z[0].corners[1].z) / 2 };
      const surf = { x: (z[0].corners[2].x + z[0].corners[3].x) / 2, z: (z[0].corners[2].z + z[0].corners[3].z) / 2 };
      expect(Math.hypot(mid.x - body.x, mid.z - body.z)).toBeLessThan(Math.hypot(surf.x - body.x, surf.z - body.z));
      expect(z[0].panelHeight).toBeLessThanOrEqual(SURF_H_MAX);
    });
  }
  it('이전 방식은 30° 벽에서 같은 벽을 여러 장(계단)으로 그렸다 — 새 방식은 1장', () => {
    const c = wall(30);
    const old = buildCameraTiles(snapOf([c]), spec, body, 'front', 2.5, 0.3);
    const neu = buildSurfaceWarnings(snapOf([c]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([c]) });
    expect(old.length).toBeGreaterThan(1);
    expect(neu.length).toBe(1);
  });
  it('원기둥(기둥/볼라드): 판 밑변 끝점이 모두 원기둥 표면(r + ε) 위', () => {
    const p: CylCollider = { kind: 'cyl', id: 'p', tag: 'pillar', x: 0.4, z: body.hl + 0.8, r: 0.3, y0: 0, h: 3 };
    const z = buildSurfaceWarnings(snapOf([p]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([p]) });
    expect(z.length).toBeGreaterThan(0);
    for (const q of z) for (const v of [q.corners[2], q.corners[3]]) expect(Math.hypot(v.x - p.x, v.z - p.z)).toBeCloseTo(p.r + SURF_EPS, 6);
  });
  it('두 물체(벽 + 볼라드)는 따로 표시된다(서로 합치지 않음)', () => {
    const c = wall(0, 1.6);
    const bol: CylCollider = { kind: 'cyl', id: 'b', tag: 'bollard', x: -0.3, z: body.hl + 0.6, r: 0.1, y0: 0, h: 0.95 };
    const z = buildSurfaceWarnings(snapOf([c, bol]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([c, bol]) });
    const ids = new Set(z.flatMap((q) => q.colliderIds));
    expect(ids.has('b')).toBe(true);
    for (const q of z) expect(q.colliderIds.length).toBe(1);
    // 볼라드가 더 가까우니 더 위험한 단계
    const rank = { far: 1, mid: 2, near: 3, critical: 4 } as const;
    const lb = Math.max(...z.filter((q) => q.colliderIds[0] === 'b').map((q) => rank[q.level]));
    const lw = Math.max(...z.filter((q) => q.colliderIds[0] === 'w').map((q) => rank[q.level]), 0);
    expect(lb).toBeGreaterThanOrEqual(lw);
  });
  it('비스듬히 선 주차 차량(40°): 판이 차량 옆면을 따라간다', () => {
    const car: BoxCollider = { kind: 'box', id: 'car', tag: 'car', x: 1.2, z: body.hl + 1.6, w: 1.85, d: 4.7, rot: 0.7, y0: 0, h: 1.45 };
    const z = buildSurfaceWarnings(snapOf([car]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([car]) });
    expect(z.length).toBeGreaterThan(0);
    for (const q of z) expect(onBoxFace(car, q.corners[3], q.corners[2])).toBe(true);
  });
  it('밀려난 물체/벽 조각: 현재 충돌체 기하로 판을 만든다(이동 후 위치), 사라진 물체는 판이 없다', () => {
    const moved = { ...wall(0, 1.2, 'm'), x: 0.8 };
    const z = buildSurfaceWarnings(snapOf([moved]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([moved]) });
    expect(z.length).toBe(1);
    expect(onBoxFace(moved, z[0].corners[3], z[0].corners[2])).toBe(true);
    expect(buildSurfaceWarnings(snapOf([]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: () => undefined })).toEqual([]);
  });
  it('기하를 모르는 물체는 히트점 근처의 작은 판(≤ 0.6m)만 — 큰 판을 지어내지 않는다', () => {
    const c = wall(20, 1.0);
    const z = buildSurfaceWarnings(snapOf([c]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: () => undefined });
    expect(z.length).toBe(1);
    expect(Math.hypot(z[0].corners[2].x - z[0].corners[3].x, z[0].corners[2].z - z[0].corners[3].z)).toBeLessThanOrEqual(0.6 + 1e-9);
  });
  it('후방: 뒤 벽 판은 벽 면 위에 생기고, 어떤 꼭짓점도 차체 안에 들어가지 않는다', () => {
    const c: BoxCollider = { ...wall(15), z: -(body.hl + 0.7) };
    const z = buildSurfaceWarnings(snapOf([c]), spec, body, { dir: 'rear', range: 2.5, critical: 0.3, colliderOf: byId([c]) });
    expect(z.length).toBe(1);
    expect(onBoxFace(c, z[0].corners[3], z[0].corners[2])).toBe(true);
    for (const v of z[0].corners) expect(pointToObbGap(v.x, v.z, body)).toBeGreaterThan(0);
    expect(findVehicleCollision(body, [c])).toBeNull();
  });
  it('회귀(스모크 v0.4.8): 작은 기둥(반지름 0.15m)은 판 2개 이하 — 원호 길이 때문에 잘게 쪼개지지 않는다', () => {
    const c: CylCollider = { kind: 'cyl', id: 'pil', tag: 'pillar', x: 0, z: body.hl + 1.0 + 0.15, r: 0.15, y0: 0, h: 3 };
    const z = buildSurfaceWarnings(snapOf([c]), spec, body, { dir: 'front', range: 2.5, critical: 0.3, colliderOf: byId([c]) });
    expect(z.length).toBeGreaterThanOrEqual(1);
    expect(z.length).toBeLessThanOrEqual(2);
  });
});
