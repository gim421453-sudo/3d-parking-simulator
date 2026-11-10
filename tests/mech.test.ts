import { describe, expect, it } from 'vitest';
import { DEG, worldToLocal } from '../src/core/math';
import { MechController } from '../src/mech/controller';
import { MECH_LIMITS, checkVehicleLimits } from '../src/mech/limits';
import {
  ALIGN_TOL,
  BUMP,
  FLOOR_H,
  POCKET,
  SLOTS,
  STATION,
  TIMES,
  alignment,
  bumpDecel,
  cancelOp,
  emergencyRelease,
  emergencyStop,
  floorY,
  freeSlots,
  guidance,
  liftTime,
  lockedPose,
  newMachine,
  pocketDepthAt,
  releaseVehicle,
  requestRetrieve,
  resetToWaiting,
  startStore,
  statusBoard,
  stepMachine,
  storedPose,
  toggleOccupant,
  type AlignInput,
  type MachineState,
} from '../src/mech/machine';
import { createVehicleState } from '../src/vehicle/physics';
import { SELECTABLE_VEHICLES, VEHICLES, getVehicle } from '../src/vehicle/spec';

const sedan = VEHICLES[1];
/** 팔레트 위 정위치 자세(뒷축 기준). fwd: 앞차축이 정지 위치, rev: 뒷차축이 정지 위치(차량은 -x 를 향함) */
function ideal(spec = sedan, mode: 'fwd' | 'rev' = 'fwd', dz = 0, dh = 0): AlignInput {
  const rearX = mode === 'fwd' ? STATION.stopperX - spec.wheelbase : STATION.stopperX;
  return { x: rearX, z: dz, heading: (mode === 'fwd' ? STATION.heading : STATION.heading + Math.PI) + dh, v: 0, gear: 'P', handbrake: true };
}
const run = (m: MachineState, secs: number, clear = true): void => {
  for (let i = 0; i < secs * 60; i++) stepMachine(m, 1 / 60, clear);
};
const until = (m: MachineState, pred: () => boolean, maxSecs = 400): number => {
  let t = 0;
  while (!pred() && t < maxSecs) {
    stepMachine(m, 1 / 60, true);
    t += 1 / 60;
  }
  return t;
};
function parkOn(m: MachineState, mode: 'fwd' | 'rev', slot: string, spec = sedan): boolean {
  const s = ideal(spec, mode);
  m.occupant = 'in'; // 새 차량이 도착해 운전자가 내리는 상황
  toggleOccupant(s, m);
  return startStore(spec, s, m, slot);
}

describe('기계식 주차 — 치수 제한', () => {
  it('일반 승용/세단 허용', () => expect(checkVehicleLimits(sedan).ok).toBe(true));
  it('차폭 초과(컨셉 쿠페 2.34m) 거부', () => {
    const r = checkVehicleLimits(getVehicle('concept-coupe'));
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('차폭');
  });
  it('차고 초과 거부', () => expect(checkVehicleLimits({ ...sedan, height: 1.62 }).height).toBe(false));
  it('법정 최소 치수 상수', () => {
    expect(MECH_LIMITS.doorWidth).toBeGreaterThanOrEqual(2.4);
    expect(MECH_LIMITS.doorHeight).toBeGreaterThanOrEqual(1.9);
    expect(MECH_LIMITS.palletWidth).toBeGreaterThanOrEqual(2.15);
  });
  it('허용 차량 판정이 일관', () => {
    for (const v of SELECTABLE_VEHICLES) expect(checkVehicleLimits(v).ok).toBe(checkVehicleLimits(v).reasons.length === 0);
  });
});

describe('12층 타워 구조/슬롯', () => {
  it('2F~12F × A/B = 22개 슬롯, 층고 3m, 12F 높이 33m', () => {
    expect(SLOTS.length).toBe(22);
    expect(Math.min(...SLOTS.map((s) => s.floor))).toBe(2);
    expect(Math.max(...SLOTS.map((s) => s.floor))).toBe(12);
    expect(FLOOR_H).toBe(3);
    expect(floorY(12)).toBe(33);
    expect(new Set(SLOTS.map((s) => s.id)).size).toBe(22);
    expect(SLOTS.find((s) => s.id === '08B')).toMatchObject({ floor: 8, side: 'B', y: 21 });
  });
  it('슬롯 위치는 팔레트 중심선(z=0)에서 ±3.6m 로 이송 (중앙을 점유하지 않는다)', () => {
    for (const s of SLOTS) expect(Math.abs(s.z)).toBeCloseTo(3.6, 6);
  });
});

