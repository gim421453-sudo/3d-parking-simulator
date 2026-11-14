/**
 * 전자식 주차 브레이크 자동 동작 (v0.6.0, 순수 로직).
 * - P 로 변속하면 자동 체결 (`epbOnShift`)
 * - D/R 에서 시동이 걸린 채 가속 페달을 밟으면 자동 해제 (`epbAutoRelease`) — 실차 EPB 의 "드라이브 어웨이 릴리즈"
 * 수동 토글(Space/버튼)은 그대로 쓸 수 있다. 해제 조건이 아니면 아무것도 바꾸지 않는다.
 */
import type { Gear, VehicleState } from './physics';

/** 가속 페달 입력이 이 값을 넘으면 "밟음"으로 본다 (스치는 입력/노이즈 무시) */
export const EPB_RELEASE_THROTTLE = 0.08;

/** 변속 직후 호출: P 로 들어가면 체결. 바뀌었으면 true */
export function epbOnShift(s: Pick<VehicleState, 'handbrake'>, newGear: Gear): boolean {
  if (newGear === 'P' && !s.handbrake) {
    s.handbrake = true;
    return true;
  }
  return false;
}

/** 매 스텝: D/R + 시동 RUNNING + 가속 페달이면 해제. 해제했으면 true */
export function epbAutoRelease(s: Pick<VehicleState, 'handbrake' | 'gear'>, throttle: number, engineRunning: boolean): boolean {
  if (!s.handbrake) return false;
  if (s.gear !== 'D' && s.gear !== 'R') return false;
  if (!engineRunning || throttle <= EPB_RELEASE_THROTTLE) return false;
  s.handbrake = false;
  return true;
}
