import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { createVehicleState } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';
import { stepVehicleInWorld } from '../src/vehicle/worldStep';
import { mapColliders, type MapData } from '../src/maps/types';

/** 벽 하나(z=10 앞면)만 있는 평면 맵 */
const wallMap: MapData = {
  id: 't', name: 't', desc: '', bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, env: { indoor: false, sky: 0, ambient: 1 }, spawn: { x: 0, z: 0, heading: 0 },
  surfaces: [], paint: [], slots: [], missions: [],
  obstacles: [{ id: 'w', tag: 'wall', shape: 'box', x: 0, z: 10.5, w: 60, d: 1, h: 2 }],
};
const cols: Collider[] = mapColliders(wallMap);
const spec = getVehicle('sedan');
const run = (heading: number, slide: boolean): { blocked: number; slid: number; frontZ: number; v: number } => {
  const car = createVehicleState(spec, 0, 4, heading);
  car.gear = 'D';
  let blocked = 0;
  let slid = 0;
  for (let i = 0; i < 120 * 8; i++) {
    const r = stepVehicleInWorld(car, { throttle: 1, brake: 0, steerInput: 0 }, spec, { bounds: wallMap.bounds, colliders: cols, levelAware: false, slide }, 1 / 120);
    if (r.blocked && Math.abs(r.prevV) > 0.1) blocked++;
    if (r.slid) slid++;
  }
  const off = spec.length / 2 - spec.rearOverhang;
  return { blocked, slid, frontZ: car.z + Math.cos(car.heading) * (off + spec.length / 2), v: car.v };
};

describe('월드 스텝: 접촉면 미끄러짐과 정면 충돌 (v0.5.5 수정)', () => {
  it('미끄러짐이 켜져 있어도 벽에 수직으로 돌진하면 충돌로 처리된다(이전: 미끄러짐으로 채택돼 충돌 기록 0)', () => {
    const r = run(0, true);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(r.slid).toBe(0);
    expect(r.frontZ).toBeLessThanOrEqual(10 + 1e-6); // 관통 없음
  });
  it('미끄러짐이 꺼져 있으면 이전과 같다', () => {
    const r = run(0, false);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(r.frontZ).toBeLessThanOrEqual(10 + 1e-6);
  });
  it('비스듬히(45°) 스치면 미끄러짐이 켜진 경우 벽을 따라 움직이고, 꺼진 경우 멈춘다. 어느 쪽도 관통하지 않는다', () => {
    const on = run(Math.PI / 4, true);
    const off = run(Math.PI / 4, false);
    expect(on.slid).toBeGreaterThan(0);
    expect(off.slid).toBe(0);
    expect(off.blocked).toBeGreaterThanOrEqual(1);
    for (const r of [on, off]) expect(r.frontZ).toBeLessThanOrEqual(10.05);
  });
});

import { resolveImpact, vehicleMassKg } from '../src/physics/impact';
import { centerOf } from '../src/vehicle/physics';
describe('월드 스텝 + 파손 콜백 (v0.6.0)', () => {
  const spec2 = getVehicle('sedan');
  const drive = (obstacles: MapData['obstacles'], v0: number): { impacts: number; passed: boolean; frontZ: number; v: number } => {
    const m: MapData = { ...wallMap, obstacles };
    const cols = mapColliders(m).map((c) => ({ ...c }));
    const dmg = new Map<string, number>();
    const car = createVehicleState(spec2, 0, 4, 0);
    car.gear = 'D';
    car.v = v0;
    let impacts = 0;
    let passed = false;
    for (let i = 0; i < 120 * 3; i++) {
      const r = stepVehicleInWorld(car, { throttle: 0, brake: 0, steerInput: 0 }, spec2, {
        bounds: m.bounds,
        colliders: cols,
        levelAware: false,
        impact: (hit, c) => {
          const cc = centerOf(c, spec2);
          const res = resolveImpact({ car: { x: cc.x, z: cc.z, heading: c.heading, hw: spec2.width / 2, hl: spec2.length / 2 }, v: c.v, carMass: vehicleMassKg(spec2), collider: hit, damage: dmg.get(hit.id) ?? 0 });
          dmg.set(hit.id, (dmg.get(hit.id) ?? 0) + res.damage);
          if (res.broke) cols.splice(cols.indexOf(hit), 1); // 게임처럼 부서진 충돌체 제거
          return { action: res.action, v: res.v };
        },
      }, 1 / 120);
      impacts += r.impacts.length;
      if (r.impacts.some((e) => e.action === 'pass')) passed = true;
    }
    const off = spec2.length / 2 - spec2.rearOverhang;
    return { impacts, passed, frontZ: car.z + Math.cos(car.heading) * (off + spec2.length / 2), v: car.v };
  };
  const barrier = [{ id: 'b', tag: 'barrier' as const, shape: 'box' as const, x: 0, z: 10.2, w: 3, d: 0.4, h: 0.9 }];
  it('방호벽: 시속 15km 는 막혀 관통하지 않고, 시속 60km 는 부수고 감속 통과한다', () => {
    const slow = drive(barrier, 15 / 3.6);
    expect(slow.impacts).toBeGreaterThan(0);
    expect(slow.passed).toBe(false);
    expect(slow.frontZ).toBeLessThanOrEqual(10.0 + 1e-6);
    const fast = drive(barrier, 60 / 3.6);
    expect(fast.passed).toBe(true);
    expect(fast.frontZ).toBeGreaterThan(10.4);
  });
  it('빠른 정면 충돌은 튕겨 나온다(속도 반전), 느린 접촉은 그 자리에 멈춘다', () => {
    const bld = [{ id: 'bd', tag: 'building' as const, shape: 'box' as const, x: 0, z: 15, w: 20, d: 10, h: 10 }];
    const hard = drive(bld, 40 / 3.6);
    expect(hard.passed).toBe(false);
    expect(hard.frontZ).toBeLessThan(10.0);
    const soft = drive(bld, 2 / 3.6);
    expect(soft.frontZ).toBeLessThanOrEqual(10 + 1e-6);
  });
  it('콜백이 없으면(헤드리스 검사) 이전 동작 그대로: 막히고 속도 0, impacts 비어 있음', () => {
    const car = createVehicleState(spec2, 0, 4, 0);
    car.gear = 'D';
    car.v = 10;
    let last = null as ReturnType<typeof stepVehicleInWorld> | null;
    for (let i = 0; i < 240; i++) last = stepVehicleInWorld(car, { throttle: 0, brake: 0, steerInput: 0 }, spec2, { bounds: wallMap.bounds, colliders: cols, levelAware: false }, 1 / 120);
    expect(last!.impacts).toEqual([]);
    expect(car.v).toBe(0);
  });
});
