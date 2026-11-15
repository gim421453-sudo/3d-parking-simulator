/**
 * 기계식 주차 비상 수동복구 (v0.6.1, 순수 로직 — 게임 안 가상 설비만 조작한다).
 *
 * 운전 모드: 자동(waiting/작동 단계) → 비상정지(estop, 모든 동작 정지) → [명시적 진입] 수동복구(manual) → [복구 완료 검사 통과] 정상 대기(waiting) 또는 출차 대기(exit)
 *  - 비상정지 해제(emergencyRelease: 원래 단계로 재개)와 수동복구 진입(enterManual)은 다른 동작이다.
 *  - 수동복구 중에는 자동 입출고를 받지 않는다(startStore/requestRetrieve 는 waiting 에서만 동작).
 *
 * 물리 인터록(게임에서도 형상 관통 금지):
 *  - 승강(상하)은 수평 이송이 중앙(z=0)일 때만, 출입문이 닫혀 있을 때만
 *  - 수평 이송(A/B)은 보관층 높이(2F~)에 정확히 섰을 때만. 팔레트(+차량)를 싣고 있으면 그 슬롯이 비어 있어야 한다
 *  - 차량이 실린 상태의 승강/이송/회전은 하차(occupant out) + 고정(locked) 상태에서만
 *  - 셔터 닫기는 문 구역에 차량/물체가 없을 때만(안전센서), 긴급 개방은 언제나 가능(2배 속도)
 *  - 턴테이블 회전은 1F 중앙, 문 닫힘에서만
 * 불변식: 수동복구 진입 시점의 보관 차량 ID 집합이 그대로 유지된다(삭제·중복·새 생성 없음). 팔레트 안치/인출은 정상 입고/출고와 같은
 *         'stored'/'picked' 이벤트를 내 게임의 차량 모델 소유권 처리를 그대로 탄다.
 */
import { FLOOR_H, SLOT_Z, TIMES, floorLabel, slotIdOf, type MachineState, type StoredCar } from './machine';

export type ManualCmd =
  | 'doorOpen'
  | 'doorClose'
  | 'doorStop'
  | 'doorEmergency'
  | 'liftUp'
  | 'liftDown'
  | 'liftStop'
  | 'home'
  | 'shiftA'
  | 'shiftB'
  | 'center'
  | 'palletSupply'
  | 'palletReturnEmpty'
  | 'palletToSlot'
  | 'palletFromSlot'
  | 'palletSeat'
  | 'turnLeft'
  | 'turnRight'
  | 'turnStop'
  | 'turnHome'
  | 'stopAll';

export const MANUAL_CMDS: ManualCmd[] = ['doorOpen', 'doorClose', 'doorStop', 'doorEmergency', 'liftUp', 'liftDown', 'liftStop', 'home', 'shiftA', 'shiftB', 'center', 'palletSupply', 'palletReturnEmpty', 'palletToSlot', 'palletFromSlot', 'palletSeat', 'turnLeft', 'turnRight', 'turnStop', 'turnHome', 'stopAll'];

export interface ManualState {
  targetY: number | null;
  targetZ: number | null;
  doorDir: -1 | 0 | 1;
  doorFast: boolean;
  yawTarget: number | null;
  /** 진입 시점 차량 ID(보관 + 캐리지) — 불변식 검사용 */
  ids0: number[];
  /** 진입 시점에 캐리지/승강장 팔레트 위에 ID 없는 차량(입고 중이던 플레이어 차량)이 있었나 */
  anon0: boolean;
  /** 진입 전 단계(오류 코드/표시) */
  from: string;
  log: string[];
}

export interface RecoveryIssue {
  code: string;
  text: string;
}

const EPS = 1e-6;
export const carIdsOf = (m: MachineState): number[] =>
  [...Object.values(m.slots).filter((c): c is StoredCar => !!c).map((c) => c.carId), ...(m.carrying && m.carOnPallet ? [m.carrying.carId] : [])].sort((a, b) => a - b);