describe('정렬 판정 — 전진/후진 입고 분리', () => {
  it('전진 정위치: 모든 조건 통과, 앞차축 기준', () => {
    const a = alignment(sedan, ideal(sedan, 'fwd'));
    expect(a.mode).toBe('fwd');
    expect(Math.abs(a.lateral)).toBeLessThan(0.01);
    expect(a.wheelsInGrooves && a.atStopper && a.onPallet).toBe(true);
    expect(a.guideInvasion.some(Boolean)).toBe(false);
  });
  it('후진 정위치: 모든 조건 통과, 뒷차축 기준 (같은 정지 위치)', () => {
    const a = alignment(sedan, ideal(sedan, 'rev'));
    expect(a.mode).toBe('rev');
    expect(a.wheelsInGrooves && a.atStopper && a.onPallet).toBe(true);
    expect(a.headingErrDeg).toBeLessThan(0.01);
  });
  it('전진 자세에서 후진 입고용 위치(뒷차축이 정지 위치)는 불합격 — 같은 판정을 재사용하지 않는다', () => {
    const s = ideal(sedan, 'fwd');
    s.x = STATION.stopperX; // 뒷차축을 정지 위치에 둠 → 앞차축은 2.75m 앞 (정지 위치 한참 넘음)
    expect(alignment(sedan, s).atStopper).toBe(false);
    expect(alignment(sedan, s).stopperGap).toBeLessThan(-2);
  });
  it('좌우로 크게 치우치면 가이드 침범 (양쪽 모드)', () => {
    for (const mode of ['fwd', 'rev'] as const) {
      const a = alignment(sedan, ideal(sedan, mode, 0.3));
      expect(a.guideInvasion.some(Boolean), mode).toBe(true);
      expect(a.wheelsInGrooves, mode).toBe(false);
    }
  });
  it('차폭/축거가 다른 모든 허용 차량이 양쪽 모드에서 정위치 판정 가능', () => {
    for (const v of VEHICLES.filter((q) => checkVehicleLimits(q).ok)) {
      for (const mode of ['fwd', 'rev'] as const) {
        const a = alignment(v, ideal(v, mode));
        expect(a.atStopper && a.onPallet && a.wheelsInGrooves, `${v.id}/${mode}`).toBe(true);
      }
    }
  });
});

describe('낮은 정지턱 — 타고 넘는 약한 저항(차량을 멈추지 않는다)', () => {
  it('턱 위에서만 작은 감속(0.25m/s²), 멀면 0', () => {
    expect(bumpDecel(sedan, ideal(sedan, 'fwd'))).toBe(BUMP.decel);
    const far = ideal(sedan, 'fwd');
    far.x -= 1.5;
    expect(bumpDecel(sedan, far)).toBe(0);
  });
  it('저속(0.6m/s)으로 정지 위치를 지나쳐도 속도가 0 이 되지 않고 통과한다 (전진/후진 모두)', () => {
    for (const mode of ['fwd', 'rev'] as const) {
      const c = new MechController();
      const car = createVehicleState(sedan, 0, 0, 0);
      car.heading = mode === 'fwd' ? STATION.heading : STATION.heading + Math.PI;
      car.z = 0;
      car.x = ideal(sedan, mode).x - 0.8;
      car.v = 0.6;
      let minV = 9;
      for (let i = 0; i < 60 * 6; i++) {
        const dir = mode === 'fwd' ? 1 : -1; // 속도 v 의 부호: 전진이면 +, 후진이면 −
        c.bump(sedan, car, 1 / 120);
        car.x += Math.sin(car.heading) * car.v * (1 / 120) * (mode === 'fwd' ? 1 : 1);
        minV = Math.min(minV, Math.abs(car.v));
        void dir;
        if (car.x > ideal(sedan, mode).x + 0.8) break;
      }
      expect(minV, mode).toBeGreaterThan(0.25);
    }
  });
  it('저항 때문에 정지 위치에서 속도 0 으로 고정되지 않는다 (밀어내기 없음)', () => {
    const c = new MechController();
    const car = createVehicleState(sedan, 0, 0, STATION.heading);
    car.x = ideal(sedan, 'fwd').x + 0.4;
    car.z = 0;
    car.v = 0.5;
    c.bump(sedan, car, 1 / 60);
    expect(car.v).toBeGreaterThan(0.4);
    expect(car.x).toBeCloseTo(ideal(sedan, 'fwd').x + 0.4, 9);
  });
});

