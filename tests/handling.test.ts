import { describe, expect, it } from 'vitest';
import { createVehicleState, stepVehicle, maxSteerAt, type VehicleState } from '../src/vehicle/physics';
import { getVehicle, VEHICLES } from '../src/vehicle/spec';
import { dynBlend, handlingOf, understeerGradient } from '../src/vehicle/handling';

const run = (car: VehicleState, spec: ReturnType<typeof getVehicle>, sec: number, input: { throttle: number; brake: number; steerInput: number; mu?: number }, hold?: number): void => {
  for (let t = 0; t < sec; t += 1 / 240) {
    stepVehicle(car, input, spec, 1 / 240);
    if (hold !== undefined) car.v = hold;
  }
};

describe('핸들링 v0.6.2: 저속 기구학 보존 + 고속 동역학', () => {
  it('저속(≤3m/s)은 이전 기구학 모델과 완전히 같다(뒷축 횡미끄럼 0: 회전 반경 = 휠베이스/tan(조향))', () => {
    for (const spec of VEHICLES) {
      const car = createVehicleState(spec, 0, 0, 0);
      car.gear = 'D';
      car.steer = spec.maxSteer;
      const R = spec.wheelbase / Math.tan(spec.maxSteer);
      // 원 중심(왼쪽 R) 기준 반경이 유지되는지
      const cx = car.x + Math.cos(0) * R;
      const cz = car.z - Math.sin(0) * R;
      run(car, spec, 4, { throttle: 0, brake: 0, steerInput: 1 }, 2.0);
      expect(Math.hypot(car.x - cx, car.z - cz)).toBeCloseTo(R, 2);
      expect(Math.abs(car.vy! - car.yawRate! * spec.wheelbase * handlingOf(spec).frontWeight)).toBeLessThan(1e-9);
    }
  });
  it('후진은 속도와 무관하게 기구학(후진 고속 동역학 없음)', () => {
    const spec = getVehicle('sedan');
    const car = createVehicleState(spec, 0, 0, 0);
    car.gear = 'R';
    car.steer = 0.3;
    run(car, spec, 1, { throttle: 0, brake: 0, steerInput: 0.6 }, -2.5);
    expect(car.vy).toBeCloseTo(car.yawRate! * spec.wheelbase * handlingOf(spec).frontWeight, 9);
  });
  it('모든 차종이 언더스티어 성향(K>0)이고 SUV 가 쿠페보다 언더스티어가 크다', () => {
    for (const s of VEHICLES) expect(understeerGradient(handlingOf(s), s.wheelbase), s.id).toBeGreaterThan(0);
    const K = (id: string) => understeerGradient(handlingOf(getVehicle(id)), getVehicle(id).wheelbase);
    expect(K('suv-x6')).toBeGreaterThan(K('coupe-m4'));
    expect(K('suv')).toBeGreaterThan(K('sedan'));
  });
  it('정상 원선회(시속 54km, 같은 조향): 요 레이트가 기구학 값보다 작고 선형 이론(δ = L/R + K·ay)과 10% 안에서 맞는다', () => {
    const spec = getVehicle('sedan');
    const H = handlingOf(spec);
    const car = createVehicleState(spec, 0, 0, 0);
    car.gear = 'D';
    const v = 15;
    const steer = 0.02;
    car.v = v;
    car.steer = steer;
    // maxSteerAt 보다 작은 조향 → steerInput 은 비율
    const si = steer / maxSteerAt(spec, v);
    run(car, spec, 6, { throttle: 0, brake: 0, steerInput: si }, v);
    const rKin = (v / spec.wheelbase) * Math.tan(steer);
    expect(car.yawRate!).toBeLessThan(rKin);
    // 선형 이론: r = v / (L + K v²)
    const K = understeerGradient(H, spec.wheelbase);
    const rLin = (v * steer) / (spec.wheelbase + K * v * v);
    expect(Math.abs(car.yawRate! - rLin) / rLin).toBeLessThan(0.1);
  });
  it('접지 한계: 시속 90km 에서 조향을 끝까지 꺾어도 횡가속도는 μ·g 를 넘지 않는다(건조 1.0, 젖은 0.7)', () => {
    for (const mu of [1, 0.7]) {
      const spec = getVehicle('sedan');
      const car = createVehicleState(spec, 0, 0, 0);
      car.gear = 'D';
      car.v = 25;
      let maxAy = 0;
      for (let t = 0; t < 3; t += 1 / 240) {
        stepVehicle(car, { throttle: 0, brake: 0, steerInput: 1, mu }, spec, 1 / 240);
        car.v = 25;
        maxAy = Math.max(maxAy, Math.abs(car.ay!));
        expect(Number.isFinite(car.yawRate!)).toBe(true);
      }
      expect(maxAy, `mu ${mu}`).toBeLessThan(mu * 9.81 * 1.03);
      expect(maxAy).toBeGreaterThan(mu * 9.81 * 0.3);
    }
  });
  it('급제동 중 조향: 같은 조향에서 제동하면 횡가속도 한계가 줄어든다(마찰원)', () => {
    const spec = getVehicle('sedan');
    const lat = (brake: number): number => {
      const car = createVehicleState(spec, 0, 0, 0);
      car.gear = 'D';
      car.v = 25;
      let m = 0;
      for (let t = 0; t < 1.2; t += 1 / 240) {
        stepVehicle(car, { throttle: 0, brake, steerInput: 1 }, spec, 1 / 240);
        if (car.v > 12) m = Math.max(m, Math.abs(car.ay!));
      }
      return m;
    };
    expect(lat(1)).toBeLessThan(lat(0) * 0.85);
  });
  it('미끄러운 노면(μ 0.4)에서 제동 감속은 마찰 한계(≈3.7m/s²)로 줄어든다', () => {
    const spec = getVehicle('sedan');
    const car = createVehicleState(spec, 0, 0, 0);
    car.gear = 'D';
    car.v = 20;
    stepVehicle(car, { throttle: 0, brake: 1, steerInput: 0, mu: 0.4 }, spec, 0.5);
    const dec = (20 - car.v) / 0.5;
    expect(dec).toBeLessThan(0.4 * 9.81 + 1.2); // 구름/공기 저항 포함
    expect(dec).toBeGreaterThan(0.4 * 9.81 * 0.8);
  });
  it('저속 → 고속 전환(2.5→7m/s 가속, 조향 고정)에서 요 레이트가 튀지 않는다', () => {
    const spec = getVehicle('sedan');
    const car = createVehicleState(spec, 0, 0, 0);
    car.gear = 'D';
    car.v = 2.5;
    car.steer = 0.08;
    let prev = (car.v / spec.wheelbase) * Math.tan(car.steer);
    let maxJump = 0;
    for (let t = 0; t < 4; t += 1 / 240) {
      stepVehicle(car, { throttle: 0, brake: 0, steerInput: 0.08 / maxSteerAt(spec, car.v) }, spec, 1 / 240);
      car.v = 2.5 + t * 1.2;
      maxJump = Math.max(maxJump, Math.abs(car.yawRate! - prev));
      prev = car.yawRate!;
    }
    expect(dynBlend(2.9)).toBe(0);
    expect(dynBlend(6.1)).toBe(1);
    expect(maxJump).toBeLessThan(0.02); // 1/240s 당
  });
  it('시속 80km 차선 변경(약 3.5m): 끝나면 방향이 원래대로 돌아오고 스핀하지 않는다(모든 차종)', () => {
    for (const id of ['compact', 'sedan', 'suv', 'coupe-m4', 'suv-x6']) {
      const spec = getVehicle(id);
      const car = createVehicleState(spec, 0, 0, 0);
      car.gear = 'D';
      car.v = 22.2;
      let maxYaw = 0;
      const seq: [number, number][] = [
        [0.75, 0.8],
        [0.75, -0.8],
        [2.5, 0],
      ];
      for (const [d, si] of seq)
        for (let t = 0; t < d; t += 1 / 240) {
          stepVehicle(car, { throttle: 0.2, brake: 0, steerInput: si }, spec, 1 / 240);
          car.v = 22.2;
          maxYaw = Math.max(maxYaw, Math.abs(car.heading));
        }
      expect(Math.abs(car.heading), id).toBeLessThan(0.05);
      expect(maxYaw, id).toBeLessThan(0.35);
      expect(Math.abs(car.x), `${id} 옆으로 이동(한 차로)`).toBeGreaterThan(3);
    }
  });
  it('회귀: 시속 90km 풀조향 선회 + 선회 중 급제동에서도 스핀하지 않는다(한계 언더스티어 — 앞 접지 한계 < 뒤)', () => {
    for (const id of ['compact', 'sedan', 'suv', 'coupe-m4', 'suv-x6']) {
      const spec = getVehicle(id);
      for (const brakeAt of [99, 1.5]) {
        const car = createVehicleState(spec, 0, 0, 0);
        car.gear = 'D';
        car.v = 25;
        // 스핀 판정: 차체 횡미끄럼각 β = atan(vy / v) — 일반적으로 10~15° 를 넘으면 회복이 어렵다(스핀)
        let maxBeta = 0;
        for (let t = 0; t < 4; t += 1 / 240) {
          const br = t > brakeAt ? 1 : 0;
          stepVehicle(car, { throttle: br ? 0 : 0.5, brake: br, steerInput: 1 }, spec, 1 / 240);
          if (car.v > 6) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(car.vy!, car.v)));
          expect(Number.isFinite(car.x)).toBe(true);
        }
        expect((maxBeta * 180) / Math.PI, `${id} 제동 ${brakeAt}`).toBeLessThan(12);
        expect(Math.abs(car.yawRate!), `${id}`).toBeLessThan(1.2);
      }
    }
  });
  it('언덕: 모든 차종이 25%·30% 오르막에서 정지 상태로 출발해 올라가고, 평지 가속은 이전과 같다', () => {
    for (const spec of VEHICLES) {
      for (const g of [0.25, 0.3]) {
        const car = createVehicleState(spec, 0, 0, 0);
        car.gear = 'D';
        car.slope = Math.sin(Math.atan(g));
        for (let t = 0; t < 3; t += 1 / 240) {
          stepVehicle(car, { throttle: 1, brake: 0, steerInput: 0 }, spec, 1 / 240);
          car.slope = Math.sin(Math.atan(g));
        }
        expect(car.v, `${spec.id} ${g}`).toBeGreaterThan(1);
      }
      // 평지 1초 가속: 증배 없음(이전 식 accel·throttle 그대로)
      const flat = createVehicleState(spec, 0, 0, 0);
      flat.gear = 'D';
      stepVehicle(flat, { throttle: 1, brake: 0, steerInput: 0 }, spec, 1 / 240);
      expect(flat.v * 240).toBeCloseTo(spec.accel, 6);
    }
  });
});
