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
  /** 대표 히트점(현재 차체 로컬: +x 왼쪽, +z 앞) — 디버그 로그용 */
  local: { x: number; z: number };
  /**
   * v0.6.3: 예상 경로로 진행할 때 **내 차체의 어느 부분**이 처음 닿는가(장애물 위치가 아니라 접촉 부위).
   * 앞/뒤 = 범퍼 면, left/right = 옆면 가운데, frontLeft 등 = 옆면 앞/뒤 끝(모서리 쪽). 경로 교차가 없으면 null.
   * 카메라는 장애물이 "어디 있나"보다 "차 어디가 닿나"로 골라야 한다(큰 충돌체의 가장 가까운 점이 측면이어도 실제 접촉은 뒤범퍼일 수 있음).
   */
  contact: Place | null;
  /**
   * v0.6.3: 자동 카메라를 움직일 자격. 현재 기어·조향의 예상 경로와 교차하거나(pathDist) 실제로 빠르게 접근(TTC)할 때만 true.
   * 경로 밖에서 나란히 가까운 물체(좁은 칸 옆 차, 벗어나는 중인 앞벽)는 경고음/색으로만 알리고 카메라는 바꾸지 않는다.
   */
  relevant: boolean;
  /** 예상 경로를 따라가며 가장 가까워지는 간격(경로 교차 전까지). 디버그·카메라 우선순위용 */
  passGap: number | null;
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

/** 진행 방향 끝(범퍼)이 아니라 측면 바깥쪽 모서리 부근에서 닿으면 스윙 (q = 미래 차체 로컬 점) */
function swingAt(q: { x: number; z: number }, dir: 1 | -1, body: { hw: number; hl: number }): boolean {
  const lead = dir > 0 ? q.z > body.hl * 0.55 : q.z < -body.hl * 0.55;
  const trail = dir > 0 ? q.z < -body.hl * 0.55 : q.z > body.hl * 0.55;
  return (Math.abs(q.x) > body.hw * 0.6 && !lead) || trail;
}

/**
 * 접촉 부위(v0.6.3): 차폭 안에 든 점이 있으면 범퍼 면, 차체 길이 안에 든 점이 있으면 옆면(앞/뒤 끝 쪽이면 모서리 표기),
 * 둘 다 아니면(모서리 바깥 대각선) 더 많이 벗어난 축으로 정한다.
 * 한 점만 보고 정하면 직진 후진 벽이 모서리 여유 구간 점 때문에 '옆면'으로 잘못 분류된다(하네스 rear-wall 회귀).
 */