describe('입구 표시기(전진/정지/후진) — 실제 위치/진행 방향 기반', () => {
  const g = (rearX: number, mode: 'fwd' | 'rev', z = 0, dh = 0, mod?: (m: MachineState) => void) => {
    const m = newMachine();
    mod?.(m);
    const base = ideal(sedan, mode, z, dh);
    return guidance(sedan, { ...base, x: rearX }, m);
  };
  const fwdStop = ideal(sedan, 'fwd').x;
  const revStop = ideal(sedan, 'rev').x;
  it('전진 입고: 멀면 전진, 정위치 정지, 지나치면 후진', () => {
    expect(g(fwdStop - 6, 'fwd').state).toBe('forward');
    expect(g(fwdStop, 'fwd').state).toBe('stop');
    expect(g(fwdStop + 0.45, 'fwd').state).toBe('back');
  });
  it('후진 입고: 멀면 후진(계속 후진), 정위치 정지, 지나치면 전진', () => {
    expect(g(revStop - 6, 'rev').state).toBe('back');
    expect(g(revStop, 'rev').state).toBe('stop');
    expect(g(revStop + 0.45, 'rev').state).toBe('forward');
  });
  it('정렬 경고: 좌우 힌트가 전진/후진 입고에서 반대로 뒤집힌다', () => {
    expect(g(fwdStop - 1.5, 'fwd', 0.3).steer).toBe('left');
    expect(g(fwdStop - 1.5, 'fwd', -0.3).steer).toBe('right');
    expect(g(revStop - 1.5, 'rev', 0.3).steer).toBe('right');
    expect(g(revStop - 1.5, 'rev', -0.3).steer).toBe('left');
    expect(g(fwdStop - 1.5, 'fwd', 0, 6 * DEG).state).toBe('align');
  });
  it('문이 닫혔거나 장치가 대기 상태가 아니면 진입 금지', () => {
    expect(g(fwdStop - 5, 'fwd', 0, 0, (m) => (m.door = 0)).state).toBe('blocked');
    expect(g(fwdStop - 5, 'fwd', 0, 0, (m) => (m.phase = 'lifting')).state).toBe('blocked');
    expect(g(fwdStop - 5, 'fwd', 0, 0, (m) => (m.palletLoc = 'none')).state).toBe('blocked');
  });
  it('시간이 지나도 상태가 바뀌지 않는다', () => {
    const m = newMachine();
    const s = { ...ideal(sedan, 'fwd'), x: fwdStop - 6 };
    const a = guidance(sedan, s, m).state;
    run(m, 10);
    expect(guidance(sedan, s, m).state).toBe(a);
  });
});

describe('입고 거부 조건', () => {
  it('하차하지 않으면 거부', () => {
    const m = newMachine();
    expect(startStore(sedan, ideal(), m, '02A')).toBe(false);
    expect(m.message).toContain('운전자 하차');
  });
  it('P/브레이크 없이는 하차 불가', () => {
    const s = ideal();
    s.gear = 'D';
    expect(toggleOccupant(s, newMachine()).ok).toBe(false);
  });
  it('중앙/방향 불량이면 거부', () => {
    const m = newMachine();
    toggleOccupant(ideal(), m);
    expect(startStore(sedan, ideal(sedan, 'fwd', 0.2), m, '02A')).toBe(false);
    expect(startStore(sedan, ideal(sedan, 'fwd', 0, 6 * DEG), m, '02A')).toBe(false);
  });
  it('폭 초과 차량 거부', () => {
    const m = newMachine();
    const c = getVehicle('concept-coupe');
    toggleOccupant(ideal(c), m);
    expect(startStore(c, ideal(c), m, '02A')).toBe(false);
    expect(m.message).toContain('차폭');
    expect(m.phase).toBe('waiting');
  });
  it('알 수 없는 슬롯/점유 슬롯 거부, 빈 슬롯 안내', () => {
    const m = newMachine();
    expect(parkOn(m, 'fwd', 'ZZ')).toBe(false);
    expect(parkOn(m, 'fwd', '02A')).toBe(true);
    run(m, 400);
    expect(m.slots['02A']).not.toBeNull();
    // 다시 입고: 같은 슬롯 → 거부
    expect(parkOn(m, 'fwd', '02A')).toBe(false);
    expect(m.message).toContain('이미 사용 중');
    expect(m.slots['02A']!.mode).toBe('fwd');
  });
});

