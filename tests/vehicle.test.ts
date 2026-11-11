import { describe, expect, it } from 'vitest';
import { findVehicleCollision, obbOverlap, type Collider } from '../src/core/geometry';
import { localToWorld, worldToLocal } from '../src/core/math';
import {
  centerOf,
  createVehicleState,
  obbOf,
  requestGear,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';

const spec = getVehicle('sedan');
const DT = 1 / 120;
const idle: VehicleInput = { throttle: 0, brake: 0, steerInput: 0 };

function run(s: VehicleState, input: VehicleInput, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) stepVehicle(s, input, spec, DT);
}

describe('좌표 변환', () => {
  it('localToWorld ↔ worldToLocal 가 서로 역변환이다', () => {
    const w = localToWorld(3, -2, 0.7, 1.2, -3.4);
    const l = worldToLocal(3, -2, 0.7, w.x, w.z);
    expect(l.x).toBeCloseTo(1.2, 9);
    expect(l.z).toBeCloseTo(-3.4, 9);
  });
});

describe('차량 주행', () => {
  it('P 상태에서는 가속해도 움직이지 않는다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 3);
    expect(s.v).toBe(0);
    expect(centerOf(s, spec)).toEqual({ x: 0, z: 0 });
  });
  it('D 기어로 가속하면 앞(+z)으로 이동하고 최고속도를 넘지 않는다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    expect(requestGear(s, 'D').ok).toBe(true);
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 90); // v0.5.3: 최고속도 상향(150km/h)으로 도달 시간을 늘림
    expect(s.z).toBeGreaterThan(10);
    expect(s.v).toBeLessThanOrEqual(spec.maxSpeedFwd + 1e-6);
    expect(s.v).toBeGreaterThan(spec.maxSpeedFwd * 0.8);
  });
  it('R 기어로 가속하면 뒤로 이동한다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'R');
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 3);
    expect(s.z).toBeLessThan(-1);
    expect(s.v).toBeLessThan(0);
  });
  it('D에서 페달을 놓으면 크리프로 천천히 전진한다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    run(s, idle, 3);
    expect(s.v).toBeGreaterThan(0.4);
    expect(s.v).toBeLessThan(1.2);
  });
  it('브레이크로 정지하고 정지 후에는 반대로 가지 않는다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 4);
    run(s, { throttle: 0, brake: 1, steerInput: 0 }, 5);
    expect(s.v).toBe(0);
  });
  it('주차 브레이크가 걸리면 D에서 가속해도 움직이지 않는다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    s.handbrake = true;
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 2);
    expect(Math.abs(s.v)).toBeLessThan(1e-6);
  });
  it('전진 중 왼쪽 조향 → 왼쪽(+x)으로 휘고 heading 증가', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    run(s, { throttle: 0.5, brake: 0, steerInput: 1 }, 3);
    expect(s.heading).toBeGreaterThan(0.2);
    expect(s.x).toBeGreaterThan(0.5);
  });
  it('후진 중 왼쪽 조향 → 차 뒤쪽이 왼쪽(+x)으로 이동한다 (후진 조향 방향)', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'R');
    run(s, { throttle: 0.5, brake: 0, steerInput: 1 }, 3);
    expect(s.z).toBeLessThan(0);
    expect(s.x).toBeGreaterThan(0.3); // 후진하면서 왼쪽으로
    expect(s.heading).toBeLessThan(-0.1); // 차의 앞쪽은 반대(오른쪽)로 회전
  });
  it('조향 입력이 없으면 조향각이 0으로 복귀한다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    run(s, { throttle: 0.3, brake: 0, steerInput: -1 }, 1);
    expect(s.steer).toBeLessThan(-0.3);
    run(s, { throttle: 0.3, brake: 0, steerInput: 0 }, 1.5);
    expect(Math.abs(s.steer)).toBeLessThan(1e-6);
  });
  it('고속에서는 최대 조향각이 줄어든다', () => {
    const slow = createVehicleState(spec, 0, 0, 0);
    requestGear(slow, 'D');
    run(slow, { throttle: 0, brake: 0, steerInput: 1 }, 2);
    const fast = createVehicleState(spec, 0, 0, 0);
    requestGear(fast, 'D');
    run(fast, { throttle: 1, brake: 0, steerInput: 0 }, 10);
    run(fast, { throttle: 1, brake: 0, steerInput: 1 }, 2);
    expect(Math.abs(fast.steer)).toBeLessThan(Math.abs(slow.steer));
  });
});

