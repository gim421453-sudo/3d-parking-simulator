import type { Gear } from '../vehicle/physics';

export type AssistCamera = 'rear' | 'front';

export interface AssistSettings {
  autoRear: boolean; // R 선택 시 자동 표시
  autoFront: boolean; // D 선택 시 전방카메라 자동 표시
  frontMaxKmh: number; // D 에서 주차 보조 화면이 유지되는 최대 속도
  pExitSec: number; // P 로 바꾼 뒤 화면이 닫히기까지 지연
}

export const DEFAULT_ASSIST: AssistSettings = { autoRear: true, autoFront: true, frontMaxKmh: 10, pExitSec: 3 };

export interface AssistInput {
  gear: Gear;
  speedKmh: number;
  dt: number;
}

export interface AssistOutput {
  active: boolean;
  /** 화면에 보이는 카메라 영상 */
  camera: AssistCamera;
  /** PDC 강조 방향 (기어 기준) */
  focus: AssistCamera;
  /** 카메라 선택 방식 */
  cameraMode: 'auto' | AssistCamera;
  reason: string;
}

/**
 * 주차 보조 디스플레이 표시 정책 (엔진 독립, 단위 테스트 대상).
 * - R: 후방카메라 + 후방 PDC 자동 표시 (autoRear)
 * - D: 기어를 D 로 "선택"했을 때 속도가 frontMaxKmh 이하면 전방카메라 자동 표시. 속도가 frontMaxKmh 를 넘으면 닫히고,
 *      frontMaxKmh*0.6 이하로 내려오면 다시 표시(히스테리시스).
 * - N: 표시 중이면 저속(≤ frontMaxKmh) 동안 유지, 아니면 유지하지 않음.
 * - P: 표시 중이면 pExitSec 후 닫힘.
 * - 우선순위: 수동(사용자) > 자동. 수동 카메라 선택/닫기/열기는 다음 기어 변경까지 유지된다.
 */
export class AssistController {
  private lastGear: Gear = 'P';
  private open = false;
  private pTimer = 0;
  private dismissed = false;
  private forced = false;
  private manual: 'auto' | AssistCamera = 'auto';
  private focus: AssistCamera = 'rear';
  private lastReason = '';

  reset(gear: Gear = 'P'): void {
    this.lastGear = gear;
    this.open = false;
    this.pTimer = 0;
    this.dismissed = false;
    this.forced = false;
    this.manual = 'auto';
    this.focus = 'rear';
  }

  /** 사용자가 카메라를 직접 고른다 ('auto' 로 돌아갈 수 있음). 다음 기어 변경까지 유지. */
  setManualCamera(c: 'auto' | AssistCamera): void {
    this.manual = c;
  }
  get cameraMode(): 'auto' | AssistCamera {
    return this.manual;
  }
  /** 수동 닫기: 다음 기어 변경까지 자동으로 다시 열리지 않는다 */
  dismiss(): void {
    this.dismissed = true;
    this.forced = false;
    this.open = false;
  }
  /** 수동 열기/닫기 토글. */
  toggleManual(): void {
    if (this.open && !this.dismissed) this.dismiss();
    else {
      this.dismissed = false;
      this.forced = true;
      this.open = true;
    }
  }

  update(inp: AssistInput, s: AssistSettings): AssistOutput {
    const g = inp.gear;
    const slow = inp.speedKmh <= s.frontMaxKmh;
    if (g !== this.lastGear) {
      // 기어 변경: 수동 상태 초기화 후 새 기어 규칙 적용
      this.dismissed = false;
      this.forced = false;
      this.manual = 'auto';
      this.pTimer = 0;
      this.closedBySpeed = false;
      if (g === 'R') {
        this.open = s.autoRear;
        this.focus = 'rear';
        this.lastReason = 'R 기어 선택';
      } else if (g === 'D') {
        this.focus = 'front';
        this.open = s.autoFront && slow;
        this.closedBySpeed = s.autoFront && !slow;
        this.lastReason = this.open ? 'D 기어 선택(저속)' : 'D 기어(고속)';
      } else if (g === 'N' && this.open && !slow) {
        this.open = false;
      }
      this.lastGear = g;
    }

    if (!this.dismissed) {
      if (g === 'D') {
        if (this.open && !slow && !this.forced) {
          this.open = false;
          this.closedBySpeed = true;
          this.lastReason = '고속 주행: 일반 화면 복귀';
        } else if (!this.open && this.closedBySpeed && s.autoFront && inp.speedKmh <= s.frontMaxKmh * 0.6) {
          this.open = true; // 히스테리시스: 충분히 느려지면 다시 표시
          this.closedBySpeed = false;
          this.lastReason = '저속 복귀: 전방카메라';
        }
      } else if (g === 'N') {
        if (this.open && !slow && !this.forced) this.open = false;
      } else if (g === 'P') {
        if (this.open && !this.forced) {
          this.pTimer += inp.dt;
          if (this.pTimer >= s.pExitSec) {
            this.open = false;
            this.lastReason = 'P 기어: 화면 종료';
          }
        }
      }
    }

    const focus: AssistCamera = g === 'R' ? 'rear' : g === 'D' ? 'front' : this.focus;
    this.focus = focus;
    const camera: AssistCamera = this.manual === 'auto' ? focus : this.manual;
    return { active: this.open && !this.dismissed, camera, focus, cameraMode: this.manual, reason: this.lastReason };
  }

  private closedBySpeed = false;
}
