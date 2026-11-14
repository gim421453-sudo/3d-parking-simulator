import { describe, expect, it } from 'vitest';
import { LIFT_TIMES, liftAlignment, liftBlocksDriving, liftChecklist, liftDown, liftStop, liftToWorld, liftUp, liftedPose, makeLift, newLift, stepLift, toLiftLocal, type LiftCarInput } from '../src/service/lift';

const cfg = makeLift({ id: 'l1', x: 10, z: -4, heading: Math.PI / 2 });
const spec = { width: 1.86 };
const ideal = (o: Partial<LiftCarInput> = {}): LiftCarInput => ({ cx: 10, cz: -4, heading: Math.PI / 2, v: 0, gear: 'P', handbrake: true, engineOn: false, ...o });
const run = (s: ReturnType<typeof newLift>, secs: number): void => {
  for (let i = 0; i < secs * 60; i++) stepLift(cfg, s, 1 / 60);
};

describe('2주식 리프트: 정렬/조건', () => {
  it('로컬 변환 왕복, 진입 방향이 로컬 +z', () => {
    const w = liftToWorld(cfg, 0.4, 1.2);
    const l = toLiftLocal(cfg, w.x, w.z);
    expect(l.x).toBeCloseTo(0.4, 9);
    expect(l.z).toBeCloseTo(1.2, 9);
    // heading π/2 = +x 방향이 진입(로컬 +z)
    expect(toLiftLocal(cfg, 11, -4).z).toBeCloseTo(1, 9);
  });
  it('정위치에서 모든 조건 충족, 뒤로 들어온 차량도 방향 허용', () => {
    expect(liftChecklist(cfg, spec, ideal()).every((c) => c.ok)).toBe(true);
    const rev = liftAlignment(cfg, ideal({ heading: -Math.PI / 2 }));
    expect(rev.reversed).toBe(true);
    expect(rev.headingErrDeg).toBeLessThan(0.01);
  });
  it('v0.5.5 완화 후 허용치: 좌우 30cm 치우침/앞뒤 50cm/방향 7°/주행 중/D 단 은 각각 거부되고 이유가 표시된다', () => {
    const cases: [Partial<LiftCarInput>, RegExp][] = [
      [{ cz: -4.3 }, /중앙/],
      [{ cx: 10.5 }, /앞뒤/],
      [{ heading: Math.PI / 2 + 0.125 }, /방향/],
      [{ v: 0.5 }, /정차/],
      [{ gear: 'D' }, /P 단/],
    ];
    for (const [o, re] of cases) {
      const s = newLift();
      expect(liftUp(cfg, spec, ideal(o), s)).toBe(false);
      expect(s.message).toMatch(re);
      expect(s.phase).toBe('idle');
      expect(s.locked).toBe(false);
    }
  });
  it('v0.5.5 조건 완화: 좌우 20cm·앞뒤 40cm·방향 5° 치우침, 주차 브레이크 OFF, 시동 ON 이어도 상승할 수 있다', () => {
    for (const o of [{ cz: -4.2 }, { cx: 10.4 }, { heading: Math.PI / 2 + 0.087 }, { handbrake: false }, { engineOn: true }] as Partial<LiftCarInput>[]) {
      const s = newLift();
      expect(liftUp(cfg, spec, ideal(o), s), JSON.stringify(o)).toBe(true);
      expect(s.phase).not.toBe('idle');
    }
  });
  it('차폭 2.1m 초과 차량은 거부', () => {
    const s = newLift();
    expect(liftUp(cfg, { width: 2.3 }, ideal(), s)).toBe(false);
    expect(s.message).toMatch(/차폭/);
  });
});