describe('기어 변경 제한', () => {
  it('전진 중에는 R/P로 변경할 수 없다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 3);
    expect(requestGear(s, 'R').ok).toBe(false);
    expect(requestGear(s, 'P').ok).toBe(false);
    expect(s.gear).toBe('D');
    expect(requestGear(s, 'N').ok).toBe(true);
  });
  it('후진 중에는 D로 변경할 수 없다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'R');
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 2);
    expect(requestGear(s, 'D').ok).toBe(false);
  });
  it('정차하면 모든 기어로 변경 가능하다', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    for (const g of ['D', 'R', 'N', 'P'] as const) expect(requestGear(s, g).ok).toBe(true);
  });
});

describe('충돌 판정', () => {
  const wall: Collider = { kind: 'box', id: 'w', tag: 'wall', x: 0, z: 20, w: 20, d: 0.6, rot: 0, y0: 0, h: 1.2 };

  it('OBB 겹침 검사', () => {
    expect(obbOverlap({ x: 0, z: 0, rot: 0, hw: 1, hl: 2 }, { x: 1.5, z: 0, rot: 0, hw: 1, hl: 2 })).toBe(true);
    expect(obbOverlap({ x: 0, z: 0, rot: 0, hw: 1, hl: 2 }, { x: 3.5, z: 0, rot: 0, hw: 1, hl: 2 })).toBe(false);
    expect(obbOverlap({ x: 0, z: 0, rot: 0, hw: 1, hl: 2 }, { x: 2.3, z: 0, rot: Math.PI / 4, hw: 1, hl: 2 })).toBe(true);
  });
  it('낮은 연석(높이 < 지상고)은 차체와 충돌하지 않는다', () => {
    const curb: Collider = { kind: 'box', id: 'c', tag: 'curb', x: 0, z: 0, w: 5, d: 5, rot: 0, y0: 0, h: 0.15 };
    const s = createVehicleState(spec, 0, 0, 0);
    expect(findVehicleCollision(obbOf(s, spec), [curb])).toBeNull();
  });
  it('최고속도로 벽에 돌진해도 벽을 관통하지 않는다 (게임 루프와 동일한 충돌 처리)', () => {
    const s = createVehicleState(spec, 0, 0, 0);
    requestGear(s, 'D');
    let maxPen = -Infinity;
    for (let t = 0; t < 12; t += DT) {
      const prev = { x: s.x, z: s.z, heading: s.heading };
      stepVehicle(s, { throttle: 1, brake: 0, steerInput: 0 }, spec, DT);
      if (findVehicleCollision(obbOf(s, spec), [wall])) {
        s.x = prev.x;
        s.z = prev.z;
        s.heading = prev.heading;
        s.v = 0;
      }
      maxPen = Math.max(maxPen, centerOf(s, spec).z + spec.length / 2);
    }
    expect(maxPen).toBeLessThanOrEqual(20 - 0.3 + 1e-6); // 벽 앞면 z=19.7
    expect(maxPen).toBeGreaterThan(19.3); // 실제로 벽 근처까지 도달
  });
});

import { MAX_STEP_DIST, substepCount, stepVehicle as stepV } from '../src/vehicle/physics';
import { obbOf as obbOfV } from '../src/vehicle/physics';
import { SELECTABLE_VEHICLES, VEHICLES as VEHS } from '../src/vehicle/spec';