const anonOnPallet = (m: MachineState): boolean => m.carOnPallet && !m.carrying;
/** 현재 캐리지 높이가 보관층이면 그 층 번호, 아니면 null */
export const floorAt = (y: number): number | null => {
  const f = Math.round(y / FLOOR_H) + 1;
  return Math.abs((f - 1) * FLOOR_H - y) < EPS ? f : null;
};
const moving = (s: ManualState): boolean => s.targetY !== null || s.targetZ !== null || s.doorDir !== 0 || s.yawTarget !== null;

/** 비상정지 상태에서만 수동복구로 들어간다(비상정지 해제와 별개) */
export function enterManual(m: MachineState): { ok: boolean; reason: string } {
  if (m.phase !== 'estop') return { ok: false, reason: '먼저 비상정지 상태여야 수동복구로 들어갈 수 있습니다' };
  m.manual = { targetY: null, targetZ: null, doorDir: 0, doorFast: false, yawTarget: null, ids0: carIdsOf(m), anon0: anonOnPallet(m), from: m.resume ?? 'estop', log: [] };
  m.phase = 'manual';
  m.message = '비상 수동복구 모드';
  return { ok: true, reason: m.message };
}

export function manualCommand(m: MachineState, cmd: ManualCmd, doorClear: boolean): { ok: boolean; reason: string } {
  const s = m.manual;
  if (m.phase !== 'manual' || !s) return { ok: false, reason: '수동복구 모드가 아닙니다' };
  const deny = (reason: string): { ok: boolean; reason: string } => {
    m.message = `거부: ${reason}`;
    return { ok: false, reason };
  };
  const ok = (reason: string): { ok: boolean; reason: string } => {
    s.log.push(cmd);
    if (s.log.length > 30) s.log.shift();
    m.message = reason;
    return { ok: true, reason };
  };
  const carLoaded = m.carOnPallet;
  const carSafe = !carLoaded || (m.occupant === 'out' && m.locked);
  const z0 = Math.abs(m.carriage.z) < EPS;
  const y0 = Math.abs(m.carriage.y) < EPS;
  switch (cmd) {
    case 'stopAll':
      s.targetY = s.targetZ = s.yawTarget = null;
      s.doorDir = 0;
      return ok('모든 동작 정지');
    case 'doorOpen':
      s.doorDir = 1;
      s.doorFast = false;
      return ok('셔터 여는 중');
    case 'doorEmergency':
      s.doorDir = 1;
      s.doorFast = true;
      return ok('셔터 긴급 개방');
    case 'doorClose':
      if (!doorClear) return deny('문 구역에 차량/물체가 있습니다(안전센서)');
      s.doorDir = -1;
      s.doorFast = false;
      return ok('셔터 닫는 중');
    case 'doorStop':
      s.doorDir = 0;
      return ok('셔터 정지');
    case 'liftUp':
    case 'liftDown':
    case 'home': {
      if (!z0 || s.targetZ !== null) return deny('수평 이송을 중앙으로 되돌린 뒤 승강하세요');
      if (m.door > EPS) return deny('셔터를 닫은 뒤 승강하세요');
      if (!carSafe) return deny('차량이 실려 있으면 하차·고정 후 승강하세요');
      const top = (m.floors - 1) * FLOOR_H;
      const cur = s.targetY ?? m.carriage.y;
      let ty: number;
      if (cmd === 'home') ty = 0;
      else if (cmd === 'liftUp') ty = Math.min(top, (Math.floor(cur / FLOOR_H + EPS) + 1) * FLOOR_H);
      else ty = Math.max(0, (Math.ceil(cur / FLOOR_H - EPS) - 1) * FLOOR_H);
      s.targetY = ty;
      return ok(cmd === 'home' ? '1층 복귀 중' : `${floorLabel(Math.round(ty / FLOOR_H) + 1)} 로 이동`);
    }
    case 'liftStop':
      s.targetY = null;
      return ok('승강 정지');
    case 'shiftA':
    case 'shiftB': {
      const f = floorAt(m.carriage.y);
      if (s.targetY !== null || f === null || f < 2) return deny('보관층 높이에 정확히 선 뒤 수평 이송하세요');
      if (f > m.floors) return deny('이 시설에 없는 층입니다');
      if (!carSafe) return deny('차량이 실려 있으면 하차·고정 후 이송하세요');
      const id = slotIdOf(f, cmd === 'shiftA' ? 'A' : 'B');
      if (m.palletLoc === 'carriage' && m.slots[id]) return deny(`${id} 슬롯에 이미 팔레트가 있어 실은 팔레트와 부딪힙니다`);
      s.targetZ = cmd === 'shiftA' ? SLOT_Z : -SLOT_Z;
      return ok(`${id} 쪽으로 수평 이송`);
    }
    case 'center':
      s.targetZ = 0;
      return ok('수평 이송 중앙 복귀');
    case 'palletToSlot':
    case 'palletFromSlot': {
      const f = floorAt(m.carriage.y);
      const side = Math.abs(m.carriage.z - SLOT_Z) < EPS ? 'A' : Math.abs(m.carriage.z + SLOT_Z) < EPS ? 'B' : null;
      if (f === null || f < 2 || !side || moving(s)) return deny('캐리지가 슬롯 앞(보관층 + A/B 이송 끝)에 멈춰 있어야 합니다');
      const id = slotIdOf(f, side);
      if (cmd === 'palletToSlot') {
        if (m.palletLoc !== 'carriage') return deny('캐리지에 팔레트가 없습니다');
        if (m.slots[id]) return deny(`${id} 슬롯이 이미 차 있습니다`);
        if (!carSafe) return deny('하차·고정 상태가 아닙니다');
        if (m.carOnPallet) {
          // 실린 차량을 그대로(같은 ID) 슬롯에 안치. ID 가 없던 차량(입고 중이던 차)은 정상 입고와 같이 ID 를 받는다(새 차량 생성이 아님)
          const car: StoredCar = m.carrying ?? { carId: m.nextCarId++, specId: '', mode: m.entryMode, rel: { ...m.rel! }, since: m.clock };
          m.slots[id] = car;
          m.events.push({ type: 'stored', slot: id, carId: car.carId });
          if (!m.carrying) s.anon0 = false; // 그 차량은 이제 ID 를 가진다
          if (!m.carrying) s.ids0 = [...s.ids0, car.carId].sort((a, b) => a - b);
        } else {
          m.slots[id] = null; // 빈 팔레트만 안치(차량 없음)
        }
        m.palletLoc = 'none';
        m.carOnPallet = false;
        m.locked = false;
        m.rel = null;
        m.carrying = null;
        return ok(`${id} 슬롯에 팔레트 안치`);
      }
      if (m.palletLoc !== 'none') return deny('캐리지가 이미 팔레트를 싣고 있습니다');
      const car = m.slots[id];
      if (!car) return deny(`${id} 슬롯이 비어 있습니다`);
      m.carrying = car;
      m.slots[id] = null;
      m.palletLoc = 'carriage';
      m.carOnPallet = true;
      m.rel = { ...car.rel };
      m.locked = true;
      m.entryMode = car.mode;
      m.occupant = 'out';
      m.op = { kind: 'retrieve', slot: id };
      m.events.push({ type: 'picked', slot: id, carId: car.carId });
      return ok(`${id} 슬롯 팔레트 인출`);
    }
    case 'palletSupply':
      if (!y0 || !z0 || moving(s)) return deny('캐리지가 1층 중앙에 있어야 합니다');
      if (m.palletLoc !== 'none') return deny('승강장에 이미 팔레트가 있습니다');
      m.palletLoc = 'station';
      m.carOnPallet = false;
      return ok('승강장에 빈 팔레트 공급');
    case 'palletReturnEmpty':
      if (!y0 || !z0 || moving(s)) return deny('캐리지가 1층 중앙에 있어야 합니다');
      if (m.palletLoc === 'none') return deny('회수할 팔레트가 없습니다');
      if (m.carOnPallet) return deny('차량이 실린 팔레트는 회수할 수 없습니다');
      m.palletLoc = 'none';
      return ok('빈 팔레트 회수');
    case 'palletSeat':
      if (!y0 || !z0 || moving(s)) return deny('캐리지가 1층 중앙에 있어야 합니다');
      if (m.palletLoc !== 'carriage') return deny('캐리지 위 팔레트가 없습니다');
      m.palletLoc = 'station';
      return ok('팔레트를 승강장에 수동 안착');
    case 'turnLeft':
    case 'turnRight':
    case 'turnHome': {
      if (!y0 || !z0) return deny('턴테이블은 1층 중앙에서만 회전합니다');
      if (m.door > EPS) return deny('셔터를 닫은 뒤 회전하세요');
      if (!carSafe) return deny('차량이 실려 있으면 하차·고정 후 회전하세요');
      s.yawTarget = cmd === 'turnHome' ? 0 : cmd === 'turnLeft' ? Math.PI : 0;
      return ok(cmd === 'turnHome' ? '턴테이블 초기 방향 복귀' : '턴테이블 회전');
    }
    case 'turnStop':
      s.yawTarget = null;
      return ok('턴테이블 정지');
  }
}

