/**
 * 장애물별 위험 순위 (v0.6.1, 순수 로직). 센서 그룹끼리 경쟁시키던 방식(전방 위험이 있으면 항상 전방 우선)을 대신해
 * **장애물(충돌체 ID) 하나를 후보 하나**로 만들고 실제 충돌 가능성으로 순위를 정한다.
 *
 * 후보: 차체 외곽까지 최소 간격, 위치(전/후/좌/우·모서리), 현재 기어 방향 + 실제 조향각으로 차체가 쓸고 갈 영역(스윕)과의 교차,
 *       교차하는 진행 거리, 차체 모서리 스윙 여부, 접근 속도/TTC(움직일 때만), 히트 수(신뢰도).
 * 등급(작을수록 위험):
 *   1 접촉 직전(간격 ≤ 0.08m)  2 매우 근접(≤ 0.3m)  3 예상 경로와 교차(진행 ≤ 2.5m)  4 조향 시 차체 모서리 스윙 교차
 *   5 일반 근접(≤ 1.3m)  6 먼 장애물
 * 같은 등급 안에서는 간격이 작은 쪽, 그다음 경로 교차 거리가 짧은 쪽. **정지 중에도** 스윕은 조향각으로 계산한다
 * (TTC 는 움직일 때만 쓴다 — 정지 상태에서 TTC 로 판단하지 않는다).
 * 숫자(간격/거리)는 내부 계산·디버그 로그 전용이다(일반 HUD 표시 금지).
 */
import type { Obb } from '../core/geometry';
import { worldToLocal } from '../core/math';
import type { SensorSnapshot } from '../sensors/sensorSystem';
import type { SensorGroup, VehicleSpec } from '../vehicle/spec';
import { rotateAbout } from './guidelines';
import { pointToObbGap } from './risk';

export const RANK_CONTACT = 0.08;
export const RANK_VERY_CLOSE = 0.3;
export const RANK_PATH = 2.5;
export const RANK_NEAR = 1.3;
export const SWEEP_STEP = 0.15;
export const SWEEP_MARGIN = 0.08;

export type Place = 'front' | 'rear' | 'left' | 'right' | 'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight';

export interface RiskCandidate {
  id: string;
  tag: string;
  cls: 1 | 2 | 3 | 4 | 5 | 6;
  gap: number;
  place: Place;
  /** 카메라/시점 선택용 방향 그룹 */
  group: SensorGroup;
  /** 예상 경로(현재 조향)로 진행했을 때 처음 닿는 진행 거리(m). 닿지 않으면 null */
  pathDist: number | null;
  /** 경로 교차가 차체 모서리(앞/뒤 끝의 바깥쪽)에서 생기는가 — 조향 스윙 */
  swing: boolean;
  closing: number;
  ttc: number | null;
  hits: number;
  /** 대표 히트점(월드) */
  point: { x: number; z: number };
  why: string;
}

export interface RankInput {
  snap: SensorSnapshot | null;
  spec: VehicleSpec;
  body: Obb;
  gear: 'P' | 'R' | 'N' | 'D';
  v: number;
  /** 실제 전륜 조향각(rad, 왼쪽 +) — 스티어링 휠 각도가 아니다 */
  steer: number;
}

const placeOf = (lx: number, lz: number, hw: number, hl: number): Place => {
  const fwd = lz > hl;
  const back = lz < -hl;
  const left = lx > hw;
  const right = lx < -hw;
  if (fwd) return left ? 'frontLeft' : right ? 'frontRight' : 'front';
  if (back) return left ? 'rearLeft' : right ? 'rearRight' : 'rear';
  return lx >= 0 ? 'left' : 'right';
};
const groupOf = (p: Place): SensorGroup => (p === 'front' ? 'front' : p === 'rear' ? 'rear' : p === 'left' || p === 'frontLeft' || p === 'rearLeft' ? 'left' : 'right');

/** 현재 조향으로 dir 방향 s 만큼 진행한 미래 차체(초기 차량 로컬 좌표) */
export function futureBody(spec: VehicleSpec, steer: number, dir: 1 | -1, s: number): { x: number; z: number; rot: number } {
  const zRear = -spec.length / 2 + spec.rearOverhang;
  const t = Math.tan(steer);
  if (Math.abs(t) < 1e-4) return { x: 0, z: dir * s, rot: 0 };
  const R = spec.wheelbase / t;
  const theta = (dir * s) / R;
  const c = rotateAbout(0, 0, R, zRear, theta);
  return { x: c.x, z: c.z, rot: theta };
}

