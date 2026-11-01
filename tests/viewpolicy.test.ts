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