describe('2주식 리프트: 승강 상태기계', () => {
  it('상승: 암 전개 → 고정 → 상승 → 최고 높이 정지. 차량은 고정 상태로 리프트 높이를 따른다', () => {
    const s = newLift();
    expect(liftUp(cfg, spec, ideal({ cx: 10.1, cz: -3.95 }), s)).toBe(true);
    expect(s.phase).toBe('armsIn');
    expect(liftBlocksDriving(s)).toBe(true); // 암이 들어오는 동안 이미 주행 불가
    run(s, LIFT_TIMES.arms + 0.1);
    expect(s.locked).toBe(true);
    expect(s.phase).toBe('raising');
    run(s, 2);
    const mid = liftedPose(cfg, s)!;
    expect(mid.y).toBeGreaterThan(0.3);
    expect(mid.y).toBeLessThan(cfg.maxHeight);
    expect(mid.cx).toBeCloseTo(10.1, 9); // 승강 중 수평 위치 불변
    expect(mid.cz).toBeCloseTo(-3.95, 9);
    run(s, 12);
    expect(s.phase).toBe('holding');
    expect(s.h).toBeCloseTo(cfg.maxHeight, 9);
    expect(liftedPose(cfg, s)!.y).toBeCloseTo(cfg.maxHeight, 9);
  });
  it('중간 정지 → 다시 상승 / 하강', () => {
    const s = newLift();
    liftUp(cfg, spec, ideal(), s);
    run(s, LIFT_TIMES.arms + 3);
    expect(liftStop(s)).toBe(true);
    const h = s.h;
    run(s, 2);
    expect(s.h).toBe(h); // 멈춘 높이 유지(떨어지지 않음)
    expect(s.locked).toBe(true);
    expect(liftUp(cfg, spec, ideal(), s)).toBe(true);
    run(s, 1);
    expect(s.h).toBeGreaterThan(h);
    expect(liftDown(s)).toBe(true);
    run(s, 1);
    expect(s.phase).toBe('lowering');
  });
  it('하강: 바닥에 닿은 뒤에만 암이 빠지고 고정이 풀린다 → 출차 가능', () => {
    const s = newLift();
    liftUp(cfg, spec, ideal(), s);
    run(s, 15);
    expect(liftDown(s)).toBe(true);
    let unlockedInAir = false;
    for (let i = 0; i < 15 * 60; i++) {
      stepLift(cfg, s, 1 / 60);
      if (!s.locked && s.h > 1e-6) unlockedInAir = true;
    }
    expect(unlockedInAir).toBe(false);
    expect(s.phase).toBe('idle');
    expect(s.locked).toBe(false);
    expect(s.h).toBe(0);
    expect(s.arms).toBe(0);
    expect(liftBlocksDriving(s)).toBe(false);
    expect(s.cycles).toBe(1);
    expect(liftedPose(cfg, s)).toBeNull();
  });
  it('바닥에서 하강 요청/동작 중 상승 요청은 거부', () => {
    const s = newLift();
    expect(liftDown(s)).toBe(false);
    liftUp(cfg, spec, ideal(), s);
    expect(liftUp(cfg, spec, ideal(), s)).toBe(false);
  });
  it('불변식: 공중에서 고정이 풀린 상태가 되면 강제로 고정한다(차량 낙하 방지)', () => {
    const s = newLift();
    s.h = 1.0;
    s.locked = false;
    stepLift(cfg, s, 1 / 60);
    expect(s.locked).toBe(true);
  });
});

import { LIFT4_DEFAULT, LIFT4_TOL } from '../src/service/lift';
describe('4주식 리프트 (v0.5.5): 주행판 위에 올라선 차량을 주행판째 올린다', () => {
  const c4 = makeLift({ id: 'l4', kind: '4post', x: 5, z: 7, heading: 0 });
  const at = (o: Partial<LiftCarInput> = {}): LiftCarInput => ({ cx: 5, cz: 7, heading: 0, v: 0, gear: 'P', handbrake: true, engineOn: false, ...o });
  it('종류/기본 치수: 기둥 4개 간격(좌우 3.1m, 앞뒤 5.5m), 최고 높이 1.9m', () => {
    expect(c4.kind).toBe('4post');
    expect(makeLift({ id: 'x', x: 0, z: 0, heading: 0 }).kind).toBe('2post');
    expect(c4.postHalf * 2).toBeCloseTo(3.1, 9);
    expect(LIFT4_DEFAULT.postZ * 2).toBeCloseTo(5.5, 9);
    expect(c4.maxHeight).toBe(1.9);
  });
  it('정위치 허용은 2주식보다 넓다(좌우 ±20cm, 앞뒤 ±45cm) — 18cm/40cm 치우쳐도 가능, 25cm 는 거부', () => {
    expect(LIFT4_TOL.lateral).toBeGreaterThan(0.15);
    expect(liftChecklist(c4, spec, at({ cx: 5.18, cz: 7.4 })).every((q) => q.ok)).toBe(true);
    const s = newLift();
    expect(liftUp(c4, spec, at({ cx: 5.25 }), s)).toBe(false);
    expect(s.message).toMatch(/주행판/);
  });
  it('상승 → 최고 높이 1.9m → 하강 → 고정 해제. 승강 중 차량 수평 위치는 그대로', () => {
    const s = newLift();
    expect(liftUp(c4, spec, at({ cx: 5.1 }), s)).toBe(true);
    expect(s.message).toMatch(/고임목/);
    for (let i = 0; i < 20 * 60; i++) stepLift(c4, s, 1 / 60);
    expect(s.phase).toBe('holding');
    const p = liftedPose(c4, s)!;
    expect(p.y).toBeCloseTo(1.9, 9);
    expect(p.cx).toBeCloseTo(5.1, 9);
    liftDown(s);
    for (let i = 0; i < 20 * 60; i++) stepLift(c4, s, 1 / 60);
    expect(s.phase).toBe('idle');
    expect(s.locked).toBe(false);
  });
});
