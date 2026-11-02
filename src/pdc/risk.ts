import type { Obb } from '../core/geometry';
import { worldToLocal } from '../core/math';
import type { SensorSnapshot } from '../sensors/sensorSystem';
import type { SensorGroup, VehicleSpec } from '../vehicle/spec';

/** 점에서 차체 OBB(외곽)까지의 최단 거리 (내부면 0) */
export function pointToObbGap(px: number, pz: number, o: Obb): number {
  const l = worldToLocal(o.x, o.z, o.rot, px, pz);
  const dx = Math.max(Math.abs(l.x) - o.hw, 0);
  const dz = Math.max(Math.abs(l.z) - o.hl, 0);
  return Math.hypot(dx, dz);
}

/**
 * 위험 판단 설정. **경고음/색상 단계(sensorRange·sensorCritical)와 독립**이며 "화면 전환을 언제 준비할지"만 정한다.
 * 값은 실차 공식 수치가 아니라 이 게임의 주차 속도(≈5km/h)에서의 정지 여유로 정했다 (tests/risk.test.ts 참고).
 */
export interface RiskConfig {
  enterGap: Record<SensorGroup, number>; // 이 간격 이하면 위험 후보 (차체 외곽~장애물 표면, m)
  exitGap: Record<SensorGroup, number>; // 이 간격 초과여야 해제 후보 (히스테리시스)
  veryCloseEnter: number; // 이 간격 이하: 측면뷰로는 틈이 안 보임 → 확대 탑뷰
  veryCloseExit: number;
  ttcEnter: number; // 접근 시간(초) 이하면 간격이 더 커도 미리 준비
  ttcMaxGap: number; // TTC 조기 진입이 적용되는 최대 간격
  minClosing: number; // TTC 로 인정하는 최소 접근 속도 (m/s)
  minHits: number; // 신뢰도: 최소 감지 광선 수
  confirmSec: number; // 후보가 이 시간 이상 지속되어야 위험으로 인정
  narrowGap: number; // 좌우 모두 이 간격 이하 → 좁은 공간
}
export const DEFAULT_RISK: RiskConfig = {
  enterGap: { front: 1.6, rear: 1.6, left: 1.3, right: 1.3 },
  exitGap: { front: 2.0, rear: 2.0, left: 1.7, right: 1.7 },
  veryCloseEnter: 0.75, // 측면 3D 뷰로는 틈이 잘 안 보이는 간격
  veryCloseExit: 1.0,
  ttcEnter: 2.5,
  ttcMaxGap: 2.4,
  minClosing: 0.3,
  minHits: 2,
  confirmSec: 0.2,
  narrowGap: 1.6,
};

export interface GroupRisk {
  gap: number | null; // 내부 계산용 (UI 숫자 표시 금지)
  closing: number; // m/s (+ = 접근)
  ttc: number | null;
  threat: boolean;
  veryClose: boolean;
  hits: number;
  pillar: boolean; // 가장 가까운 장애물이 기둥/원기둥형인가
}
export interface RiskOutput {
  groups: Record<SensorGroup, GroupRisk>;
  threatened: SensorGroup[];
  narrow: boolean;
}

/** 전/후방 진행 통로의 좌우 여유 (m): 차체 폭 + 이만큼 안쪽의 물체만 "앞/뒤 위험"으로 본다 (옆 차량/벽은 측면 위험) */
const CORRIDOR_MARGIN = 0.2;
/** 측면 판정이 차체 길이 앞뒤로 더 보는 길이 (m) */
const SIDE_MARGIN = 0.5;
const GROUPS: SensorGroup[] = ['front', 'rear', 'left', 'right'];
const empty = (): GroupRisk => ({ gap: null, closing: 0, ttc: null, threat: false, veryClose: false, hits: 0, pillar: false });

/** 방향별 위험 추적 (상태 보유). 실제 센서 히트점과 차체 외곽 사이 간격 + 접근 속도(TTC)로 판단한다. */
export class RiskTracker {
  private prevGap: Record<SensorGroup, number | null> = { front: null, rear: null, left: null, right: null };
  private closing: Record<SensorGroup, number> = { front: 0, rear: 0, left: 0, right: 0 };
  private cand: Record<SensorGroup, number> = { front: 0, rear: 0, left: 0, right: 0 };
  private threat: Record<SensorGroup, boolean> = { front: false, rear: false, left: false, right: false };
  private vclose: Record<SensorGroup, boolean> = { front: false, rear: false, left: false, right: false };

