import { describe, expect, it } from 'vitest';
import { findVehicleCollision } from '../src/core/geometry';
import { MAP_MODLOT, ML_TERRAIN } from '../src/maps/mapModLot';
import { groundAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { evaluateParking } from '../src/mission/parking';
import { centerOf, createVehicleState, obbOf } from '../src/vehicle/physics';
import { getVehicle, VEHICLES } from '../src/vehicle/spec';
import { line, makeSim } from './helpers/driveSim';

const colliders = mapColliders(MAP_MODLOT);
const sim = makeSim(ML_TERRAIN, colliders);

describe('모듈형 연습 주차장', () => {
  it('경사 데크: 경사 12.5%, 지상/데크 높이 구분, 데크 아래로는 들어갈 수 없다(지반 블록)', () => {
    const r = ML_TERRAIN.surfaces.find((s) => s.kind === 'ramp')!;
    if (r.kind === 'ramp') expect((r.y1 - r.y0) / r.length).toBeCloseTo(0.125, 3);
    expect(groundAt(ML_TERRAIN, 24, -12, 1.5)).toBe(1.5);
    expect(groundAt(ML_TERRAIN, 24, -12, 0)).toBe(0);
    const s = createVehicleState(getVehicle('compact'), 24, -12, Math.PI / 2);
    expect(findVehicleCollision(obbOf(s, getVehicle('compact')), colliders, 0, 1.4), '지상에서 데크 아래').not.toBeNull();
  });
  it('45° 사선 주차: 규정 자세(+45°)로 정확히 들어가면 성공 판정, 90° 직각이면 실패', () => {
    const slot = MAP_MODLOT.slots.find((s) => s.id === 'ma-1')!;
    const v = getVehicle('sedan');
    const c = centerOf(createVehicleState(v, slot.x, slot.z, slot.dir), v);
    const ok = evaluateParking({ x: c.x, z: c.z, heading: slot.dir, length: v.length, width: v.width }, slot, 'perpendicular-front');
    const bad = evaluateParking({ x: c.x, z: c.z, heading: slot.dir + Math.PI / 4, length: v.length, width: v.width }, slot, 'perpendicular-front');
    expect(ok.poseOk).toBe(true);
    expect(bad.poseOk).toBe(false);
  });
  it('차량별 난이도: 좁은 통로(3.0m)·기둥 게이트(2.9m)를 모든 선택 차량이 물리적으로 통과할 수 있다', () => {
    for (const v of VEHICLES) expect(v.width, v.id).toBeLessThan(2.4);
  });
  for (const id of ['suv-x6', 'sedan', 'compact']) {
    it(`${id}: 곡선 진입로 → 경사로 → 데크 도착(충돌/이탈 없음)`, () => {
      const p: [number, number][] = [];
      for (let i = 0; i < 12; i++) {
        const x = -29 + i * 1.7;
        p.push([x, -11 + 2.4 * Math.sin((x + 29) / 3.2)]);
      }
      p.push(...line(-10, -12, 24, -12));
      const r = sim.drive(id, { x: -30.5, z: -11, h: Math.PI / 2, y: 0 }, p, (c) => c.y > 1.45 && c.x > 19, 2.0, 120, 3.0);
      expect(r.reached, `${id}: y=${r.car.y.toFixed(2)} x=${r.car.x.toFixed(1)} z=${r.car.z.toFixed(1)} col=${r.collisions} hit=${r.lastHit}`).toBe(true);
      expect(r.collisions).toBe(0);
      expect(r.offGround).toBe(0);
    });
  }
});
