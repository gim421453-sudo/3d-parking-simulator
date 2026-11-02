import { describe, expect, it } from 'vitest';
import { createVehicleState, stepVehicle } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';

describe('정차 중 조향각 유지 (v0.4.7)', () => {
  it('v=0, D 기어 브레이크 정지에서 steerInput 이 유지되면 실제 앞바퀴 조향각도 유지된다', () => {
    const spec = getVehicle('suv-x6');
    const s = createVehicleState(spec, 0, 0, 0);
    s.gear = 'D';
    for (let i = 0; i < 240; i++) stepVehicle(s, { throttle: 0, brake: 1, steerInput: 0.6 }, spec, 1 / 120);
    const st = s.steer;
    expect(st).toBeGreaterThan(0.1);
    for (let i = 0; i < 1200; i++) stepVehicle(s, { throttle: 0, brake: 1, steerInput: 0.6 }, spec, 1 / 120);
    expect(s.steer).toBeCloseTo(st, 6);
    expect(Math.abs(s.v)).toBeLessThan(0.01);
  });
});
