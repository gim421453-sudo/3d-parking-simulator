/**
 * 방향지시등 자동 해제 (v0.5.5, 순수 로직) — 실차의 캔슬 캠과 같은 동작.
 *  - 깜빡이를 켠 방향으로 핸들을 ARM_DEG(180°) 이상 돌리면 "장전"된다.
 *  - 장전된 뒤 핸들이 풀려 RELEASE_DEG(45°) 이하로 돌아오면 그 깜빡이를 끈다.
 *  - 180° 미만으로만 돌렸다가 풀면(차선 변경 정도) 꺼지지 않는다. 반대 방향으로 돌리는 것은 장전에 영향을 주지 않는다.
 * 핸들 각도 부호: 왼쪽 +, 오른쪽 − (도). 비상등은 대상이 아니다.
 */
export const SIGNAL_ARM_DEG = 180;
export const SIGNAL_RELEASE_DEG = 45;

export interface SignalCancelState {
  armed: boolean;
  /** 장전된 방향 */
  dir: 'left' | 'right' | null;
}
export const newSignalCancel = (): SignalCancelState => ({ armed: false, dir: null });

/** 매 프레임 호출. 반환값이 true 면 현재 켜진 방향지시등을 꺼야 한다 */
export function updateSignalCancel(s: SignalCancelState, signal: 'left' | 'right' | null, wheelDeg: number): boolean {
  if (!signal) {
    s.armed = false;
    s.dir = null;
    return false;
  }
  if (s.dir !== signal) {
    // 방향이 바뀌면 다시 시작
    s.dir = signal;
    s.armed = false;
  }
  const toward = signal === 'left' ? wheelDeg : -wheelDeg; // 깜빡이 방향으로 돌린 각도
  if (!s.armed) {
    if (toward >= SIGNAL_ARM_DEG) s.armed = true;
    return false;
  }
  if (toward <= SIGNAL_RELEASE_DEG) {
    s.armed = false;
    s.dir = null;
    return true;
  }
  return false;
}
