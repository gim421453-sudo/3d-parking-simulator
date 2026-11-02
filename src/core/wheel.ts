/**
 * 1080° 회전형 핸들 모델 (순수 로직).
 * - Lock-to-Lock 1080° = 중앙 기준 좌우 각 540°. 앞바퀴 조향각은 spec.maxSteer 로 매핑된다 (핸들 각도와 바퀴 각도는 다름).
 * - 손가락 각도를 "증분"으로 누적(unwrap)하므로 여러 바퀴를 돌려도 연속적이다.
 * - 각도 양수 = 왼쪽(반시계). 화면 각도는 시계방향 양수이므로 부호를 뒤집는다.
 */
export const WHEEL_LOCK_DEG = 540;
export const WHEEL_MAX_JUMP_DEG = 110; // 한 샘플의 급격한 점프는 추적 오류로 보고 무시
export const WHEEL_DEAD_RADIUS = 0.14; // 중심 근처(반지름 비율)에서는 각도가 불안정하므로 추적하지 않음

/** (-180, 180] 로 정규화한 각도 차 */
export function unwrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/** 정차 판단 임계값(m/s, 히스테리시스): 이 값 미만이면 정차로 보고 손을 떼도 조향각을 유지, 이 값을 넘어서면 주행으로 보고 자동 복귀 */
export const WHEEL_HOLD_ENTER_MPS = 0.15;
export const WHEEL_HOLD_EXIT_MPS = 0.35;

export class WheelModel {
  /** 정차 중 조향 유지 상태 (속도 미세 변동으로 유지/복귀가 반복되지 않도록 히스테리시스) */
  holding = true;
  /** 핸들 각도(도), 왼쪽 + */
  angle = 0;
  dragging = false;
  private last: number | null = null;

  /** 손가락이 닿음: 현재 포인터 각도(화면 기준, 시계방향 +)를 기준점으로 */
  begin(pointerDeg: number): void {
    this.dragging = true;
    this.last = pointerDeg;
  }

  /** 포인터 이동. 반환: 적용된 각도 증분 (무시되면 0) */
  move(pointerDeg: number, radiusFrac = 1): number {
    if (!this.dragging || this.last === null) return 0;
    if (radiusFrac < WHEEL_DEAD_RADIUS) return 0;
    const raw = unwrapDeg(pointerDeg - this.last);
    if (Math.abs(raw) > WHEEL_MAX_JUMP_DEG) {
      this.last = pointerDeg; // 점프: 기준점만 재설정
      return 0;
    }
    this.last = pointerDeg;
    const before = this.angle;
    this.angle = Math.max(-WHEEL_LOCK_DEG, Math.min(WHEEL_LOCK_DEG, this.angle - raw));
    return this.angle - before;
  }

  end(): void {
    this.dragging = false;
    this.last = null;
  }

  /** 놓은 뒤 중앙 복귀. returnRate: 설정 배율(0.5~2), speedMps: 속도가 빠를수록 빨리 복귀 */
  update(dt: number, speedMps: number, returnRate = 1): void {
    const sp = Math.abs(speedMps);
    if (this.holding) {
      if (sp > WHEEL_HOLD_EXIT_MPS) this.holding = false;
    } else if (sp < WHEEL_HOLD_ENTER_MPS) this.holding = true;
    // 정차(기어 P 여부와 무관, D/R 에서 브레이크로 멈춘 경우 포함) 중에는 놓아도 현재 각도 유지
    if (this.holding || this.dragging || this.angle === 0) return;
    const rate = (160 + Math.min(10, Math.abs(speedMps)) * 28) * returnRate; // deg/s
    const d = rate * dt;
    this.angle = Math.abs(this.angle) <= d ? 0 : this.angle - Math.sign(this.angle) * d;
  }

  /** -1..1 조향 입력 (감도 배율 적용). VehicleInput.steerInput 으로 쓰인다 */
  steer(sensitivity = 1): number {
    return Math.max(-1, Math.min(1, (this.angle / WHEEL_LOCK_DEG) * sensitivity));
  }

  reset(): void {
    this.angle = 0;
    this.holding = true;
    this.end();
  }
}