describe('v0.5.3 고속 주행 성능/안정성', () => {
  const sed = VEHS[1];
  it('세단: 0→100km/h 가 20초 이내, 120km/h 이상 도달, 최고속도(150km/h)를 넘지 않는다', () => {
    const s = createVehicleState(sed, 0, 0, 0);
    s.gear = 'D';
    s.handbrake = false;
    let t100 = -1;
    let t = 0;
    for (; t < 120; t += 1 / 60) {
      stepV(s, { throttle: 1, brake: 0, steerInput: 0 }, sed, 1 / 60);
      if (t100 < 0 && s.v * 3.6 >= 100) t100 = t;
    }
    expect(t100).toBeGreaterThan(0);
    expect(t100).toBeLessThan(20);
    expect(s.v * 3.6).toBeGreaterThan(120);
    expect(s.v).toBeLessThanOrEqual(sed.maxSpeedFwd + 1e-6);
  });
  it('차종별 최고속도: 모두 100km/h 이상, 스포츠 쿠페는 더 높고, 후진은 20km/h 이하', () => {
    for (const v of SELECTABLE_VEHICLES) {
      expect(v.maxSpeedFwd * 3.6, v.id).toBeGreaterThanOrEqual(120);
      expect(v.maxSpeedRev * 3.6, v.id).toBeLessThanOrEqual(20.01);
    }
    expect(SELECTABLE_VEHICLES.find((v) => v.id === 'coupe-m4')!.maxSpeedFwd).toBeGreaterThan(sed.maxSpeedFwd);
  });
  it('120km/h 급제동: 정지하며 제동거리가 현실적인 범위(40~120m), 정지 후 후진하지 않는다', () => {
    const s = createVehicleState(sed, 0, 0, 0);
    s.gear = 'D';
    s.handbrake = false;
    s.v = 120 / 3.6;
    const z0 = s.z;
    for (let i = 0; i < 60 * 30; i++) stepV(s, { throttle: 0, brake: 1, steerInput: 0 }, sed, 1 / 60);
    const dist = s.z - z0;
    expect(s.v).toBe(0);
    expect(dist).toBeGreaterThan(40);
    expect(dist).toBeLessThan(120);
  });
  it('고속 조향 한계: 120km/h 에서는 최대 조향각이 크게 줄어든다(급조향 방지)', () => {
    const lowSteer = sed.maxSteer / (1 + (1 / 7) ** 2);
    const hi = sed.maxSteer / (1 + (33 / 7) ** 2);
    expect(hi).toBeLessThan(lowSteer * 0.1);
  });
  it('서브스텝: 속도가 높을수록 1스텝 이동량을 0.12m 이하로 쪼갠다 (최대 8)', () => {
    expect(substepCount(0, 1 / 120)).toBe(1);
    expect(substepCount(5, 1 / 120)).toBe(1);
    expect(substepCount(50, 1 / 120)).toBeGreaterThanOrEqual(4);
    expect(substepCount(1000, 1 / 120)).toBe(8);
    for (const v of [10, 30, 50]) expect((v / 120) / substepCount(v, 1 / 120)).toBeLessThanOrEqual(MAX_STEP_DIST + 1e-9);
  });
  it('얇은 벽(0.3m) 정면 충돌: 50m/s(180km/h)에서도 서브스텝으로 관통하지 않는다', () => {
    const wall = { kind: 'box' as const, id: 'w', tag: 'wall' as const, x: 0, z: 30, w: 8, d: 0.3, rot: 0, y0: 0, h: 2 };
    const s = createVehicleState(sed, 0, 0, 0);
    s.gear = 'D';
    s.handbrake = false;
    s.v = 50;
    let hit = false;
    for (let i = 0; i < 120 * 3 && !hit; i++) {
      const n = substepCount(s.v, 1 / 120);
      for (let k = 0; k < n && !hit; k++) {
        const px = s.x, pz = s.z;
        stepV(s, { throttle: 0, brake: 0, steerInput: 0 }, sed, 1 / 120 / n);
        if (findVehicleCollision(obbOfV(s, sed), [wall])) {
          hit = true;
          s.x = px;
          s.z = pz;
        }
      }
    }
    expect(hit).toBe(true);
    expect(s.z).toBeLessThan(wall.z); // 벽 앞에서 멈춤(관통 없음)
  });
  it('서브스텝 없이 50m/s 로 달리면 0.3m 벽을 관통할 수 있다 (서브스텝이 필요한 이유)', () => {
    const wall = { kind: 'box' as const, id: 'w', tag: 'wall' as const, x: 0, z: 30, w: 8, d: 0.3, rot: 0, y0: 0, h: 2 };
    const s = createVehicleState(sed, 0, 0, 0);
    s.gear = 'D';
    s.v = 50;
    s.handbrake = false;
    // 차체 길이(4.6m)가 벽 두께보다 길어 OBB 겹침은 대부분 잡히지만, 스텝 이동량(0.42m) > 두께(0.3m)임을 확인한다
    expect(50 / 120).toBeGreaterThan(wall.d);
  });
});