const moveTo = (cur: number, target: number, speed: number, dt: number): number => (Math.abs(target - cur) <= speed * dt ? target : cur + Math.sign(target - cur) * speed * dt);

/** 수동복구 중 진행(stepMachine 의 manual 단계에서 호출) */
export function stepManual(m: MachineState, dt: number, doorClear: boolean): void {
  const s = m.manual;
  if (!s) return;
  if (s.targetY !== null) {
    m.carriage.y = moveTo(m.carriage.y, s.targetY, TIMES.liftSpeed * 0.5, dt); // 수동은 절반 속도
    if (m.carriage.y === s.targetY) s.targetY = null;
  }
  if (s.targetZ !== null) {
    m.carriage.z = moveTo(m.carriage.z, s.targetZ, (SLOT_Z / TIMES.transfer) * 0.5, dt);
    if (m.carriage.z === s.targetZ) s.targetZ = null;
  }
  if (s.doorDir !== 0) {
    if (s.doorDir < 0 && !doorClear) {
      s.doorDir = 0;
      m.doorBlocked = true;
      m.message = '셔터 정지: 문 구역 감지';
    } else {
      const rate = (dt / TIMES.door) * (s.doorFast ? 2 : 1) * s.doorDir;
      m.door = Math.max(0, Math.min(1, m.door + rate));
      if (m.door === 0 || m.door === 1) s.doorDir = 0;
    }
  }
  if (s.yawTarget !== null) {
    m.yaw = moveTo(m.yaw, s.yawTarget, Math.PI / TIMES.rotate, dt);
    if (m.yaw === s.yawTarget) s.yawTarget = null;
  }
}

