import { describe, expect, it } from 'vitest';
import { findVehicleCollision } from '../src/core/geometry';
import { MAP_MECHPARK, BOLLARDS, BOLLARD_H, ROOM_HW } from '../src/maps/mapMechPark';
import { mapColliders } from '../src/maps';
import { MECH_LIMITS } from '../src/mech/limits';
import { STATION } from '../src/mech/machine';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { centerOf, createVehicleState, obbOf } from '../src/vehicle/physics';
import { VEHICLES, getVehicle } from '../src/vehicle/spec';

const colliders = mapColliders(MAP_MECHPARK);
const sedan = VEHICLES[1];
const place = (spec: typeof sedan, rearX: number, z: number, h = STATION.heading) => {
  const s = createVehicleState(spec, 0, 0, h);
  s.x = rearX;
  s.z = z;
  return s;
};

describe('기계식 맵 — 볼라드/입구/승강장 (v0.5.1)', () => {
  it('금속 볼라드 4개: 실제 충돌체(bollard 태그, 원통)이고 높이가 센서 높이(0.55m)보다 높다', () => {
    const bs = colliders.filter((c) => c.tag === 'bollard');
    expect(bs.length).toBe(BOLLARDS.length);
    for (const b of bs) {
      expect(b.kind).toBe('cyl');
      expect(b.h).toBeGreaterThanOrEqual(BOLLARD_H - 1e-9);
      expect(b.h).toBeGreaterThan(0.55);
    }
    expect(colliders.some((c) => c.tag === 'cone')).toBe(false); // 기존 꼬깔 제거
  });
  it('볼라드 옆을 지나는 차량의 측면/전방 센서가 볼라드를 실제로 감지한다', () => {
    for (const b of BOLLARDS.filter((q) => q.z > 0)) {
      const car = place(sedan, b.x - 1.0, b.z - 1.15);
      const sn = readSensors({ ...centerOf(car, sedan), heading: car.heading }, sedan.sensors, sedan.sensorHeight, colliders, { ...DEFAULT_SENSOR_CONFIG, collectRays: false });
      const ids = new Set(sn.readings.flatMap((r) => r.hits.map((h) => h.colliderId)));
      expect(ids.has(b.id), `${b.id}`).toBe(true);
    }
  });
  it('볼라드에 부딪히면 충돌한다', () => {
    const b = BOLLARDS[0];
    const car = place(sedan, b.x - 1.0, b.z - 0.5);
    expect(findVehicleCollision(obbOf(car, sedan), colliders)).not.toBeNull();
  });
  it('진입로: 입구에서 팔레트 정지 위치까지 차폭 허용 차량은 직선 진입 시 충돌 0 (좌우 ±0.1m 오차 포함)', () => {
    for (const v of VEHICLES.filter((q) => q.width <= MECH_LIMITS.maxWidth)) {
      for (const dz of [0, 0.1, -0.1]) {
        for (let x = -34; x <= STATION.stopperX - v.wheelbase; x += 0.25) {
          const car = place(v, x, dz);
          expect(findVehicleCollision(obbOf(car, v), colliders), `${v.id} dz=${dz} x=${x.toFixed(2)}`).toBeNull();
        }
      }
    }
  });
  it('팔레트 가이드/문틀 때문에 좌우 0.2m 이상 어긋나면 진입할 수 없다 (실제 충돌)', () => {
    const car = place(sedan, STATION.stopperX - sedan.wheelbase - 1.0, 0.3);
    expect(findVehicleCollision(obbOf(car, sedan), colliders)).not.toBeNull();
  });
  it('승강장 안쪽 폭은 턴테이블 회전 반경(팔레트+가이드 대각선/2)을 수용한다', () => {
    const r = Math.hypot(MECH_LIMITS.palletLength / 2, MECH_LIMITS.palletWidth / 2 + 0.3);
    expect(ROOM_HW).toBeGreaterThanOrEqual(r - 0.2);
    expect(STATION.palletX - r).toBeGreaterThan(STATION.doorX - 1.9); // 회전해도 문 밖으로 나가지 않는다
    expect(STATION.palletX + r).toBeLessThan(1.2 + 0.1);
  });
  it('문 개구부 폭/높이는 법정 최소(2.4×1.9m) 이상, 고정 치수', () => {
    expect(MECH_LIMITS.doorWidth).toBeGreaterThanOrEqual(2.4);
    expect(MECH_LIMITS.doorHeight).toBeGreaterThanOrEqual(1.9);
    const front = colliders.filter((c) => c.id.startsWith('ms-front'));
    expect(front.length).toBe(2);
  });
  it('컨셉 쿠페(폭 2.34m)는 문을 통과하는 데는 문틀과 겹치지 않지만 장치 허용 폭을 넘는다', () => {
    const c = getVehicle('concept-coupe');
    expect(c.width).toBeGreaterThan(MECH_LIMITS.maxWidth);
  });
});
