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
    run(s, { throttle: 1, brake: 0, steerInput: 0 }, 12);
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
