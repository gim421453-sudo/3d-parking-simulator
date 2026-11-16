import type { ProximityLevel } from '../sensors/sensorSystem';
import type { SensorGroup } from '../vehicle/spec';

/**
 * 주차 보조 카메라 "시점" (실제 3D 장면을 가상 카메라로 렌더링).
 *  rear/front : 차량에 달린 후방/전방 카메라
 *  left/right : 차량 측면을 뒤쪽 위에서 내려다보는 3D 측면뷰
 *  top        : 차량 바로 위 탑뷰 (실제 장면, 센서 PDC 아이콘과 별개)
 *  oblique    : 차량 뒤쪽 위 3D 사선뷰
 */
export type AssistView = 'rear' | 'front' | 'left' | 'right' | 'top' | 'topZoom' | 'topFront' | 'topRear' | 'oblique';
/** 메인 카메라(왼쪽 화면)에 쓸 수 있는 6가지 시점. 전체 탑뷰/사선은 오른쪽 3D 서라운드뷰 전용이라 여기에 없다 */
export const ASSIST_VIEW_ORDER: AssistView[] = ['rear', 'front', 'left', 'right', 'topFront', 'topRear'];
export const ASSIST_VIEW_NAME: Record<AssistView, string> = {
  rear: '후방 카메라',
  front: '전방 카메라',
  left: '좌측 3D 뷰',
  right: '우측 3D 뷰',
  top: '3D 탑뷰',
  topZoom: '측면 집중 탑뷰',
  topFront: '전방 집중 탑뷰',
  topRear: '후방 집중 탑뷰',
  oblique: '3D 사선뷰',
};

const RANK: Record<ProximityLevel, number> = { none: 0, far: 1, mid: 2, near: 3, critical: 4 };

/** 방향별 위험 판단 결과(pdc/risk.ts)에서 정책이 쓰는 부분 */
export interface ViewRisk {
  threat: Record<SensorGroup, boolean>;
  veryClose: Record<SensorGroup, boolean>;
  pillar: Record<SensorGroup, boolean>;
  narrow: boolean;
  /** 방향별 차체 외곽~장애물 간격(내부 계산용, 둘 다 위험할 때 더 가까운 쪽을 고르는 데 사용) */
  gap?: Record<SensorGroup, number | null>;
  /** 해당 측면 3D 시점이 차체/장애물에 가려져 틈이 보이지 않는가 (프레이밍 검사 결과) */
  sideBlocked: { left: boolean; right: boolean };
  /**
   * v0.6.1 장애물별 위험 순위의 1순위(pdc/riskRank.ts). 있으면 이것으로 시점을 고른다(그룹 경쟁 방식 대신).
   * cls 1 접촉 직전 · 2 매우 근접 · 3 경로 교차 · 4 스윙 교차 · 5 근접 · 6 먼 장애물
   */
  top?: {
    group: SensorGroup;
    place: string;
    cls: number;
    swing: boolean;
    id: string;
    /** v0.6.3: 내 차체에서 처음 닿는 부위(riskRank.contact). 있으면 장애물 위치(place)보다 우선해 카메라 방향을 정한다 */
    contact?: string | null;
  } | null;
}

export interface SideObservation {
  /** 있으면 간격/접근속도 기반 정책을 쓰고, 없으면 아래 level 기반(레거시) 정책을 쓴다 */
  risk?: ViewRisk;
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
export const DEFAULT_VIEW_POLICY: ViewPolicyConfig = { enterRank: 3, exitRank: 2, minHits: 3, enterConfirmSec: 0.5, releaseSec: 1.6, minHoldSec: 2.2, cooldownSec: 1.8 };

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
const reasonOf = (t: ViewRisk['top'] | undefined, dflt: string): string =>
  t ? `위험 ${t.cls}등급 ${t.id} (위치 ${t.place}${t.contact ? `, 접촉 ${t.contact}` : ''}${t.swing ? ', 스윙' : ''})` : dflt;

export class ViewPolicy {
  private cur: AssistView | null = null; // 자동 시점 (null = base)
  /** 자동 시점을 고를 때의 기준 카메라(기어 방향) */
  private curBase: AssistView | null = null;
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

