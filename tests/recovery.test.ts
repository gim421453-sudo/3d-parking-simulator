import { describe, expect, it } from 'vitest';
import { FLOOR_H, SLOT_Z, emergencyStop, newMachine, requestRetrieve, stepMachine, type MachineState, type StoredCar } from '../src/mech/machine';
import { carIdsOf, enterManual, finishRecovery, manualCommand, recoveryCheck, type ManualCmd } from '../src/mech/recovery';

const car = (id: number): StoredCar => ({ carId: id, specId: 'sedan', mode: 'fwd', rel: { x: 0.1, z: 0, heading: 0 }, since: 0 });
const run = (m: MachineState, sec: number, doorClear = true): void => {
  for (let t = 0; t < sec; t += 1 / 60) stepMachine(m, 1 / 60, doorClear);
};
const cmd = (m: MachineState, c: ManualCmd, doorClear = true) => manualCommand(m, c, doorClear);
/** 수동 명령을 내고 동작이 끝날 때까지 진행 */
const go = (m: MachineState, c: ManualCmd, sec = 20): ReturnType<typeof manualCommand> => {
  const r = cmd(m, c);
  run(m, sec);
  return r;
};

describe('기계식 비상 수동복구 (v0.6.1)', () => {
  it('비상정지 없이 수동복구로 들어갈 수 없다(명시적 단계), 수동복구 중에는 비상정지 해제(재개)가 아니다', () => {
    const m = newMachine(12);
    expect(enterManual(m).ok).toBe(false);
    m.phase = 'lifting';
    m.op = { kind: 'store', slot: '05A' };
    emergencyStop(m);
    expect(m.phase).toBe('estop');
    run(m, 2);
    expect(m.carriage.y).toBe(0); // 비상정지 중 정지
    expect(enterManual(m).ok).toBe(true);
    expect(m.phase).toBe('manual');
  });

  it('출고 상승 중 비상정지 → 수동: 셔터는 닫힌 채 1층 복귀·차량은 캐리지에 그대로 → 출차 대기로 복구, 보관 차량 ID 유지, 새 차량 없음', () => {
    const m = newMachine(12);
    m.slots['08A'] = car(7);
    m.slots['03B'] = car(9);
    m.nextCarId = 10;
    expect(requestRetrieve(m, '08A')).toBe(true);
    // 캐리지가 슬롯에서 팔레트를 인출해 내려오는 중간까지 진행
    for (let i = 0; i < 60 * 60 && !(m.phase === 'lowering' && m.carriage.y < 10); i++) stepMachine(m, 1 / 60, true);
    expect(m.phase).toBe('lowering');
    emergencyStop(m);
    enterManual(m);
    const ids0 = carIdsOf(m);
    expect(ids0).toEqual([7, 9]);
    // 인터록: 차량이 실린 채 셔터가 닫혀 있으니 하강 가능, 셔터가 열려 있으면 거부
    expect(go(m, 'home').ok).toBe(true);
    expect(m.carriage.y).toBe(0);
    expect(recoveryCheck(m).map((q) => q.code)).toContain('E-40'); // 셔터 미개방
    expect(go(m, 'doorOpen').ok).toBe(true);
    expect(m.door).toBe(1);
    const r = finishRecovery(m);
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect(m.phase).toBe('exit');
    expect(m.carrying!.carId).toBe(7);
    expect(m.slots['03B']!.carId).toBe(9);
    expect(m.nextCarId).toBe(10); // 새 차량 ID 발급 없음
  });

  it('입고 수평 이송 중 비상정지 → 수동: 그 슬롯에 팔레트 안치 → 중앙 → 1층 → 빈 팔레트 공급 → 셔터 개방 → 정상 대기', () => {
    const m = newMachine(6);
    m.phase = 'storing';
    m.op = { kind: 'store', slot: '04B' };
    m.carriage.y = 3 * FLOOR_H;
    m.carriage.z = -SLOT_Z * 0.4;
    m.palletLoc = 'carriage';
    m.carOnPallet = true;
    m.locked = true;
    m.occupant = 'out';
    m.rel = { x: 0.2, z: 0, heading: 0 };
    m.door = 0;
    emergencyStop(m);
    enterManual(m);
    // 이송 중간에서는 안치 불가(슬롯 앞 정지 필요)
    expect(cmd(m, 'palletToSlot').ok).toBe(false);
    expect(cmd(m, 'liftDown').ok).toBe(false); // 수평 중앙이 아니면 승강 거부
    expect(go(m, 'shiftB').ok).toBe(true);
    expect(m.carriage.z).toBe(-SLOT_Z);
    const r = cmd(m, 'palletToSlot');
    expect(r.ok, r.reason).toBe(true);
    expect(m.slots['04B']).not.toBeNull();
    const newId = m.slots['04B']!.carId;
    expect(m.events.some((e) => e.type === 'stored' && e.slot === '04B')).toBe(true);
    go(m, 'center');
    go(m, 'home', 30);
    expect(go(m, 'palletSupply').ok).toBe(true);
    go(m, 'doorOpen');
    const f = finishRecovery(m);
    expect(f.ok, JSON.stringify(f.issues)).toBe(true);
    expect(m.phase).toBe('waiting');
    expect(m.palletLoc).toBe('station');
    expect(carIdsOf(m)).toEqual([newId]);
  });

  it('셔터: 문 구역에 차량이 있으면 닫기 거부, 긴급 개방은 보통 개방보다 두 배 빠르다', () => {
    const m = newMachine(4);
    m.phase = 'closing';
    m.door = 0.5;
    emergencyStop(m);
    enterManual(m);
    expect(cmd(m, 'doorClose', false).ok).toBe(false);
    cmd(m, 'doorEmergency');
    run(m, 0.6);
    const fast = m.door;
    const m2 = newMachine(4);
    m2.phase = 'closing';
    m2.door = 0.5;
    emergencyStop(m2);
    enterManual(m2);
    cmd(m2, 'doorOpen');
    run(m2, 0.6);
    expect(fast - 0.5).toBeGreaterThan((m2.door - 0.5) * 1.8);
  });

  it('슬롯 인출/안치: 실린 팔레트로 이미 찬 슬롯 쪽 이송 거부, 빈 캐리지로 인출하면 같은 차량 ID 를 싣고 picked 이벤트', () => {
    const m = newMachine(12);
    m.slots['06A'] = car(3);
    m.slots['06B'] = car(4);
    m.phase = 'calling';
    m.op = { kind: 'retrieve', slot: '06A' };
    m.palletLoc = 'none';
    m.door = 0;
    emergencyStop(m);
    enterManual(m);
    go(m, 'liftUp');
    go(m, 'liftUp');
    go(m, 'liftUp');
    go(m, 'liftUp');
    go(m, 'liftUp');
    expect(m.carriage.y).toBeCloseTo(5 * FLOOR_H, 9); // 6F
    go(m, 'shiftA');
    expect(cmd(m, 'palletFromSlot').ok).toBe(true);
    expect(m.carrying!.carId).toBe(3);
    expect(m.events.some((e) => e.type === 'picked' && e.carId === 3)).toBe(true);
    go(m, 'center');
    // 실린 팔레트(차량 3)를 이미 찬 06B 쪽으로는 이송 불가
    expect(cmd(m, 'shiftB').ok).toBe(false);
    // 원래 슬롯(06A)으로 되돌려 안치 → ID 그대로
    go(m, 'shiftA');
    expect(cmd(m, 'palletToSlot').ok).toBe(true);
    expect(m.slots['06A']!.carId).toBe(3);
    expect(carIdsOf(m)).toEqual([3, 4]);
  });

  it('턴테이블: 1층 중앙·셔터 닫힘에서만 회전, 초기 방향 복귀', () => {
    const m = newMachine(4);
    m.phase = 'rotating';
    m.door = 0;
    m.yaw = 1.2;
    m.carOnPallet = true;
    m.locked = true;
    m.occupant = 'out';
    m.carrying = car(1);
    m.palletLoc = 'carriage';
    m.rel = { x: 0, z: 0, heading: 0 };
    emergencyStop(m);
    enterManual(m);
    expect(recoveryCheck(m).map((q) => q.code)).toContain('E-30');
    go(m, 'turnHome', 10);
    expect(m.yaw).toBe(0);
    go(m, 'turnLeft', 10);
    expect(m.yaw).toBeCloseTo(Math.PI, 9);
  });

  it('불변식: 차량 정보가 바뀌면(삭제/중복) 복구 완료를 거부한다', () => {
    const m = newMachine(4);
    m.slots['02A'] = car(5);
    m.phase = 'lifting';
    emergencyStop(m);
    enterManual(m);
    m.slots['02A'] = null; // 비정상 삭제
    expect(recoveryCheck(m).map((q) => q.code)).toContain('E-50');
    expect(finishRecovery(m).ok).toBe(false);
    expect(m.phase).toBe('manual');
  });

  it('여러 시설 독립: 한 시설 수동복구가 다른 시설 상태를 바꾸지 않는다', () => {
    const a = newMachine(12);
    const b = newMachine(6);
    b.slots['05A'] = car(11);
    a.phase = 'lifting';
    emergencyStop(a);
    enterManual(a);
    go(a, 'doorEmergency');
    run(b, 5);
    expect(b.phase).toBe('waiting');
    expect(b.slots['05A']!.carId).toBe(11);
    expect(b.door).toBe(1);
  });
});