/** 복구 완료 가능 여부(문제 목록이 비면 가능) */
export function recoveryCheck(m: MachineState): RecoveryIssue[] {
  const s = m.manual;
  const out: RecoveryIssue[] = [];
  if (m.phase !== 'manual' || !s) return [{ code: 'E-00', text: '수동복구 모드가 아님' }];
  if (moving(s)) out.push({ code: 'E-60', text: '동작 중 — 정지 후 완료' });
  if (Math.abs(m.carriage.y) > EPS) out.push({ code: 'E-10', text: '캐리지가 1층에 있지 않음' });
  if (Math.abs(m.carriage.z) > EPS) out.push({ code: 'E-11', text: '수평 이송이 중앙에 있지 않음' });
  if (m.palletLoc === 'none') out.push({ code: 'E-20', text: '승강장에 팔레트 없음' });
  else if (m.palletLoc === 'carriage' && !m.carOnPallet) out.push({ code: 'E-21', text: '빈 팔레트가 승강장에 안착되지 않음' });
  const yawOk = Math.abs(m.yaw) < EPS || (m.carOnPallet && Math.abs(m.yaw - Math.PI) < EPS);
  if (!yawOk) out.push({ code: 'E-30', text: '턴테이블 각도 비정상' });
  if (m.door < 1 - EPS) out.push({ code: 'E-40', text: '셔터가 완전히 열려 있지 않음' });
  const ids = carIdsOf(m);
  if (ids.length !== new Set(ids).size || ids.join(',') !== s.ids0.join(',')) out.push({ code: 'E-50', text: '보관 차량 정보 불일치' });
  if (anonOnPallet(m) !== s.anon0) out.push({ code: 'E-51', text: '팔레트 위 차량 정보 불일치' });
  return out;
}

