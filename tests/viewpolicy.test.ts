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
  it('좌측 근접 → left, 우측 근접 → right, 양측(레거시 입력) → 왼쪽 (메인 카메라는 전체 탑뷰를 쓰지 않음)', () => {
    expect(run(new ViewPolicy(), 1, obs('near')).view).toBe('left');
    expect(run(new ViewPolicy(), 1, obs('none', 'critical')).view).toBe('right');
    expect(run(new ViewPolicy(), 1, obs('near', 'near')).view).not.toBe('top');
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
  it('양쪽 위험: 메인 카메라는 전체 탑뷰로 가지 않고 더 가까운 쪽 측면뷰 (전체 상황은 오른쪽 서라운드뷰 몫)', () => {
    const near = (l: number, r: number) => ({ ...mk({ threat: { left: true, right: true }, narrow: true }), gap: { front: null, rear: null, left: l, right: r } });
    expect(settle(new VP2(), near(0.6, 1.1)).view).toBe('left');
    expect(settle(new VP2(), near(1.1, 0.6)).view).toBe('right');
    for (const v of ['top', 'topZoom', 'oblique']) expect(settle(new VP2(), near(0.6, 0.6)).view).not.toBe(v);
  });
  it('진행 방향 우선: D 에서 전방+측면 위험이면 전방을 먼저(전방 카메라 유지), R 에서 후방+측면이면 후방 먼저', () => {
    expect(settle(new VP2(), mk({ threat: { left: true, front: true } }), 'front').view).toBe('front');
    expect(settle(new VP2(), mk({ threat: { right: true, rear: true } }), 'rear').view).toBe('rear');
    expect(settle(new VP2(), mk({ threat: { left: true, right: true, front: true } }), 'front').view).toBe('front');
  });
  it('진행 방향이 아주 가까우면 그 방향 집중 탑뷰 (전방/후방)', () => {
    expect(settle(new VP2(), mk({ threat: { front: true }, veryClose: { front: true } }), 'front').view).toBe('topFront');
    expect(settle(new VP2(), mk({ threat: { rear: true }, veryClose: { rear: true } }), 'rear').view).toBe('topRear');
  });
  it('반대 방향 위험은 시점을 바꾸지 않는다 (D 에서 후방만 위험 → 전방 카메라 유지, 측면은 그대로 처리)', () => {
    expect(settle(new VP2(), mk({ threat: { rear: true } }), 'front').view).toBe('front');
    expect(settle(new VP2(), mk({ threat: { rear: true, left: true } }), 'front').view).toBe('left');
  });
  it('자동 전환 꺼짐(N/P 등 enabled=false)이면 위험이 있어도 기본 시점', () => {
    const p = new VP2();
    let d = p.update(0.05, 'front', null, obs(mk({ threat: { left: true, right: true } })), false);
    for (let i = 0; i < 80; i++) d = p.update(0.05, 'front', null, obs(mk({ threat: { left: true, right: true } })), false);
    expect(d.view).toBe('front');
  });
  it('매우 가까운 측면 / 기둥 옆 → 해당 측면 집중뷰(좌/우 독립)', () => {
    expect(settle(new VP2(), mk({ threat: { left: true }, veryClose: { left: true } })).view).toBe('left');
    expect(settle(new VP2(), mk({ threat: { right: true }, pillar: { right: true } })).view).toBe('right');
  });
  it('측면 틈이 가려지면 가려진 쪽은 제외 (다른 쪽 위험이 없으면 기본 시점)', () => {
    expect(settle(new VP2(), mk({ threat: { left: true }, blocked: { left: true } })).view).toBe('rear');
    expect(settle(new VP2(), mk({ threat: { left: true, right: true }, blocked: { left: true } })).view).toBe('right');
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

describe('기어 변경과 집중 탑뷰 (v0.4.8)', () => {
  const risk = (front: boolean, rear: boolean) => ({
    risk: {
      threat: { front, rear, left: false, right: false },
      veryClose: { front, rear, left: false, right: false },
      pillar: { front: false, rear: false, left: false, right: false },
      narrow: false,
      sideBlocked: { left: false, right: false },
    },
    level: { left: 'none', right: 'none', front: front ? 'critical' : 'none', rear: rear ? 'critical' : 'none' },
    hits: { left: 0, right: 0, front: front ? 6 : 0, rear: rear ? 6 : 0 },
  } as SideObservation);
  it('전방 집중 탑뷰 중 R 로 바뀌면 지연 없이 즉시 후방(기본) 카메라', () => {
    const p = new ViewPolicy();
    expect(run(p, 1, risk(true, false), 'front').view).toBe('topFront');
    const d = p.update(0.05, 'rear', null, risk(true, false), true);
    expect(d.view).toBe('rear');
  });
  it('후방 집중 탑뷰 중 D 로 바뀌면 즉시 전방(기본) 카메라', () => {
    const p = new ViewPolicy();
    expect(run(p, 1, risk(false, true), 'rear').view).toBe('topRear');
    expect(p.update(0.05, 'front', null, risk(false, true), true).view).toBe('front');
  });
  it('위험이 사라지면 약 0.8초 안에 집중 탑뷰에서 기본 전/후방 카메라로 복귀 (측면뷰 해제보다 빠름)', () => {
    const p = new ViewPolicy();
    run(p, 1, risk(true, false), 'front');
    expect(run(p, 0.4, risk(false, false), 'front').view).toBe('topFront');
    expect(run(p, 0.8, risk(false, false), 'front').view).toBe('front');
  });
  it('센서가 잠깐(0.2초) 끊겨도 반복 전환하지 않는다', () => {
    const p = new ViewPolicy();
    run(p, 1, risk(true, false), 'front');
    run(p, 0.2, risk(false, false), 'front');
    expect(run(p, 1, risk(true, false), 'front').view).toBe('topFront');
    expect(p.switches).toBe(1);
  });
  it('자동 판단이 꺼져 있으면(기어 변경 직후, 이동 전) 위험이 있어도 기본 카메라', () => {
    expect(run(new ViewPolicy(), 2, risk(true, false), 'front', null, false).view).toBe('front');
  });
});