  constructor(private cfg: RiskConfig = DEFAULT_RISK) {}

  reset(): void {
    for (const g of GROUPS) {
      this.prevGap[g] = null;
      this.closing[g] = 0;
      this.cand[g] = 0;
      this.threat[g] = false;
      this.vclose[g] = false;
    }
  }

  update(dt: number, snap: SensorSnapshot | null, body: Obb, spec: VehicleSpec): RiskOutput {
    const out: Record<SensorGroup, GroupRisk> = { front: empty(), rear: empty(), left: empty(), right: empty() };
    if (!snap) {
      this.reset();
      return { groups: out, threatened: [], narrow: false };
    }
    const gap: Record<SensorGroup, number | null> = { front: null, rear: null, left: null, right: null };
    const hits: Record<SensorGroup, number> = { front: 0, rear: 0, left: 0, right: 0 };
    const pillar: Record<SensorGroup, boolean> = { front: false, rear: false, left: false, right: false };
    // 히트점을 센서 그룹이 아니라 "차체 기준 위치"로 방향에 배정한다.
    // 전/후: 차체 폭 + 여유 안쪽의 정면(진행 통로), 좌/우: 차체 길이 + 여유 안쪽의 측면.
    // 옆 벽이 앞으로 계속 이어져도 전방 위험으로 오인하지 않고, 통로 밖 모서리는 무시한다.
    const hw = body.hw;
    const hl = body.hl;
    spec.sensors.forEach((_m, i) => {
      const r = snap.readings[i];
      if (!r) return;
      for (const h of r.hits) {
        const l = worldToLocal(body.x, body.z, body.rot, h.x, h.z);
        let g: SensorGroup | null = null;
        if (Math.abs(l.x) <= hw + CORRIDOR_MARGIN && l.z > hl) g = 'front';
        else if (Math.abs(l.x) <= hw + CORRIDOR_MARGIN && l.z < -hl) g = 'rear';
        else if (l.x > hw && Math.abs(l.z) <= hl + SIDE_MARGIN) g = 'left';
        else if (l.x < -hw && Math.abs(l.z) <= hl + SIDE_MARGIN) g = 'right';
        if (!g) continue;
        hits[g]++;
        const d = pointToObbGap(h.x, h.z, body);
        const cur = gap[g];
        if (cur === null || d < cur) {
          gap[g] = d;
          pillar[g] = h.tag === 'pillar' || h.tag === 'cone' || h.tag === 'drum' || h.tag === 'lamp' || h.tag === 'tree';
        }
      }
    });
    const c = this.cfg;
    for (const g of GROUPS) {
      const gp = gap[g];
      // 접근 속도: 간격 변화율 (지수 평활)
      if (gp !== null && this.prevGap[g] !== null && dt > 0) {
        const inst = (this.prevGap[g]! - gp) / dt;
        this.closing[g] += (inst - this.closing[g]) * Math.min(1, dt * 5);
      } else this.closing[g] *= Math.max(0, 1 - dt * 5);
      this.prevGap[g] = gp;
      const closing = this.closing[g];
      const ttc = gp !== null && closing > c.minClosing ? gp / closing : null;
      const enough = hits[g] >= c.minHits;
      const gapNear = gp !== null && gp <= (this.threat[g] ? c.exitGap[g] : c.enterGap[g]);
      const ttcNear = ttc !== null && ttc <= c.ttcEnter && gp! <= c.ttcMaxGap;
      const want = enough && (gapNear || ttcNear);
      if (want) this.cand[g] += dt;
      else this.cand[g] = 0;
      if (!want) this.threat[g] = false;
      else if (this.cand[g] >= c.confirmSec) this.threat[g] = true;
      const vc = gp !== null && enough && gp <= (this.vclose[g] ? c.veryCloseExit : c.veryCloseEnter);
      this.vclose[g] = vc;
      out[g] = { gap: gp, closing, ttc, threat: this.threat[g], veryClose: vc, hits: hits[g], pillar: pillar[g] };
    }
    const lg = out.left.gap;
    const rg = out.right.gap;
    const narrow = lg !== null && rg !== null && lg <= c.narrowGap && rg <= c.narrowGap && out.left.hits >= c.minHits && out.right.hits >= c.minHits;
    return { groups: out, threatened: GROUPS.filter((g) => out[g].threat), narrow };
  }
}
