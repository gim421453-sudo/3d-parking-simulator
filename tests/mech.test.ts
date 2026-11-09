import { describe, expect, it } from 'vitest';
import { VEHICLES, SELECTABLE_VEHICLES, getVehicle } from '../src/vehicle/spec';
import { checkVehicleLimits, MECH_LIMITS } from '../src/mech/limits';
import { ALIGN_TOL, STATION, alignment, canStart, emergencyRelease, emergencyStop, lockedPose, newMachine, releaseVehicle, requestRetrieve, startStore, stepMachine, stopperPushback, storeDuration, toggleOccupant, type AlignInput } from '../src/mech/machine';

const sedan = VEHICLES[1];
/** 팔레트 위에 정확히 올라간 자세 (앞바퀴가 정지턱 위치) */
function ideal(spec = sedan, dz = 0, dh = 0): AlignInput {
  const rearX = STATION.stopperX - spec.wheelbase;
  return { x: rearX, z: dz, heading: STATION.heading + dh, v: 0, gear: 'P', handbrake: true };
}
function runAll(m: ReturnType<typeof newMachine>, secs: number, clear = true): void {
  for (let i = 0; i < secs * 60; i++) stepMachine(m, 1 / 60, clear);
}

describe('기계식 주차 — 치수 제한', () => {
  it('일반 승용/세단 허용', () => {
    expect(checkVehicleLimits(sedan).ok).toBe(true);
  });
  it('차폭 초과(컨셉 쿠페 2.34m) 거부, 이유에 차폭 포함', () => {
    const c = getVehicle('concept-coupe');
    const r = checkVehicleLimits(c);
    expect(r.ok).toBe(false);
    expect(r.width).toBe(false);
    expect(r.reasons.join()).toContain('차폭');
  });
  it('차고 초과 거부', () => {
    expect(checkVehicleLimits({ ...sedan, height: 1.62 }).height).toBe(false);
  });
  it('SUV 는 판정 결과가 일관 (허용 또는 사유 명시)', () => {
    for (const v of SELECTABLE_VEHICLES) {
      const r = checkVehicleLimits(v);
      expect(r.ok).toBe(r.reasons.length === 0);
    }
  });
  it('법정 최소 치수 상수', () => {
    expect(MECH_LIMITS.doorWidth).toBeGreaterThanOrEqual(2.4);
    expect(MECH_LIMITS.doorHeight).toBeGreaterThanOrEqual(1.9);
    expect(MECH_LIMITS.palletWidth).toBeGreaterThanOrEqual(2.15);
  });
});

describe('기계식 주차 — 팔레트 정렬/가이드/정지턱', () => {
  it('정중앙 정렬 + 정지턱: 모든 조건 통과', () => {
    const a = alignment(sedan, ideal());
    expect(Math.abs(a.lateral)).toBeLessThan(0.01);
    expect(a.wheelsInGrooves).toBe(true);
    expect(a.atStopper).toBe(true);
    expect(a.guideInvasion.some(Boolean)).toBe(false);
  });
  it('좌우로 크게 치우치면 가이드 침범', () => {
    const a = alignment(sedan, ideal(sedan, 0.3));
    expect(a.guideInvasion.some(Boolean)).toBe(true);
    expect(a.wheelsInGrooves).toBe(false);
  });
  it('정지턱: 넘어가면 되밀기 거리 > 0, 위치면 0', () => {
    expect(stopperPushback(sedan, ideal())).toBeCloseTo(0, 2);
    const s = ideal();
    s.x += 0.3;
    expect(stopperPushback(sedan, s)).toBeCloseTo(0.3, 1);
  });
  it('정지턱 전(0.8m 앞)은 atStopper 아님', () => {
    const s = ideal();
    s.x -= 0.8;
    expect(alignment(sedan, s).atStopper).toBe(false);
  });
});