describe('입고 → 보관 → 플랫폼 복귀 (전진/후진, 여러 층)', () => {
  for (const mode of ['fwd', 'rev'] as const) {
    for (const slot of ['02A', '05B', '08A', '10B', '12A']) {
      it(`${mode} 입고 → ${slot}: 실제 승강(높이 변화), 차량-팔레트 상대 고정, 보관, 빈 캐리지 1F 복귀`, () => {
        const m = newMachine();
        const sd = SLOTS.find((s) => s.id === slot)!;
        expect(parkOn(m, mode, slot)).toBe(true);
        const rel0 = { ...m.rel! };
        let maxY = 0;
        let doorWhileLifting = 0;
        let steps = 0;
        let seenStored = false;
        let carriageReturned = false;
        while (steps < 60 * 300) {
          stepMachine(m, 1 / 60, true);
          steps++;
          maxY = Math.max(maxY, m.carriage.y);
          if (m.phase === 'lifting' || m.phase === 'storing') {
            doorWhileLifting = Math.max(doorWhileLifting, m.door);
            const lp = lockedPose(m)!;
            const l = worldToLocal(STATION.palletX, m.carriage.z, STATION.heading + m.yaw, lp.x, lp.z);
            expect(l.x).toBeCloseTo(rel0.x, 6);
            expect(l.z).toBeCloseTo(rel0.z, 6);
            expect(lp.y).toBeCloseTo(m.carriage.y, 9);
          }
          if (m.slots[slot]) seenStored = true;
          if (seenStored && m.carriage.y === 0 && m.carriage.z === 0 && m.palletLoc === 'station') carriageReturned = true;
          if (m.phase === 'waiting' && seenStored) break;
        }
        expect(seenStored).toBe(true);
        expect(maxY).toBeCloseTo(sd.y, 6); // 실제로 해당 층 높이까지 올라갔다
        expect(doorWhileLifting).toBe(0); // 승강 중 셔터 닫힘 유지
        expect(carriageReturned).toBe(true); // 빈 캐리지가 1F 로 복귀하고 새 팔레트 공급
        expect(m.phase).toBe('waiting');
        expect(m.slots[slot]!.mode).toBe(mode);
        const e = m.events.filter((q) => q.type === 'stored');
        expect(e.length).toBe(1);
        const sp = storedPose(slot, m.slots[slot]!);
        expect(sp.y).toBe(sd.y);
        expect(Math.abs(sp.z)).toBeGreaterThan(2.5);
      });
    }
  }
  it('입고 완료 후 다음 입고가 바로 가능 (캐리지 복귀, 승강장 새 팔레트, 문 열림)', () => {
    const m = newMachine();
    expect(parkOn(m, 'fwd', '03A')).toBe(true);
    until(m, () => m.phase === 'waiting' && !!m.slots['03A']);
    expect(m.palletLoc).toBe('station');
    expect(m.door).toBe(1);
    expect(m.carOnPallet).toBe(false);
    expect(m.occupant).toBe('in');
    expect(parkOn(m, 'rev', '04B')).toBe(true);
    until(m, () => m.phase === 'waiting' && !!m.slots['04B']);
    expect(Object.values(m.slots).filter(Boolean).length).toBe(2);
    expect(m.slots['03A']!.carId).not.toBe(m.slots['04B']!.carId);
  });
  it('연속 3대 입고: 서로 다른 슬롯/차량 ID, 중복 점유 없음, 빈 슬롯 수 감소', () => {
    const m = newMachine();
    for (const [mode, slot] of [['fwd', '02A'], ['rev', '07B'], ['fwd', '12A']] as const) {
      expect(parkOn(m, mode, slot)).toBe(true);
      until(m, () => m.phase === 'waiting' && !!m.slots[slot]);
    }
    expect(freeSlots(m).length).toBe(19);
    const ids = Object.values(m.slots).filter(Boolean).map((q) => q!.carId);
    expect(new Set(ids).size).toBe(3);
  });
  it('작동 중 새 입고/출고 요청은 거부되고 상태를 덮어쓰지 않는다', () => {
    const m = newMachine();
    expect(parkOn(m, 'fwd', '06A')).toBe(true);
    run(m, 6);
    const snap = JSON.stringify([m.phase, m.op]);
    expect(startStore(sedan, ideal(), m, '06B')).toBe(false);
    expect(requestRetrieve(m, '06A')).toBe(false);
    expect(JSON.stringify([m.phase, m.op])).toBe(snap);
  });
});