/** 복구 완료: 검사를 통과하면 정상 대기(빈 팔레트) 또는 출차 대기(차량이 실린 팔레트)로 */
export function finishRecovery(m: MachineState): { ok: boolean; issues: RecoveryIssue[] } {
  const issues = recoveryCheck(m);
  if (issues.length) {
    m.message = `복구 불가: ${issues[0].code} ${issues[0].text}`;
    return { ok: false, issues };
  }
  m.manual = null;
  m.resume = null;
  m.t = 0;
  m.doorBlocked = false;
  if (m.carOnPallet) {
    // 실린 차량은 출차 대기(탑승 후 출차) — 정상 출고 완료와 같은 상태
    m.phase = 'exit';
    m.palletLoc = 'carriage';
    m.locked = true;
    // op 는 수동 인출(palletFromSlot)이 남긴 실제 슬롯 정보를 그대로 둔다(없으면 null) — 빈 슬롯 이름을 지어내지 않는다
    m.message = '복구 완료 — 탑승 후 출차하세요';
  } else {
    m.phase = 'waiting';
    m.op = null;
    m.carrying = null;
    m.locked = false;
    m.rel = null;
    m.yaw = 0;
    m.palletLoc = 'station';
    m.message = '복구 완료 — 입고 가능';
  }
  m.fault = '';
  return { ok: true, issues: [] };
}

/** 제어반 표시용 요약 */
export function manualStatus(m: MachineState): { mode: string; door: number; floor: string; shift: string; pallet: string; car: string; canFinish: boolean; issues: RecoveryIssue[] } {
  const f = Math.round(m.carriage.y / FLOOR_H) + 1;
  const mode = m.phase === 'estop' ? '비상정지' : m.phase === 'manual' ? '비상 수동복구' : m.fault ? '장치 오류' : m.phase === 'waiting' ? '정상 대기' : '자동 운전';
  const issues = m.phase === 'manual' ? recoveryCheck(m) : [];
  return {
    mode,
    door: Math.round(m.door * 100),
    floor: `${floorLabel(f)}${floorAt(m.carriage.y) === null ? ' 이동 중' : ''}`,
    shift: Math.abs(m.carriage.z) < EPS ? '중앙' : m.carriage.z > 0 ? (Math.abs(m.carriage.z - SLOT_Z) < EPS ? 'A 끝' : 'A 쪽') : Math.abs(m.carriage.z + SLOT_Z) < EPS ? 'B 끝' : 'B 쪽',
    pallet: m.palletLoc === 'station' ? '승강장' : m.palletLoc === 'carriage' ? '캐리지' : '없음(보관)',
    car: m.carOnPallet ? (m.carrying ? `차량 #${m.carrying.carId}` : '입고 중 차량') : '없음',
    canFinish: m.phase === 'manual' && issues.length === 0,
    issues,
  };
}