export class RiskRanker {
  private prev = new Map<string, number>();
  private closing = new Map<string, number>();

  reset(): void {
    this.prev.clear();
    this.closing.clear();
  }

  update(dt: number, i: RankInput): RiskCandidate[] {
    if (!i.snap) {
      this.reset();
      return [];
    }
    const { body, spec } = i;
    const byId = new Map<string, { tag: string; pts: { x: number; z: number; lx: number; lz: number; gap: number }[] }>();
    spec.sensors.forEach((_m, k) => {
      const r = i.snap!.readings[k];
      if (!r) return;
      for (const h of r.hits) {
        const l = worldToLocal(body.x, body.z, body.rot, h.x, h.z);
        let e = byId.get(h.colliderId);
        if (!e) byId.set(h.colliderId, (e = { tag: h.tag, pts: [] }));
        e.pts.push({ x: h.x, z: h.z, lx: l.x, lz: l.z, gap: pointToObbGap(h.x, h.z, body) });
      }
    });
    const dir: 1 | -1 | 0 = i.gear === 'D' ? 1 : i.gear === 'R' ? -1 : 0;
    const moving = Math.abs(i.v) > 0.15;
    const out: RiskCandidate[] = [];
    const seen = new Set<string>();
    for (const [id, e] of byId) {
      seen.add(id);
      let best = e.pts[0];
      for (const p of e.pts) if (p.gap < best.gap) best = p;
      // 접근 속도(간격 변화율, 평활)
      const pg = this.prev.get(id);
      let cl = this.closing.get(id) ?? 0;
      if (pg !== undefined && dt > 0) cl += ((pg - best.gap) / dt - cl) * Math.min(1, dt * 5);
      this.prev.set(id, best.gap);
      this.closing.set(id, cl);
      const ttc = moving && cl > 0.2 ? best.gap / cl : null;
      // 스윕: 현재 조향으로 진행할 때 이 장애물의 히트점이 미래 차체 안(+여유)에 들어오는 첫 진행 거리
      let pathDist: number | null = null;
      let swing = false;
      if (dir !== 0) {
        for (let s = SWEEP_STEP; s <= RANK_PATH + 1e-9 && pathDist === null; s += SWEEP_STEP) {
          const fb = futureBody(spec, i.steer, dir, s);
          for (const p of e.pts) {
            const q = worldToLocal(fb.x, fb.z, fb.rot, p.lx, p.lz);
            if (Math.abs(q.x) <= body.hw + SWEEP_MARGIN && Math.abs(q.z) <= body.hl + SWEEP_MARGIN) {
              pathDist = s;
              // 진행 방향 끝(범퍼)이 아니라 측면 바깥쪽 모서리 부근에서 닿으면 스윙
              const lead = dir > 0 ? q.z > body.hl * 0.55 : q.z < -body.hl * 0.55;
              const trail = dir > 0 ? q.z < -body.hl * 0.55 : q.z > body.hl * 0.55;
              swing = (Math.abs(q.x) > body.hw * 0.6 && !lead) || trail;
              break;
            }
          }
        }
      }
      const place = placeOf(best.lx, best.lz, body.hw, body.hl);
      const g = best.gap;
      let cls: RiskCandidate['cls'];
      let why: string;
      if (g <= RANK_CONTACT) [cls, why] = [1, '접촉 직전'];
      else if (g <= RANK_VERY_CLOSE) [cls, why] = [2, '차체에 매우 근접'];
      else if (pathDist !== null && !swing) [cls, why] = [3, '예상 경로와 교차'];
      else if (pathDist !== null && swing) [cls, why] = [4, '조향 시 차체 스윙 교차'];
      else if (g <= RANK_NEAR || (ttc !== null && ttc < 2.5)) [cls, why] = [5, ttc !== null && g > RANK_NEAR ? '빠르게 접근' : '근접'];
      else [cls, why] = [6, '먼 장애물'];
      out.push({ id, tag: e.tag, cls, gap: g, place, group: groupOf(place), pathDist, swing, closing: cl, ttc, hits: e.pts.length, point: { x: best.x, z: best.z }, why });
    }
    for (const id of [...this.prev.keys()]) if (!seen.has(id)) {
      this.prev.delete(id);
      this.closing.delete(id);
    }
    out.sort((a, b) => a.cls - b.cls || a.gap - b.gap || (a.pathDist ?? 99) - (b.pathDist ?? 99));
    return out;
  }
}