function contactOf(inside: readonly { x: number; z: number }[], q: { x: number; z: number }, body: { hw: number; hl: number }): Place {
  const sideName = (p: { x: number; z: number }): Place => {
    const sd = p.x > 0 ? 'Left' : 'Right';
    return p.z > body.hl * 0.55 ? (`front${sd}` as Place) : p.z < -body.hl * 0.55 ? (`rear${sd}` as Place) : sd === 'Left' ? 'left' : 'right';
  };
  const endPt = inside.find((p) => Math.abs(p.x) <= body.hw);
  if (endPt) return endPt.z > 0 ? 'front' : 'rear';
  const sidePt = inside.find((p) => Math.abs(p.z) <= body.hl);
  if (sidePt) return sideName(sidePt);
  if (Math.abs(q.x) <= body.hw) return q.z > 0 ? 'front' : 'rear';
  if (Math.abs(q.z) <= body.hl) return sideName(q);
  return Math.abs(q.z) - body.hl >= Math.abs(q.x) - body.hw ? (q.z > 0 ? 'front' : 'rear') : sideName(q);
}

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
  private nearPassIds = new Set<string>();

  reset(): void {
    this.prev.clear();
    this.closing.clear();
    this.nearPassIds.clear();
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
      let contact: Place | null = null;
      /** 예상 경로를 따라가는 동안 가장 가까워지는 간격(스치듯 지나감 판정) */
      let passGap = Infinity;
      let passQ: { x: number; z: number } | null = null;
      if (dir !== 0) {
        for (let s = SWEEP_STEP; s <= RANK_PATH + 1e-9 && pathDist === null; s += SWEEP_STEP) {
          const fb = futureBody(spec, i.steer, dir, s);
          const inside: { x: number; z: number }[] = [];
          for (const p of e.pts) {
            const q = worldToLocal(fb.x, fb.z, fb.rot, p.lx, p.lz);
            if (Math.abs(q.x) <= body.hw + SWEEP_MARGIN && Math.abs(q.z) <= body.hl + SWEEP_MARGIN) inside.push(q);
            const d = Math.hypot(Math.max(Math.abs(q.x) - body.hw, 0), Math.max(Math.abs(q.z) - body.hl, 0));
            if (d < passGap) [passGap, passQ] = [d, q];
          }
          if (!inside.length) continue;
          pathDist = s;
          const q = inside[0];
          swing = swingAt(q, dir, body);
          contact = contactOf(inside, q, body);
        }
      }
      // v0.6.3: 경로 교차(접촉 여유 0.08m)는 아니지만 지금보다 가까이(≤ 0.3m) 스치며 지나가면 카메라 자격(near-pass).
      // 후진 중 앞 모서리가 기둥 옆 0.2m 로 스윙하는 경우를 놓쳤다(브라우저 e2e-v063 swing-front).
      let nearPass = false;
      // 히스테리시스: 진입은 지금보다 0.02m 이상 가까워질 때, 유지는 멀어지기 시작(지금 + 0.01m 초과)할 때까지.
      // 경계값에서 매 프레임 들락거리면 카메라가 깜빡였다(e2e-v063 swing-front-L, 예상 0.22 = 지금 0.24 − 0.02).
      const was = this.nearPassIds.has(id);
      if (pathDist === null && passQ && passGap <= RANK_VERY_CLOSE && passGap < best.gap + (was ? 0.01 : -0.02)) {
        nearPass = true;
        swing = swingAt(passQ, dir as 1 | -1, body);
        contact = contactOf([], passQ, body);
      }
      if (nearPass) this.nearPassIds.add(id);
      else this.nearPassIds.delete(id);
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
      const relevant = pathDist !== null || nearPass || (ttc !== null && ttc < 2.5);
      if (nearPass && cls > 4) [cls, why] = [4, '스치듯 지나감(예상 간격 매우 좁음)'];
      if (!relevant && cls <= 2) why += ' (경로 밖 — 카메라 유지)';
      out.push({ id, tag: e.tag, cls, gap: g, place, group: groupOf(place), pathDist, swing, closing: cl, ttc, hits: e.pts.length, point: { x: best.x, z: best.z }, local: { x: best.lx, z: best.lz }, contact, relevant, passGap: Number.isFinite(passGap) ? passGap : null, why });
    }
    for (const id of [...this.prev.keys()]) if (!seen.has(id)) {
      this.prev.delete(id);
      this.closing.delete(id);
      this.nearPassIds.delete(id);
    }
    out.sort((a, b) => a.cls - b.cls || a.gap - b.gap || (a.pathDist ?? 99) - (b.pathDist ?? 99));
    return out;
  }
}

/**
 * 카메라 선택에 쓸 1순위(v0.6.3): 자동 카메라 자격(relevant)이 있는 후보 중
 *  1) 경로 교차(실제로 닿음) — 진행 거리가 짧은 순  2) 스치듯 지나감 — 예상 간격이 좁은 순  3) 빠른 접근(TTC)
 * 단순 간격 순(등급 순)으로 고르면, 정차 중 좌회전 때 실제로 부딪칠 왼쪽 앞 기둥보다 꼬리가 스칠 오른쪽 차를 먼저 보여 줬다.
 */
export function cameraTop(list: readonly RiskCandidate[]): RiskCandidate | null {
  let best: RiskCandidate | null = null;
  let bk = Infinity;
  for (const c of list) {
    if (!c.relevant) continue;
    const k = c.pathDist !== null ? c.pathDist : c.passGap !== null && c.passGap <= RANK_VERY_CLOSE ? 10 + c.passGap : 20 + (c.ttc ?? 9);
    if (k < bk) [bk, best] = [k, c];
  }
  return best;
}
