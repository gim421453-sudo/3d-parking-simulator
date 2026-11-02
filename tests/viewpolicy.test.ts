import { describe, expect, it } from 'vitest';
import { ViewPolicy, type SideObservation, DEFAULT_VIEW_POLICY } from '../src/pdc/viewPolicy';
import type { ProximityLevel } from '../src/sensors/sensorSystem';

const obs = (l: ProximityLevel = 'none', r: ProximityLevel = 'none', hits = 6, f: ProximityLevel = 'none', b: ProximityLevel = 'none'): SideObservation => ({
  level: { left: l, right: r, front: f, rear: b },
  hits: { left: l === 'none' ? 0 : hits, right: r === 'none' ? 0 : hits, front: f === 'none' ? 0 : hits, rear: b === 'none' ? 0 : hits },
});
/** dt=0.05 로 sec 초 동안 갱신, 마지막 결정 반환 */
const run = (p: ViewPolicy, sec: number, o: SideObservation | null, base: 'rear' | 'front' = 'rear', manual: any = null, enabled = true) => {
  let d = p.update(0.05, base, manual, o, enabled);
  for (let t = 0.05; t < sec; t += 0.05) d = p.update(0.05, base, manual, o, enabled);
  return d;
};

describe('자동 3D 시점 정책', () => {
  it('측면 장애물이 없으면 기본(후방/전방) 시점', () => {
    expect(run(new ViewPolicy(), 3, obs()).view).toBe('rear');
    expect(run(new ViewPolicy(), 3, obs(), 'front').view).toBe('front');
  });
  it('전방/후방 장애물만 있으면 기본 시점 우선 (측면으로 가지 않음)', () => {
    expect(run(new ViewPolicy(), 3, obs('none', 'none', 6, 'critical', 'critical')).view).toBe('rear');
  });
  it('좌측 근접 → left, 우측 근접 → right, 양측 → top', () => {
    expect(run(new ViewPolicy(), 1, obs('near')).view).toBe('left');
    expect(run(new ViewPolicy(), 1, obs('none', 'critical')).view).toBe('right');
    expect(run(new ViewPolicy(), 1, obs('near', 'near')).view).toBe('top');
  });
  it('멀리(far/mid) 있는 장애물로는 전환하지 않는다 (진입은 near 이상)', () => {
    expect(run(new ViewPolicy(), 2, obs('mid')).view).toBe('rear');
    expect(run(new ViewPolicy(), 2, obs('far')).view).toBe('rear');
  });
  it('신뢰도: 광선이 2개 이하로만 맞으면 무시한다', () => {
    expect(run(new ViewPolicy(), 2, obs('critical', 'none', 2)).view).toBe('rear');
  });
  it('확인 지연: 아주 짧은 순간(<0.3s)의 감지로는 전환하지 않는다', () => {
    const p = new ViewPolicy();
    run(p, 0.2, obs('near'));
    expect(run(p, 0.1, obs()).view).toBe('rear');
  });
  it('해제: 장애물이 사라져도 releaseSec 동안은 유지하다가 원래 시점으로 복귀', () => {
    const p = new ViewPolicy();
    run(p, 1, obs('near'));
    expect(run(p, 0.5, obs()).view).toBe('left');
    expect(run(p, 2.0, obs()).view).toBe('rear');
  });
  it('히스테리시스: near 로 진입한 뒤 mid 수준으로 약해져도 시점을 유지한다 (경계 플리커 방지)', () => {
    const p = new ViewPolicy();
    run(p, 1, obs('near'));
    expect(run(p, 3, obs('mid')).view).toBe('left');
  });
  it('경계에서 near↔mid 로 계속 흔들려도 전환 횟수가 늘지 않는다', () => {
    const p = new ViewPolicy();
    for (let i = 0; i < 100; i++) p.update(0.05, 'rear', null, obs(i % 2 ? 'near' : 'mid'), true);
    expect(p.switches).toBeLessThanOrEqual(1);
  });
  it('한 번 복귀한 직후에는 쿨다운/확인 지연 때문에 즉시 재전환하지 않는다', () => {
    const p = new ViewPolicy();
    run(p, 1, obs('near'));
    run(p, 3, obs());
    const before = p.switches;
    p.update(0.05, 'rear', null, obs('near'), true);
    expect(p.switches).toBe(before);
  });
  it('수동 시점이 항상 우선: 자동 전환이 끼어들지 않는다', () => {
    const p = new ViewPolicy();
    expect(run(p, 2, obs('critical', 'critical'), 'rear', 'front').view).toBe('front');
    expect(run(p, 2, obs('critical'), 'rear', 'oblique').auto).toBe(false);
  });
  it('수동 해제 후에는 다시 자동 정책을 따른다', () => {
    const p = new ViewPolicy();
    run(p, 1, obs('near'), 'rear', 'top');
    expect(run(p, 1, obs('near'), 'rear', null).view).toBe('left');
  });
  it('자동 전환을 끄면 항상 기본 시점', () => {
    expect(run(new ViewPolicy(), 2, obs('critical'), 'rear', null, false).view).toBe('rear');
  });
  it('설정값 기본: 진입 near, 해제 mid 미만', () => {
    expect(DEFAULT_VIEW_POLICY.enterRank).toBeGreaterThan(DEFAULT_VIEW_POLICY.exitRank);
  });
});

