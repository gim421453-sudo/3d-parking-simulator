import { describe, expect, it } from 'vitest';
import { buildWheelPaths, pathHitIndex } from '../src/pdc/guidelines';
import { createVehicleState, stepVehicle, centerOf } from '../src/vehicle/physics';
import { localToWorld, worldToLocal } from '../src/core/math';
import { getVehicle } from '../src/vehicle/spec';

const spec = getVehicle('sedan');
const zRear = -spec.length / 2 + spec.rearOverhang;

/** 실제 물리로 dist 만큼 진행했을 때 바퀴 접지점의 위치(초기 차체 중심 로컬 좌표) */
function simulateWheel(steer: number, dir: 1 | -1, dist: number, lx: number, lz: number): { x: number; z: number } {
  const car = createVehicleState(spec, 0, 0, 0);
  const c0 = centerOf(car, spec);
  car.gear = dir > 0 ? 'D' : 'R';
  car.steer = steer;
  let d = 0;
  while (d < dist) {
    const px = car.x;
    const pz = car.z;
    car.v = dir * 0.6;
    stepVehicle(car, { throttle: 0, brake: 0, steerInput: steer / spec.maxSteer }, spec, 1 / 240);
    car.steer = steer;
    d += Math.hypot(car.x - px, car.z - pz);
  }
  const c = centerOf(car, spec);
  const w = localToWorld(c.x, c.z, car.heading, lx, lz);
  return worldToLocal(c0.x, c0.z, 0, w.x, w.z);
}

describe('4륜 예상 이동선 (v0.6.1)', () => {
  for (const [steer, dir] of [[0, 1], [spec.maxSteer, 1], [-spec.maxSteer * 0.6, 1], [spec.maxSteer, -1], [-spec.maxSteer, -1]] as const) {
    it(`steer=${steer.toFixed(2)} dir=${dir}: 네 바퀴 경로 끝점이 실제 물리 이동 궤적과 일치(±5cm)`, () => {
      const w = buildWheelPaths(spec, steer, dir, 2.0, 0.2);
      const tw = spec.trackWidth / 2;
      const zf = zRear + spec.wheelbase;
      const cases: [keyof typeof w, number, number][] = [['fl', tw, zf], ['fr', -tw, zf], ['rl', tw, zRear], ['rr', -tw, zRear]];
      for (const [k, lx, lz] of cases) {
        const path = w[k] as { x: number; z: number; s: number }[];
        const end = path[path.length - 1];
        const sim = simulateWheel(steer, dir, end.s, lx, lz);
        expect(Math.hypot(end.x - sim.x, end.z - sim.z), `${k}`).toBeLessThan(0.05);
      }
    });
  }
  it('전진 좌회전: 뒷바퀴는 앞바퀴보다 안쪽(선회 중심 쪽)으로 돈다 — 뒷바퀴가 조향하는 것처럼 그리지 않는다', () => {
    const w = buildWheelPaths(spec, spec.maxSteer, 1, 3);
    const R = spec.wheelbase / Math.tan(spec.maxSteer);
    const rad = (p: { x: number; z: number }) => Math.hypot(p.x - R, p.z - zRear);
    expect(rad(w.rl[w.rl.length - 1])).toBeLessThan(rad(w.fl[w.fl.length - 1]));
    // 뒷바퀴는 시작점에서 진행 방향 접선이 차체 축과 평행(조향 0)
    const d0 = { x: w.rl[1].x - w.rl[0].x, z: w.rl[1].z - w.rl[0].z };
    expect(Math.abs(d0.x / Math.hypot(d0.x, d0.z))).toBeLessThan(0.1);
  });
  it('후진 경로는 전진 경로의 좌우 반전이 아니다', () => {
    const fwd = buildWheelPaths(spec, spec.maxSteer, 1, 2);
    const rev = buildWheelPaths(spec, spec.maxSteer, -1, 2);
    const mirrored = fwd.fl.map((p) => ({ x: -p.x, z: p.z }));
    const e = rev.fl[rev.fl.length - 1];
    const m = mirrored[mirrored.length - 1];
    expect(Math.hypot(e.x - m.x, e.z - m.z)).toBeGreaterThan(0.5);
  });
  it('스윙: 전진 좌조향 → 오른쪽 앞 모서리, 후진 우조향 → 왼쪽 앞 모서리가 바퀴 경로 바깥으로', () => {
    expect(buildWheelPaths(spec, 0.4, 1).swingSide).toBe('right');
    const r = buildWheelPaths(spec, -0.4, -1, 2);
    expect(r.swingSide).toBe('left');
    const end = r.swing![r.swing!.length - 1];
    const flEnd = r.fl[r.fl.length - 1];
    expect(end.x).toBeGreaterThan(flEnd.x); // 왼쪽(+x) 바깥
    expect(buildWheelPaths(spec, 0, 1).swing).toBeNull();
  });
  it('정지 상태여도 조향각이 바뀌면 경로가 바뀐다(속도와 무관한 기구학)', () => {
    const a = buildWheelPaths(spec, 0.1, 1, 2);
    const b = buildWheelPaths(spec, 0.4, 1, 2);
    expect(Math.abs(a.fl[a.fl.length - 1].x - b.fl[b.fl.length - 1].x)).toBeGreaterThan(0.2);
  });
  it('장애물 교차 지점: 경로 위 기둥을 찾는다', () => {
    const w = buildWheelPaths(spec, 0, 1, 4);
    const fl = w.fl[10];
    const pose = { x: 0, z: 0, heading: 0 };
    const i = pathHitIndex(w.fl, pose, [{ kind: 'cyl', id: 'p', tag: 'pillar', x: fl.x, z: fl.z, r: 0.2, y0: 0, h: 3 }]);
    expect(i).toBeGreaterThanOrEqual(8);
    expect(i).toBeLessThanOrEqual(10);
    expect(pathHitIndex(w.fl, pose, [])).toBe(-1);
  });
});