describe('출고 — 전진 입고 차량은 회전, 후진 입고 차량은 회전 없음', () => {
  const storeThenRetrieve = (mode: 'fwd' | 'rev', slot: string) => {
    const m = newMachine();
    parkOn(m, mode, slot);
    until(m, () => m.phase === 'waiting' && !!m.slots[slot]);
    m.occupant = 'in';
    expect(requestRetrieve(m, slot)).toBe(true);
    const phases = new Set<string>();
    let maxY = 0;
    let t = 0;
    while (m.phase !== 'exit' && t < 400) {
      stepMachine(m, 1 / 60, true);
      phases.add(m.phase);
      maxY = Math.max(maxY, m.carriage.y);
      t += 1 / 60;
    }
    return { m, phases, maxY };
  };
  it('전진 입고(08A): 호출 → 인출 → 하강 → 180° 회전 → 문 열림, 차량이 문(−x)을 향함', () => {
    const { m, phases, maxY } = storeThenRetrieve('fwd', '08A');
    expect(m.phase).toBe('exit');
    expect(phases.has('calling') && phases.has('pulling') && phases.has('lowering') && phases.has('rotating')).toBe(true);
    expect(maxY).toBeCloseTo(21, 6);
    expect(m.yaw).toBeCloseTo(Math.PI, 5);
    expect(m.slots['08A']).toBeNull();
    const p = lockedPose(m)!;
    expect(Math.sin(p.heading)).toBeLessThan(-0.99);
    expect(p.y).toBe(0);
    expect(m.door).toBe(1);
  });
  it('후진 입고(12B): 회전 단계 없이 출고, 차량은 이미 문을 향함 (중복 회전 금지)', () => {
    const { m, phases, maxY } = storeThenRetrieve('rev', '12B');
    expect(phases.has('rotating')).toBe(false);
    expect(m.yaw).toBe(0);
    expect(maxY).toBeCloseTo(33, 6);
    const p = lockedPose(m)!;
    expect(Math.sin(p.heading)).toBeLessThan(-0.99);
    expect(p.y).toBe(0);
  });
  it('다른 차량 호출: 먼저 입고한 차량이 아닌 나중 차량을 호출해도 해당 차량만 나온다', () => {
    const m = newMachine();
    parkOn(m, 'fwd', '02A');
    until(m, () => m.phase === 'waiting' && !!m.slots['02A']);
    parkOn(m, 'rev', '09B');
    until(m, () => m.phase === 'waiting' && !!m.slots['09B']);
    const idB = m.slots['09B']!.carId;
    m.occupant = 'in';
    requestRetrieve(m, '09B');
    until(m, () => m.phase === 'exit');
    expect(m.carrying!.carId).toBe(idB);
    expect(m.slots['09B']).toBeNull();
    expect(m.slots['02A']).not.toBeNull();
  });
  it('빈 슬롯/동작 중/승강장에 차량이 있으면 출고 거부', () => {
    const m = newMachine();
    expect(requestRetrieve(m, '05A')).toBe(false);
    expect(m.message).toContain('보관된 차량이 없습니다');
    m.slots['05A'] = { carId: 9, specId: 'sedan', mode: 'fwd', rel: { x: 0, z: 0, heading: 0 }, since: 0 };
    m.carOnPallet = true;
    expect(requestRetrieve(m, '05A')).toBe(false);
    m.carOnPallet = false;
    expect(requestRetrieve(m, '05A')).toBe(true);
    expect(requestRetrieve(m, '05A')).toBe(false); // 이미 동작 중
  });
  it('출고 후 탑승·출차하면 팔레트가 승강장에 남아 다음 입고 가능', () => {
    const { m } = storeThenRetrieve('fwd', '04A');
    releaseVehicle(m);
    resetToWaiting(m);
    expect(m.palletLoc).toBe('station');
    expect(m.locked).toBe(false);
    expect(m.phase).toBe('waiting');
  });
});