describe('기계식 주차 — 입고/승강/출고', () => {
  it('하차하지 않으면 입고 거부', () => {
    const m = newMachine();
    expect(startStore(sedan, ideal(), m, 'A1')).toBe(false);
    expect(m.message).toContain('운전자 하차');
  });
  it('P/브레이크 없이는 하차 불가', () => {
    const m = newMachine();
    const s = ideal();
    s.gear = 'D';
    expect(toggleOccupant(s, m).ok).toBe(false);
  });
  it('중앙/방향 불량이면 거부', () => {
    const m = newMachine();
    toggleOccupant(ideal(), m);
    expect(startStore(sedan, ideal(sedan, 0.2), m, 'A1')).toBe(false);
    expect(startStore(sedan, ideal(sedan, 0, 6 * (Math.PI / 180)), m, 'A1')).toBe(false);
  });
  it('폭 초과 차량 거부', () => {
    const m = newMachine();
    const c = getVehicle('concept-coupe');
    toggleOccupant(ideal(c), m);
    expect(startStore(c, ideal(c), m, 'A1')).toBe(false);
    expect(m.message).toContain('차폭');
    expect(m.phase).toBe('waiting');
  });
  it('전체 사이클: 입고 → 저장 → 출고 → 출차', () => {
    const m = newMachine();
    const s = ideal();
    expect(toggleOccupant(s, m).ok).toBe(true);
    expect(canStart(sedan, s, m).ok).toBe(true);
    expect(startStore(sedan, s, m, 'B1')).toBe(true);
    expect(m.locked).toBe(true);
    // 문이 닫히기 전에는 승강 시작 안 함
    runAll(m, 1);
    expect(m.phase).toBe('closing');
    expect(m.palletY).toBe(0);
    runAll(m, 3);
    expect(m.phase).toBe('toBay');
    runAll(m, storeDuration('B1') + 0.5);
    expect(m.phase).toBe('stored');
    expect(m.palletY).toBe(6);
    expect(m.palletZ).toBeCloseTo(3.6, 3);
    // 저장 중 차량 상대 위치 고정
    const lp = lockedPose(m)!;
    expect(lp.y).toBe(6);
    expect(requestRetrieve(m)).toBe(true);
    runAll(m, storeDuration('B1') + 4);
    expect(m.phase).toBe('exit');
    expect(m.palletY).toBe(0);
    expect(m.palletZ).toBeCloseTo(0, 3);
    expect(m.door).toBe(1);
    releaseVehicle(m);
    expect(m.locked).toBe(false);
    expect(m.cycles).toBe(1);
  });
  it('차량-팔레트 상대 위치는 승강 내내 불변', () => {
    const m = newMachine();
    const s = ideal(sedan, 0.03, 0.01);
    toggleOccupant(s, m);
    startStore(sedan, s, m, 'A2');
    let first: { dx: number; dz: number } | null = null;
    for (let i = 0; i < 60 * 14; i++) {
      stepMachine(m, 1 / 60, true);
      const lp = lockedPose(m)!;
      const d = { dx: lp.x - STATION.palletX, dz: lp.z - m.palletZ };
      if (!first) first = d;
      expect(d.dx).toBeCloseTo(first.dx, 6);
      expect(d.dz).toBeCloseTo(first.dz, 6);
    }
  });
  it('문 안전센서: 문 구역에 물체가 있으면 닫히지 않고 승강 시작 안 함', () => {
    const m = newMachine();
    const s = ideal();
    toggleOccupant(s, m);
    startStore(sedan, s, m, 'A1');
    m.door = 0.8;
    for (let i = 0; i < 60 * 5; i++) stepMachine(m, 1 / 60, false);
    expect(m.door).toBe(1);
    expect(m.phase).toBe('closing');
    expect(m.palletY).toBe(0);
    runAll(m, 4, true);
    expect(m.phase).toBe('toBay');
  });
  it('비상 정지: 멈춘 동안 팔레트가 움직이지 않고 해제 후 재개', () => {
    const m = newMachine();
    const s = ideal();
    toggleOccupant(s, m);
    startStore(sedan, s, m, 'A1');
    runAll(m, 3 + 2);
    emergencyStop(m);
    const y = m.palletY;
    runAll(m, 3);
    expect(m.palletY).toBe(y);
    expect(m.phase).toBe('estop');
    emergencyRelease(m);
    runAll(m, 10);
    expect(m.phase).toBe('stored');
  });
  it('반복 사이클 5회 후에도 상태 정상', () => {
    const m = newMachine();
    for (let n = 0; n < 5; n++) {
      const s = ideal();
      toggleOccupant(s, m);
      expect(startStore(sedan, s, m, n % 2 ? 'A2' : 'B1')).toBe(true);
      runAll(m, 40);
      expect(m.phase).toBe('stored');
      requestRetrieve(m);
      runAll(m, 40);
      expect(m.phase).toBe('exit');
      releaseVehicle(m);
      m.phase = 'waiting';
    }
    expect(m.cycles).toBe(5);
  });
  it('허용 오차 상수 합리성', () => {
    expect(ALIGN_TOL.lateral).toBeLessThan(0.2);
  });
});

import { MechController } from '../src/mech/controller';
import { createVehicleState } from '../src/vehicle/physics';

describe('기계식 주차 — 컨트롤러', () => {
  it('출고 미션 시작(저장 상태)의 차량 위치는 베이 A1 위 (회귀: 상대 좌표 회전 버그)', () => {
    const c = new MechController();
    const car = createVehicleState(sedan, -3.4, 0, STATION.heading);
    c.presetStored(sedan, car);
    expect(car.z).toBeCloseTo(3.6, 3);
    expect(car.y).toBeCloseTo(3, 3);
    expect(car.x).toBeCloseTo(STATION.stopperX - sedan.wheelbase, 3);
    // 출고 → 팔레트가 스테이션 높이/중앙으로 돌아오면 차량도 정중앙
    c.onAction('mechRetrieve', sedan, car);
    for (let i = 0; i < 60 * 40; i++) c.step(1 / 60, sedan, car);
    expect(c.m.phase).toBe('exit');
    expect(car.z).toBeCloseTo(0, 3);
    expect(car.y).toBeCloseTo(0, 3);
  });
  it('정지턱: 컨트롤러가 앞바퀴를 되밀고 속도 0', () => {
    const c = new MechController();
    const car = createVehicleState(sedan, 0, 0, STATION.heading);
    car.x = STATION.stopperX - sedan.wheelbase + 0.4; // 뒷축 기준
    car.z = 0;
    car.v = 1;
    expect(c.stopper(sedan, car)).toBeGreaterThan(0.3);
    expect(car.v).toBe(0);
    expect(stopperPushback(sedan, { x: car.x, z: car.z, heading: car.heading, v: 0, gear: 'P', handbrake: true })).toBeLessThan(0.01);
  });
  it('입고 중에는 주행 입력을 막고 하차 상태에서도 막는다', () => {
    const c = new MechController();
    expect(c.blocksDriving()).toBe(false);
    c.m.occupant = 'out';
    expect(c.blocksDriving()).toBe(true);
  });
});
