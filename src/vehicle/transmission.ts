import { epbOnShift } from './epb';
import { PARK_SPEED_LIMIT, SHIFT_SPEED_LIMIT, requestGear, type Gear, type VehicleState } from './physics';

/**
 * 변속 정책 (순수 로직, UI/입력과 독립). 키보드·터치 레버·게임패드가 모두 이 경로를 통과한다.
 *
 * 자동변속(전자식 레버) 규칙:
 *  - P 에서 벗어나기(→R/N/D), N→R/D, D↔R : **브레이크 페달을 밟아야** 함 (브레이크 인터록)
 *  - →P : 정지에 가까워야 함 (|v| ≤ 1km/h), 브레이크는 불필요
 *  - →R : 전진 속도가 2km/h 이하여야 함 / →D : 후진 속도가 2km/h 이하여야 함
 *  - →N : 언제든 가능 (안전한 방향)
 */
export type GearboxKind = 'auto' | 'manual';

export interface ShiftContext {
  current: Gear;
  target: Gear;
  v: number; // 부호 있는 속도 (m/s), 앞 +
  brake: boolean; // 브레이크 페달이 눌린 상태
}

export type ShiftCode = 'ok' | 'brake_required' | 'must_stop_for_park' | 'moving_forward' | 'moving_backward';
export interface ShiftDecision {
  ok: boolean;
  code: ShiftCode;
  reason?: string;
}

export const BRAKE_REQUIRED_MSG = '브레이크를 밟은 상태에서 변속하세요';

export function evaluateShift(c: ShiftContext): ShiftDecision {
  if (c.current === c.target) return { ok: true, code: 'ok' };
  const needsBrake = c.current === 'P' || (c.current === 'N' && (c.target === 'R' || c.target === 'D')) || (c.current === 'D' && c.target === 'R') || (c.current === 'R' && c.target === 'D');
  switch (c.target) {
    case 'N':
      return { ok: true, code: 'ok' };
    case 'P':
      if (Math.abs(c.v) > PARK_SPEED_LIMIT) return { ok: false, code: 'must_stop_for_park', reason: '차를 완전히 멈춘 뒤 P로 변경하세요' };
      return { ok: true, code: 'ok' };
    case 'R':
      if (c.v > SHIFT_SPEED_LIMIT) return { ok: false, code: 'moving_forward', reason: '전진 중에는 R로 변경할 수 없습니다' };
      break;
    case 'D':
      if (c.v < -SHIFT_SPEED_LIMIT) return { ok: false, code: 'moving_backward', reason: '후진 중에는 D로 변경할 수 없습니다' };
      break;
  }
  if (needsBrake && !c.brake) return { ok: false, code: 'brake_required', reason: BRAKE_REQUIRED_MSG };
  return { ok: true, code: 'ok' };
}

/** 인터록을 통과하면 실제로 기어를 바꾼다. */
export function shiftGear(s: VehicleState, target: Gear, brake: boolean): ShiftDecision {
  const d = evaluateShift({ current: s.gear, target, v: s.v, brake });
  if (!d.ok) return d;
  const r = requestGear(s, target); // 물리 쪽의 속도 조건도 한 번 더 확인 (이중 안전)
  if (!r.ok) return { ok: false, code: 'must_stop_for_park', reason: r.reason };
  epbOnShift(s, target); // v0.6.0: P 로 들어가면 주차 브레이크 자동 체결
  return d;
}

/** 각 기어로 지금 변속 가능한지 (레버 UI 에서 불가능한 위치를 흐리게 표시) */
export function allowedShifts(current: Gear, v: number, brake: boolean): Record<Gear, ShiftDecision> {
  const out = {} as Record<Gear, ShiftDecision>;
  for (const g of ['P', 'R', 'N', 'D'] as Gear[]) out[g] = evaluateShift({ current, target: g, v, brake });
  return out;
}

// ---------------------------------------------------------------- 차량별 변속기 모듈
/**
 * 변속기를 차량 데이터로 분리하기 위한 인터페이스.
 * - 'auto': 구현됨 (위 evaluateShift).
 * - 'manual': **구조만 준비**. 클러치/RPM/기어단/시동 꺼짐 물리는 구현되지 않았다. (docs/VEHICLE_DATA.md)
 */
export interface Gearbox {
  kind: GearboxKind;
  /** 레버/표시기가 보여 줄 위치 */
  positions: Gear[];
  evaluate(ctx: ShiftContext): ShiftDecision;
  implemented: boolean;
}

export const AUTOMATIC_GEARBOX: Gearbox = { kind: 'auto', positions: ['P', 'R', 'N', 'D'], evaluate: evaluateShift, implemented: true };

export const MANUAL_GEARBOX_STUB: Gearbox = {
  kind: 'manual',
  positions: ['N', 'R', 'D'],
  evaluate: () => ({ ok: false, code: 'brake_required', reason: '수동변속은 아직 지원되지 않습니다' }),
  implemented: false,
};

export const gearboxFor = (kind: GearboxKind): Gearbox => (kind === 'manual' ? MANUAL_GEARBOX_STUB : AUTOMATIC_GEARBOX);