describe('인터록/비상정지/취소', () => {
  it('문 안전센서: 문 구역에 물체가 있으면 닫히지 않고 승강 시작 안 함', () => {
    const m = newMachine();
    parkOn(m, 'fwd', '02A');
    m.door = 0.8;
    run(m, 5, false);
    expect(m.door).toBe(1);
    expect(m.phase).toBe('closing');
    expect(m.carriage.y).toBe(0);
    until(m, () => m.phase === 'lifting');
    expect(m.door).toBe(0);
  });
  it('비상 정지: 승강 중 멈추고(높이 유지) 해제 후 재개, 보관 완료', () => {
    const m = newMachine();
    parkOn(m, 'fwd', '06A');
    until(m, () => m.carriage.y > 6);
    emergencyStop(m);
    const y = m.carriage.y;
    run(m, 4);
    expect(m.carriage.y).toBe(y);
    expect(m.phase).toBe('estop');
    expect(statusBoard(m).kind).toBe('estop');
    emergencyRelease(m);
    until(m, () => !!m.slots['06A']);
    expect(m.slots['06A']).not.toBeNull();
  });
  it('회전 중 비상정지/해제', () => {
    const m = newMachine();
    parkOn(m, 'fwd', '03B');
    until(m, () => m.phase === 'waiting' && !!m.slots['03B']);
    m.occupant = 'in';
    requestRetrieve(m, '03B');
    until(m, () => m.phase === 'rotating' && m.yaw > 0.5);
    emergencyStop(m);
    const yaw = m.yaw;
    run(m, 3);
    expect(m.yaw).toBe(yaw);
    emergencyRelease(m);
    until(m, () => m.phase === 'exit');
    expect(m.yaw).toBeCloseTo(Math.PI, 5);
  });
  it('회전은 문이 닫히고 하차 상태에서만', () => {
    const m = newMachine();
    m.phase = 'rotating';
    m.locked = true;
    m.occupant = 'in';
    m.door = 0;
    run(m, 6);
    expect(m.yaw).toBe(0);
    m.occupant = 'out';
    m.door = 0.5;
    run(m, 6);
    expect(m.yaw).toBe(0);
    m.door = 0;
    run(m, TIMES.rotate + 0.5);
    expect(m.yaw).toBeCloseTo(Math.PI, 5);
  });
  it('취소: 문 닫는 중에는 가능, 승강이 시작되면 불가', () => {
    const m = newMachine();
    parkOn(m, 'fwd', '02A');
    expect(cancelOp(m)).toBe(true);
    expect(m.locked).toBe(false);
    until(m, () => m.phase === 'waiting');
    expect(m.carriage.y).toBe(0);
    parkOn(m, 'fwd', '02A');
    until(m, () => m.phase === 'lifting');
    expect(cancelOp(m)).toBe(false);
  });
  it('캐리지 이동 시간: 12F 까지 11초대', () => {
    expect(liftTime(33)).toBeCloseTo(11, 6);
    expect(liftTime(0.1)).toBe(TIMES.liftMin);
  });
});

