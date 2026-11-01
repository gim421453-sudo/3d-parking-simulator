import type { ProximityLevel } from '../sensors/sensorSystem';
import type { SensorGroup } from '../vehicle/spec';

/**
 * 주차 보조 카메라 "시점" (실제 3D 장면을 가상 카메라로 렌더링).
 *  rear/front : 차량에 달린 후방/전방 카메라
 *  left/right : 차량 측면을 뒤쪽 위에서 내려다보는 3D 측면뷰
 *  top        : 차량 바로 위 탑뷰 (실제 장면, 센서 PDC 아이콘과 별개)
 *  oblique    : 차량 뒤쪽 위 3D 사선뷰
 */
export type AssistView = 'rear' | 'front' | 'left' | 'right' | 'top' | 'oblique';
export const ASSIST_VIEW_ORDER: AssistView[] = ['rear', 'front', 'left', 'right', 'top', 'oblique'];
export const ASSIST_VIEW_NAME: Record<AssistView, string> = {
  rear: '후방 카메라',
  front: '전방 카메라',
  left: '좌측 3D 뷰',
  right: '우측 3D 뷰',
  top: '3D 탑뷰',
  oblique: '3D 사선뷰',
};

const RANK: Record<ProximityLevel, number> = { none: 0, far: 1, mid: 2, near: 3, critical: 4 };

export interface SideObservation {
  /** 그룹별 최악 단계 */
  level: Record<SensorGroup, ProximityLevel>;
  /** 그룹별 현재 장애물에 닿은 광선 수 (신뢰도: 우연한 한두 개 광선은 무시) */
  hits: Record<SensorGroup, number>;
}

export interface ViewPolicyConfig {
  enterRank: number; // 이 단계 이상이면 측면 진입 후보 (기본 near=3)
  exitRank: number; // 이 단계 미만이어야 해제 후보 (기본 mid=2, 히스테리시스)
  minHits: number; // 신뢰도: 최소 광선 수
  enterConfirmSec: number; // 후보가 이 시간 연속 유지되어야 전환
  releaseSec: number; // 해제 조건이 이 시간 유지되어야 원래 시점으로 복귀
  minHoldSec: number; // 전환 후 최소 유지 시간
  cooldownSec: number; // 전환 사이 최소 간격
}
export const DEFAULT_VIEW_POLICY: ViewPolicyConfig = { enterRank: 3, exitRank: 2, minHits: 3, enterConfirmSec: 0.3, releaseSec: 1.6, minHoldSec: 1.4, cooldownSec: 0.9 };

export interface ViewDecision {
  view: AssistView;
  auto: boolean; // 자동 전환으로 정해진 시점인가
  reason: string;
}

/**
 * 자동 3D 시점 정책 (상태 보유, 순수 로직).
 *  - 좌측 근접 → left, 우측 근접 → right, 양측 근접 → top
 *  - 전방/후방 장애물만 → 기본(base) 시점 유지
 *  - 해제: exitRank 미만이 releaseSec 이상 → base 로 복귀
 *  - 수동 카메라(manual != null)가 항상 우선하며 자동 전환은 멈춘다
 *  - 최소 유지/쿨다운/확인 지연/히스테리시스로 플리커 방지
 */
export class ViewPolicy {
  private cur: AssistView | null = null; // 자동 시점 (null = base)
  private since = 0;
  private lastSwitch = -Infinity;
  private cand: AssistView | null = null;
  private candT = 0;
  private relT = 0;
  private t = 0;
  switches = 0;

  constructor(private cfg: ViewPolicyConfig = DEFAULT_VIEW_POLICY) {}

  reset(): void {
    this.cur = null;
    this.since = this.t;
    this.cand = null;
    this.candT = 0;
    this.relT = 0;
    this.lastSwitch = -Infinity;
  }

  private want(obs: SideObservation, rank: number): AssistView | null {
    const side = (g: SensorGroup): boolean => RANK[obs.level[g]] >= rank && obs.hits[g] >= this.cfg.minHits;
    const l = side('left');
    const r = side('right');
    if (l && r) return 'top';
    if (l) return 'left';
    if (r) return 'right';
    return null;
  }

  update(dt: number, base: AssistView, manual: AssistView | null, obs: SideObservation | null, enabled: boolean): ViewDecision {
    this.t += dt;
    if (manual) {
      this.cur = null;
      this.cand = null;
      return { view: manual, auto: false, reason: '수동 선택' };
    }
    if (!enabled || !obs) {
      this.cur = null;
      this.cand = null;
      return { view: base, auto: false, reason: enabled ? '센서 없음' : '자동 전환 꺼짐' };
    }
    const held = this.t - this.since >= this.cfg.minHoldSec;
    const cool = this.t - this.lastSwitch >= this.cfg.cooldownSec;
    const enterWant = this.want(obs, this.cfg.enterRank);

    if (this.cur === null) {
      // 후보 확인 (연속 유지)
      if (enterWant && enterWant === this.cand) this.candT += dt;
      else {
        this.cand = enterWant;
        this.candT = 0;
      }
      if (this.cand && this.candT >= this.cfg.enterConfirmSec && cool) {
        this.cur = this.cand;
        this.since = this.t;
        this.lastSwitch = this.t;
        this.switches++;
        this.relT = 0;
        return { view: this.cur, auto: true, reason: '측면 장애물 접근' };
      }
      return { view: base, auto: false, reason: '' };
    }

    // 자동 시점 중: 같은 쪽이 아직 가까우면 유지, 다른 조합이면(좌→양측 등) 전환 후보
    const stillWant = this.want(obs, this.cfg.exitRank); // 낮은 임계(히스테리시스)
    if (stillWant) {
      this.relT = 0;
      if (stillWant !== this.cur && held && cool && enterWant && enterWant !== this.cur) {
        this.cur = enterWant;
        this.since = this.t;
        this.lastSwitch = this.t;
        this.switches++;
      }
      return { view: this.cur, auto: true, reason: '측면 장애물 접근' };
    }
    this.relT += dt;
    if (this.relT >= this.cfg.releaseSec && held) {
      this.cur = null;
      this.cand = null;
      this.candT = 0;
      this.since = this.t;
      this.lastSwitch = this.t;
      this.switches++;
      return { view: base, auto: false, reason: '장애물 해제: 원래 시점 복귀' };
    }
    return { view: this.cur, auto: true, reason: '해제 대기' };
  }
}