import { ViewPolicy as VP2, type ViewRisk } from '../src/pdc/viewPolicy';

describe('간격/접근속도 기반 시점 정책 (risk)', () => {
  const none = () => ({ front: false, rear: false, left: false, right: false });
  const mk = (o: Partial<{ threat: Partial<ViewRisk['threat']>; veryClose: Partial<ViewRisk['veryClose']>; pillar: Partial<ViewRisk['pillar']>; narrow: boolean; blocked: Partial<ViewRisk['sideBlocked']> }>): ViewRisk => ({
    threat: { ...none(), ...o.threat },
    veryClose: { ...none(), ...o.veryClose },
    pillar: { ...none(), ...o.pillar },
    narrow: o.narrow ?? false,
    sideBlocked: { left: false, right: false, ...o.blocked },
  });
  const obs = (r: ViewRisk) => ({ level: { front: 'none', rear: 'none', left: 'none', right: 'none' } as never, hits: { front: 0, rear: 0, left: 0, right: 0 }, risk: r });
  const settle = (p: InstanceType<typeof VP2>, r: ViewRisk, base: 'rear' | 'front' = 'rear', sec = 3) => {
    let d = p.update(0.05, base, null, obs(r), true);
    for (let t = 0; t < sec; t += 0.05) d = p.update(0.05, base, null, obs(r), true);
    return d;
  };
  it('왼쪽만 → 좌측뷰, 오른쪽만 → 우측뷰', () => {
    expect(settle(new VP2(), mk({ threat: { left: true } })).view).toBe('left');
    expect(settle(new VP2(), mk({ threat: { right: true } })).view).toBe('right');
  });
  it('양쪽(주차 차량 사이/좁은 공간) → 전체 탑뷰', () => {
    expect(settle(new VP2(), mk({ threat: { left: true, right: true } })).view).toBe('top');
    expect(settle(new VP2(), mk({ narrow: true, threat: { left: true } })).view).toBe('top');
  });
  it('한쪽 측면 + 전/후방 동시 위험 → 전체 탑뷰', () => {
    expect(settle(new VP2(), mk({ threat: { left: true, front: true } })).view).toBe('top');
    expect(settle(new VP2(), mk({ threat: { right: true, rear: true } }), 'rear').view).toBe('top');
  });
  it('매우 가까운 측면 / 기둥 옆 → 확대 탑뷰', () => {
    expect(settle(new VP2(), mk({ threat: { left: true }, veryClose: { left: true } })).view).toBe('topZoom');
    expect(settle(new VP2(), mk({ threat: { right: true }, pillar: { right: true } })).view).toBe('topZoom');
  });
  it('측면 틈이 가려지면(sideBlocked) 측면뷰 대신 전체 탑뷰', () => {
    expect(settle(new VP2(), mk({ threat: { left: true }, blocked: { left: true } })).view).toBe('top');
  });
  it('전방/후방만 위험하면 기본 시점 유지', () => {
    expect(settle(new VP2(), mk({ threat: { rear: true } }), 'rear').view).toBe('rear');
    expect(settle(new VP2(), mk({ threat: { front: true } }), 'front').view).toBe('front');
  });
  it('위험이 사라지면 지연 후 기본 시점으로 복귀하고 그 전에는 유지', () => {
    const p = new VP2();
    expect(settle(p, mk({ threat: { left: true } })).view).toBe('left');
    expect(p.update(0.05, 'rear', null, obs(mk({})), true).view).toBe('left');
    expect(settle(p, mk({}), 'rear', 4).view).toBe('rear');
  });
  it('수동 시점은 항상 우선', () => {
    const p = new VP2();
    const d = p.update(0.05, 'rear', 'front', obs(mk({ threat: { left: true, right: true } })), true);
    expect(d.view).toBe('front');
    expect(d.auto).toBe(false);
  });
  it('경계에서 깜빡이면 반복 전환하지 않는다 (전환 횟수 제한)', () => {
    const p = new VP2();
    for (let i = 0; i < 400; i++) {
      const on = Math.floor(i / 3) % 2 === 0; // 0.15초 주기로 위험 on/off
      p.update(0.05, 'rear', null, obs(mk(on ? { threat: { left: true } } : {})), true);
    }
    expect(p.switches).toBeLessThan(12);
  });
});
