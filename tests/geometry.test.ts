import { describe, expect, it } from 'vitest';

import { findVehicleCollision as fvc } from '../src/core/geometry';
describe('v0.6.2 회귀: 높이 구간 판정(다층/실제 지형)', () => {
  it('지면이 y=0 아래인 곳(해수면 기준 낮은 지역)의 건물도 같은 높이의 차량과 충돌한다 — 절대 높이 0.2m 로 "낮은 물체" 판정 금지', () => {
    const box = { kind: 'box' as const, id: 'b', tag: 'building', x: 0, z: 0, w: 20, d: 10, rot: 0.3, y0: -48.66, h: 16 };
    const car = { x: 0, z: 0, rot: 0.3, hw: 0.92, hl: 2.3 };
    expect(fvc(car, [box], -42.4, 1.45)?.id).toBe('b');
    // 같은 물체라도 차량이 위층(높이 구간 밖)이면 충돌 아님
    expect(fvc(car, [box], -20, 1.45)).toBeNull();
    // 높이 정보 없는 평면 맵은 이전 규칙(지상고 아래 낮은 물체는 통과)
    expect(fvc(car, [{ ...box, y0: 0, h: 0.15 }])).toBeNull();
  });
});

import { getMap, mapColliders } from '../src/maps';
import { B1_Y } from '../src/maps/mapMegaPark';
describe('v0.6.2 회귀: 통합 맵 지하(B1, y=-3.2) 물체가 차량을 막는다', () => {
  it('B1 기둥·방호벽·주차 차량은 같은 층 차량과 충돌한다(이전: 절대 높이 0.2m 판정으로 통과)', () => {
    const cs = mapColliders(getMap('megapark'));
    for (const id of ['ug:upil-n4', 'ug:ubar-1', 'ug:uaisle-car']) {
      const c = cs.find((q) => q.id === id)!;
      expect(c, id).toBeDefined();
      expect(fvc({ x: c.x, z: c.z, rot: 0, hw: 0.9, hl: 2.3 }, [c], B1_Y, 1.45)?.id, id).toBe(id);
    }
  });
});
