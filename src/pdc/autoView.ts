/**
 * 자동 카메라 연결 규칙 (v0.6.3, 순수 로직). Game 과 헤드리스 장면 하네스(scripts/pdc-scenes.ts)가 같은 함수를 쓴다.
 *
 * v0.6.1 회귀 원인: 위험 순위 1·2등급(간격 ≤ 0.3m)이 경로와 무관해도 (1) 자동 시점 게이트를 즉시 열고
 * (2) 확인 지연 없이 그 장애물 쪽으로 카메라를 돌렸다. 좁은 칸의 옆 차(경로 밖), 벗어나는 중인 앞벽 등
 * 실제 위험과 관계없는 방향으로 카메라가 갔다. 이제 카메라는 **현재 기어·조향의 예상 경로와 교차하거나 실제로 접근하는**
 * 장애물(relevant)만 따르고, 방향은 장애물 위치가 아니라 **내 차체가 닿는 부위(contact)**로 정한다.
 */
import { worldToLocal } from '../core/math';
import { cameraTop, type RiskCandidate } from './riskRank';
import type { ViewRisk } from './viewPolicy';

/** 시점 정책에 넘길 1순위(자동 카메라 자격이 있는 후보만) */
export function viewTopOf(rank: readonly RiskCandidate[]): ViewRisk['top'] {
  const t = cameraTop(rank);
  return t ? { group: t.group, place: t.place, cls: t.cls, swing: t.swing, id: t.id, contact: t.contact } : null;
}

/**
 * 자동 시점 게이트(기어 변경 직후 기본 카메라 우선)를 여는 조건:
 *  움직임(|v| > 0.3) · 기어 변경 때보다 조향 3° 이상 변화 · 경로 위 접촉 직전/매우 근접(relevant 1·2등급).
 */
export function viewGateOpens(v: number, steer: number, steerAtGear: number, rank: readonly RiskCandidate[]): boolean {
  const t = cameraTop(rank);
  return Math.abs(v) > 0.3 || Math.abs(steer - steerAtGear) > 0.05 || (t !== null && t.cls <= 2);
}

/** 프레임별 자동 카메라 디버그 기록 (일반 HUD 에 표시 금지 — 숫자는 sensorDebug/E2E 전용) */
export interface ViewLog {
  id: string | null;
  tag: string | null;
  world: { x: number; z: number } | null;
  local: { x: number; z: number } | null;
  gap: number | null;
  place: string | null;
  contact: string | null;
  cls: number | null;
  relevant: boolean;
  gear: string;
  steer: number;
  view: string;
  auto: boolean;
  reason: string;
  /** 선택된 카메라 화면 안에 그 장애물이 들어오는가 (Game 이 실제 보조 카메라로 투영해 채운다) */
  inView: boolean | null;
}

export function buildViewLog(rank: readonly RiskCandidate[], pose: { x: number; z: number; heading: number }, gear: string, steer: number, d: { view: string; auto: boolean; reason: string }): ViewLog {
  const t = cameraTop(rank) ?? rank[0] ?? null;
  const l = t ? worldToLocal(pose.x, pose.z, pose.heading, t.point.x, t.point.z) : null;
  return {
    id: t?.id ?? null,
    tag: t?.tag ?? null,
    world: t ? { ...t.point } : null,
    local: l,
    gap: t?.gap ?? null,
    place: t?.place ?? null,
    contact: t?.contact ?? null,
    cls: t?.cls ?? null,
    relevant: !!t?.relevant,
    gear,
    steer,
    view: d.view,
    auto: d.auto,
    reason: d.reason,
    inView: null,
  };
}