describe('셔터 상단 상태 LED (작동 상태 전용)', () => {
  it('입고 가능/입고 중 — 08F 이동/승강 중/플랫폼 복귀 중/출고 중 — 12F 차량 호출 문구는 상태기계에서 나온다', () => {
    const m = newMachine();
    expect(statusBoard(m)).toEqual({ kind: 'ready', text: '입고 가능' });
    parkOn(m, 'fwd', '08A');
    expect(statusBoard(m).text).toBe('입고 중 — 08F 이동');
    until(m, () => m.phase === 'lifting');
    expect(statusBoard(m).text).toBe('승강 중 — 08F 이동');
    until(m, () => m.phase === 'returning');
    expect(statusBoard(m).text).toBe('플랫폼 복귀 중 — 01F');
    until(m, () => m.phase === 'waiting' && !!m.slots['08A']);
    m.occupant = 'in';
    requestRetrieve(m, '08A');
    until(m, () => m.phase === 'calling');
    expect(statusBoard(m).text).toBe('출고 중 — 08F 차량 호출');
    m.door = 0.3;
    m.phase = 'waiting';
    expect(statusBoard(m).kind).toBe('blocked');
    m.fault = '센서 이상';
    expect(statusBoard(m).kind).toBe('fault');
  });
});

describe('MechController — 안착/보관 위치/시드', () => {
  it('정지 홈 안착(전진/후진): 이벤트 1회, 침하 ≤3cm, 피치 부호(전진 −, 후진 +), 차량 위치 불변', () => {
    for (const mode of ['fwd', 'rev'] as const) {
      const c = new MechController();
      const car = createVehicleState(sedan, 0, 0, STATION.heading);
      car.heading = mode === 'fwd' ? STATION.heading : STATION.heading + Math.PI;
      car.z = 0;
      let n = 0;
      let maxDip = 0;
      let minPitch = 0;
      let maxPitch = 0;
      const x0 = ideal(sedan, mode).x - 0.6;
      for (let i = 0; i < 400; i++) {
        car.x = x0 + 0.5 * (i / 60);
        car.v = 0.5;
        if (c.settle(1 / 60, sedan, car)) n++;
        maxDip = Math.max(maxDip, c.dip);
        minPitch = Math.min(minPitch, car.pitch);
        maxPitch = Math.max(maxPitch, car.pitch);
      }
      expect(n, mode).toBe(1);
      expect(maxDip).toBeLessThanOrEqual(0.0301);
      expect(maxDip).toBeGreaterThan(0.015);
      if (mode === 'fwd') expect(minPitch).toBeLessThan(-0.005);
      else expect(maxPitch).toBeGreaterThan(0.005);
    }
  });
  it('seedStored: 출고 미션용 보관 차량은 슬롯에 놓이고 차종/방향이 기록된다', () => {
    const c = new MechController();
    c.seedStored('08A', 'sedan', 'fwd', sedan);
    c.seedStored('12B', 'sedan', 'rev', sedan);
    expect(c.m.slots['08A']!.mode).toBe('fwd');
    expect(c.m.slots['12B']!.mode).toBe('rev');
    const list = c.storedList();
    expect(list.length).toBe(2);
    expect(list.find((q) => q.slot === '12B')!.pose.y).toBe(33);
  });
  it('입고 중에는 주행 입력을 막고 하차 상태에서도 막는다', () => {
    const c = new MechController();
    expect(c.blocksDriving()).toBe(false);
    c.m.occupant = 'out';
    expect(c.blocksDriving()).toBe(true);
  });
  it('가이드 침범: 낮은 가이드를 타이어가 타고 넘으면 경고 + 약한 저항(멈추지 않음)', () => {
    const c = new MechController();
    const car = createVehicleState(sedan, 0, 0, STATION.heading);
    car.x = ideal(sedan, 'fwd').x - 0.5;
    car.z = 0.3;
    car.heading = STATION.heading;
    car.v = 1.0;
    expect(c.guideDrag(sedan, car, 1 / 60)).toBe(true);
    expect(car.v).toBeGreaterThan(0.9);
    expect(c.guideContacts).toBe(1);
  });
  it('POCKET 상수 합리성', () => {
    expect(POCKET.depth).toBeLessThanOrEqual(0.03);
    expect(pocketDepthAt(POCKET.center)).toBeCloseTo(POCKET.depth, 6);
    expect(ALIGN_TOL.lateral).toBeLessThan(0.2);
  });
});
