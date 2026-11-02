import type { Gear } from '../vehicle/physics';

/**
 * 인포테인먼트 표시 상태 관리자 (순수 로직). 3인칭 플로팅 디스플레이와 1인칭 실내 센터 디스플레이가 **하나의 상태를 공유**한다.
 *  - content: parking(주차 보조) | nav(내비게이션)
 *  - floatingVisible: 3인칭에서 보이는 플로팅 패널 (1인칭에서는 항상 false)
 *  - cabin 화면은 항상 켜져 있고 같은 content 를 보여 준다
 * 우선순위: 사용자 수동(토글/닫기) > 자동. 수동 상태는 다음 기어 변경 시 해제(자동 표시 규칙 재적용).
 */
export type InfoContent = 'parking' | 'nav';

export interface InfoSettings {
  autoShow: boolean; // 주차 보조가 필요할 때 자동으로 플로팅 표시
  autoHide: boolean; // 주차 보조가 끝나면 플로팅을 자동으로 숨김 (false 이면 내비게이션을 표시하며 유지)
  autoHideSec: number;
}
export const DEFAULT_INFO_SETTINGS: InfoSettings = { autoShow: true, autoHide: true, autoHideSec: 2.5 };

export interface InfoInput {
  dt: number;
  gear: Gear;
  parkingActive: boolean;
  firstPerson: boolean;
}

export interface InfoOutput {
  floatingVisible: boolean;
  content: InfoContent;
  /** 수동 오버라이드 상태 (null = 자동) */
  override: boolean | null;
  /** 상태 자체의 가시성(1인칭 여부와 무관) — 1인칭에서 3인칭으로 돌아올 때 복원 기준 */
  wantVisible: boolean;
  reason: string;
  /** 1인칭에서 사용자가 "확대 화면"을 직접 열었는가 */
  expanded: boolean;
  /** 사용자가 고른 내용(null = 자동) */
  forcedContent: InfoContent | null;
}

export class InfotainmentController {
  private lastGear: Gear = 'P';
  private override: boolean | null = null;
  private autoVisible = false;
  private hideT = 0;
  private reason = '';
  private expanded = false;
  private forced: InfoContent | null = null;

  /** 1인칭 확대 화면 열기/닫기 (사용자가 직접). 3인칭으로 돌아가면 자동으로 닫힌다 */
  setExpanded(on: boolean): void {
    this.expanded = on;
    if (on) {
      this.override = true;
      this.reason = '확대 화면';
    }
  }
  get isExpanded(): boolean {
    return this.expanded;
  }
  /** 표시 내용 수동 전환: 자동 → 반대 내용 → 자동 */
  toggleContent(current: InfoContent): InfoContent | null {
    this.forced = this.forced === null ? (current === 'parking' ? 'nav' : 'parking') : null;
    this.reason = this.forced ? '내용 수동 전환' : '내용 자동';
    return this.forced;
  }

  reset(gear: Gear = 'P'): void {
    this.expanded = false;
    this.forced = null;
    this.lastGear = gear;
    this.override = null;
    this.autoVisible = false;
    this.hideT = 0;
    this.reason = '';
  }

  /** 사용자 토글: 현재 "원하는 가시성"을 반전한다 (다음 기어 변경까지 유지) */
  toggle(): boolean {
    const now = this.override ?? this.autoVisible;
    this.override = !now;
    this.reason = this.override ? '수동 표시' : '수동 숨김';
    return this.override;
  }
  hide(): void {
    this.expanded = false;
    this.override = false;
    this.reason = '수동 숨김';
  }
  show(): void {
    this.override = true;
    this.reason = '수동 표시';
  }

  update(i: InfoInput, s: InfoSettings): InfoOutput {
    if (i.gear !== this.lastGear) {
      // 새 기어 선택: 이전에 수동으로 닫았더라도 자동 표시 규칙을 다시 적용
      this.override = null;
      this.forced = null;
      this.hideT = 0;
      this.lastGear = i.gear;
    }
    if (i.parkingActive) {
      this.hideT = 0;
      if (s.autoShow) {
        if (!this.autoVisible) this.reason = '주차 보조 자동 표시';
        this.autoVisible = true;
      }
    } else if (this.autoVisible) {
      if (s.autoHide) {
        this.hideT += i.dt;
        if (this.hideT >= s.autoHideSec) {
          this.autoVisible = false;
          this.hideT = 0;
          this.reason = '자동 숨김';
        }
      } else {
        this.reason = '내비게이션 유지';
      }
    }
    if (!i.firstPerson) this.expanded = false;
    const want = this.override ?? this.autoVisible;
    return {
      floatingVisible: want && (!i.firstPerson || this.expanded),
      expanded: this.expanded,
      forcedContent: this.forced,
      content: this.forced ?? (i.parkingActive ? 'parking' : 'nav'),
      override: this.override,
      wantVisible: want,
      reason: this.reason,
    };
  }
}