  /**
   * 간격/접근속도 기반 + 진행 방향 우선 (메인 카메라 6종: 전방/후방/좌/우/전방 집중 탑/후방 집중 탑).
   *  - 진행 방향(D=전방, R=후방)의 위험이 있으면 항상 먼저: 기본 카메라 유지, 매우 가까우면 그 방향 집중 탑뷰.
   *  - 반대 방향의 위험은 시점을 바꾸지 않는다.
   *  - 진행 방향 위험이 없을 때만 측면: 위험한 쪽의 측면뷰(양쪽이면 더 가까운 쪽, 가려진 쪽은 제외).
   *    양쪽 전체 상황은 오른쪽 3D 서라운드뷰가 보여 주므로 메인 카메라는 전체 탑뷰로 가지 않는다.
   */
  /**
   * v0.6.1: 1순위 위험(장애물 단위)으로 시점 선택. 거리만이 아니라 등급(접촉/근접/경로 교차/스윙)을 쓴다.
   *  - 5·6등급(일반 근접·먼 장애물): 그룹 규칙(wantGroups) — 측면 위협이면 측면뷰, 아니면 기본 카메라
   *  - 진행 방향 정면: 1·2등급이면 그 방향 집중 탑뷰, 3등급(경로 교차)은 그룹 규칙(매우 근접이면 집중 탑뷰, 아니면 기본 카메라)
   *  - 반대 방향 정면: 1등급(접촉 직전)만 그 방향 집중 탑뷰
   *  - 측면/모서리: 그 쪽 측면뷰. 가려졌거나, 진행 반대쪽 모서리의 스윙이면 모서리가 보이는 집중 탑뷰
   */
  private wantTop(t: NonNullable<ViewRisk['top']>, r: ViewRisk, base: AssistView): AssistView | null {
    const dir: 'front' | 'rear' = base === 'rear' ? 'rear' : 'front';
    // 5·6등급이거나 진행 방향 경로 교차(3등급)이면 이전(v0.4.x~0.6.0) 그룹 규칙을 그대로 쓴다:
    // 측면 위협 → 측면뷰, 진행 방향 매우 근접(risk.ts veryClose) → 집중 탑뷰. 순위는 1~4등급의 "더 급한" 경우에만 우선한다.
    if (t.cls >= 5) return this.wantGroups(r, base);
    const topOf = (d: 'front' | 'rear'): AssistView => (d === 'front' ? 'topFront' : 'topRear');
    // v0.6.3: 방향은 "내 차 어디가 닿는가"(contact)로 정한다. 경로 교차가 없으면(1·2등급 근접) 장애물 위치(place)
    const at = t.contact ?? t.place;
    const end: 'front' | 'rear' | null = at.startsWith('front') ? 'front' : at.startsWith('rear') ? 'rear' : null;
    const side: 'left' | 'right' | null = /left/i.test(at) ? 'left' : /right/i.test(at) ? 'right' : null;
    if (!side) {
      // 범퍼 면: 진행 방향이면 기본 카메라(매우 가까우면 집중 탑뷰), 반대 방향은 접촉 직전만
      const e = end ?? dir;
      // 차폭 바깥(모서리 위치) 장애물에 조향 때문에 범퍼 면이 닿는 경로 교차(3등급): 기본 카메라만 유지하면
      // 장애물이 화면 가장자리에 걸린다 → 그 끝 집중 탑뷰(범퍼+모서리). v0.6.1 의 정차 조향 자동 시점(e2e-v061)을 유지.
      // 정면 벽처럼 차폭 안 장애물은 place 가 front/rear 라 해당 없음.
      if (e === dir && t.cls === 3 && t.place !== dir && t.place.startsWith(dir)) return topOf(dir);
      if (e === dir) return t.cls <= 2 ? topOf(dir) : this.wantGroups(r, base);
      return t.cls === 1 ? topOf(e) : null;
    }
    // 옆면: 진행 반대쪽 끝의 스윙이면 그 끝 집중 탑뷰, 측면 시점이 가려지면 그 모서리 집중 탑뷰, 아니면 그 쪽 측면뷰
    if (t.swing && end && end !== dir) return topOf(end);
    if (r.sideBlocked[side]) return topOf(end ?? dir);
    return side;
  }

  private wantRisk(r: ViewRisk, base: AssistView): AssistView | null {
    if (r.top) return this.wantTop(r.top, r, base);
    return this.wantGroups(r, base);
  }

  /** 그룹(전/후/좌/우) 위협 기반 규칙 — 1순위가 급하지 않을 때와 순위 정보가 없을 때 */
  private wantGroups(r: ViewRisk, base: AssistView): AssistView | null {
    const dir: 'front' | 'rear' = base === 'rear' ? 'rear' : 'front';
    if (r.threat[dir]) return r.veryClose[dir] ? (dir === 'front' ? 'topFront' : 'topRear') : null;
    const cands = (['left', 'right'] as const).filter((sd) => r.threat[sd] && !r.sideBlocked[sd]);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const gl = r.gap?.left ?? Infinity;
    const gr = r.gap?.right ?? Infinity;
    return gr < gl ? 'right' : 'left';
  }

