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
