import { describe, expect, it } from 'vitest';
import { gateViewRisk } from '../src/pdc/viewGate';
import { ViewPolicy, type SideObservation } from '../src/pdc/viewPolicy';

const base = (o: Partial<{ l: boolean; r: boolean; f: boolean; b: boolean; vcF: boolean; vcB: boolean; gl: number | null; gr: number | null }> = {}) => ({
  threat: { front: !!o.f, rear: !!o.b, left: !!o.l, right: !!o.r },
  veryClose: { front: !!o.vcF, rear: !!o.vcB, left: false, right: false },
  gap: { front: 0.5, rear: 0.5, left: o.gl ?? 0.5, right: o.gr ?? 0.5 },
});
const ctx = (p: Partial<{ gear: 'D' | 'R'; v: number; steer: number; pathCut: number }> = {}) => ({ gear: 'D' as const, v: 1, steer: 0, pathCut: 4.5, ...p });

describe('자동 시점 후보 게이트 (v0.4.9: 카메라 전환 빈도 감소)', () => {
  it('나란히 선 벽/차량(옆 위험 + 직진)만으로는 측면뷰 후보가 되지 않는다', () => {
    expect(gateViewRisk(base({ l: true }), ctx()).threat.left).toBe(false);
    expect(gateViewRisk(base({ r: true }), ctx({ steer: 0.05 })).threat.right).toBe(false);
  });
  it('그 쪽으로 조향하며 움직이고 간격이 좁을 때만 측면뷰 후보', () => {
    expect(gateViewRisk(base({ l: true }), ctx({ steer: 0.3 })).threat.left).toBe(true);
    expect(gateViewRisk(base({ r: true }), ctx({ steer: -0.3 })).threat.right).toBe(true);
    expect(gateViewRisk(base({ l: true }), ctx({ steer: -0.3 })).threat.left).toBe(false); // 반대쪽 조향
    expect(gateViewRisk(base({ l: true }), ctx({ steer: 0.3, v: 0.1 })).threat.left).toBe(false); // 거의 정지
    expect(gateViewRisk(base({ l: true, gl: 1.4 }), ctx({ steer: 0.3 })).threat.left).toBe(false); // 아직 여유
  });
  it('집중 탑뷰는 매우 가까운 장애물이 예상 경로 위일 때만 (경로가 비어 있으면 기본 카메라 유지)', () => {
    expect(gateViewRisk(base({ f: true, vcF: true }), ctx({ pathCut: 1.0 })).veryClose.front).toBe(true);
    expect(gateViewRisk(base({ f: true, vcF: true }), ctx({ pathCut: 4.5 })).veryClose.front).toBe(false);
    expect(gateViewRisk(base({ b: true, vcB: true }), ctx({ gear: 'R', pathCut: 1.2 })).veryClose.rear).toBe(true);
    expect(gateViewRisk(base({ b: true, vcB: true }), ctx({ gear: 'R', pathCut: 4.5 })).veryClose.rear).toBe(false);
  });
  it('정책과 결합: 좁은 통로를 직진으로 통과하는 동안(양쪽 벽) 시점 전환 0회', () => {
    const pol = new ViewPolicy();
    let switches = 0;
    let last = 'front';
    for (let t = 0; t < 12; t += 0.05) {
      const g = gateViewRisk(base({ l: true, r: true, gl: 0.4, gr: 0.4 }), ctx({ steer: 0.02 }));
      const obs: SideObservation = { level: { left: 'near', right: 'near', front: 'none', rear: 'none' }, hits: { left: 6, right: 6, front: 0, rear: 0 }, risk: { ...g, pillar: { front: false, rear: false, left: false, right: false }, narrow: true, sideBlocked: { left: false, right: false } } };
      const d = pol.update(0.05, 'front', null, obs, true);
      if (d.view !== last) switches++;
      last = d.view;
    }
    expect(switches).toBe(0);
    expect(last).toBe('front');
  });
});