  private want(obs: SideObservation, rank: number, base: AssistView = 'rear'): AssistView | null {
    if (obs.risk) return this.wantRisk(obs.risk, base);
    const side = (g: SensorGroup): boolean => RANK[obs.level[g]] >= rank && obs.hits[g] >= this.cfg.minHits;
    const l = side('left');
    const r = side('right');
    if (l && r) return 'left';
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
    // 진행 방향이 바뀌었는데(기어 변경) 이전 방향의 집중 탑뷰가 남아 있으면 즉시 기본 카메라로 (새 기어 방향 우선)
    // v0.6.1: 기준 카메라가 "바뀐" 경우에만 해제 — R 에서 앞 모서리 스윙 때문에 고른 전방 집중 탑뷰는 유지된다
    if (this.curBase !== null && this.curBase !== base && (this.cur === 'topFront' || this.cur === 'topRear')) {
      this.cur = null;
      this.cand = null;
      this.candT = 0;
      this.relT = 0;
      this.since = this.t;
    }
    // v0.6.1: 접촉 직전/매우 근접(1·2등급)은 확인 지연·쿨다운·최소 유지 없이 빠르게 반응한다
    const urgent = !!obs.risk?.top && obs.risk.top.cls <= 2;
    const held = urgent || this.t - this.since >= this.cfg.minHoldSec;
    const cool = urgent || this.t - this.lastSwitch >= this.cfg.cooldownSec;
    const enterWant = this.want(obs, this.cfg.enterRank, base);

    if (this.cur === null) {
      // 후보 확인 (연속 유지)
      if (enterWant && enterWant === this.cand) this.candT += dt;
      else {
        this.cand = enterWant;
        this.candT = 0;
      }
      if (this.cand && this.candT >= (urgent ? Math.min(0.1, this.cfg.enterConfirmSec) : this.cfg.enterConfirmSec) && cool) {
        this.cur = this.cand;
        this.curBase = base;
        this.since = this.t;
        this.lastSwitch = this.t;
        this.switches++;
        this.relT = 0;
        return { view: this.cur, auto: true, reason: reasonOf(obs.risk?.top, '측면 장애물 접근') };
      }
      return { view: base, auto: false, reason: '' };
    }

    // 자동 시점 중: 같은 쪽이 아직 가까우면 유지, 다른 조합이면(좌→양측 등) 전환 후보
    const stillWant = this.want(obs, this.cfg.exitRank, base); // 낮은 임계(히스테리시스)
    if (stillWant) {
      this.relT = 0;
      // v0.6.3: 자동 시점끼리 바꿀 때는 최소 유지·쿨다운을 지킨다(1·2등급이라도). 접촉 부위가 경계에서 흔들리면
      // 측면뷰↔집중 탑뷰가 매 프레임 진동했다(하네스 rr-wall). 접촉 직전(1등급)만 예외.
      const swHeld = this.t - this.since >= this.cfg.minHoldSec || obs.risk?.top?.cls === 1;
      const swCool = this.t - this.lastSwitch >= this.cfg.cooldownSec || obs.risk?.top?.cls === 1;
      if (stillWant !== this.cur && swHeld && swCool && enterWant && enterWant !== this.cur) {
        this.cur = enterWant;
        this.curBase = base;
        this.since = this.t;
        this.lastSwitch = this.t;
        this.switches++;
        return { view: this.cur, auto: true, reason: `전환: ${reasonOf(obs.risk?.top, '측면 장애물 접근')}` };
      }
      return { view: this.cur, auto: true, reason: stillWant === this.cur ? `유지: ${reasonOf(obs.risk?.top, '측면 장애물 접근')}` : `유지(최소 유지/쿨다운 대기 → ${stillWant})` };
    }
    this.relT += dt;
    // 집중 탑뷰는 충돌 가능성이 높을 때만 쓰는 보조 화면: 위험이 사라지면 더 빨리(0.8초) 기본 전/후방 카메라로 복귀
    const relNeed = this.cur === 'topFront' || this.cur === 'topRear' ? Math.min(this.cfg.releaseSec, 0.8) : this.cfg.releaseSec;
    if (this.relT >= relNeed && (held || this.cur === 'topFront' || this.cur === 'topRear')) {
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
