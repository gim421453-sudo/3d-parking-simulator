import { describe, expect, it } from 'vitest';
import { LEVELING_DEADBAND, LEVELING_MAX, computeLighting, levelingTarget, nextLightMode, stepLeveling } from '../src/vehicle/lighting';

describe('조명 모드 규칙', () => {
  it('OFF: 주행 중 DRL 100%, 하향등 OFF / P 에서는 DRL 도 꺼짐', () => {
    expect(computeLighting({ mode: 'off', gear: 'D', ambientDark: false })).toMatchObject({ drl: 1, low: false, high: false, tail: 0 });
    expect(computeLighting({ mode: 'off', gear: 'P', ambientDark: false }).drl).toBe(0);
  });
  it('미등: DRL 100%, 하향등 OFF, 후미등 ON', () => {
    expect(computeLighting({ mode: 'position', gear: 'D', ambientDark: false })).toMatchObject({ drl: 1, low: false, high: false, tail: 1 });
  });
  it('하향등: DRL 30%, 하향등 ON, 상향등 OFF', () => {
    expect(computeLighting({ mode: 'low', gear: 'D', ambientDark: false })).toMatchObject({ drl: 0.3, low: true, high: false, tail: 1 });
  });
  it('상향등: DRL 30%, 하향등 + 상향등 ON', () => {
    expect(computeLighting({ mode: 'high', gear: 'D', ambientDark: false })).toMatchObject({ drl: 0.3, low: true, high: true });
  });
  it('AUTO: 어두우면 하향등 규칙, 밝으면 OFF 규칙 (상향등은 자동으로 켜지지 않음)', () => {
    const dark = computeLighting({ mode: 'auto', gear: 'D', ambientDark: true });
    const day = computeLighting({ mode: 'auto', gear: 'D', ambientDark: false });
    expect(dark).toMatchObject({ effective: 'low', low: true, high: false });
    expect(day).toMatchObject({ effective: 'off', low: false, drl: 1 });
  });
  it('모드 순환: OFF→미등→하향등→상향등→AUTO→OFF', () => {
    let m = 'off' as ReturnType<typeof nextLightMode>;
    const seq = [m];
    for (let i = 0; i < 5; i++) seq.push((m = nextLightMode(m)));
    expect(seq).toEqual(['off', 'position', 'low', 'high', 'auto', 'off']);
  });
});

describe('AUTO Leveling (가속도 기반 근사)', () => {
  it('가속하면 빔을 아래(−), 제동하면 위(+)로 보정한다', () => {
    expect(levelingTarget(2)).toBeLessThan(0);
    expect(levelingTarget(-4)).toBeGreaterThan(0);
  });
  it('데드밴드 이내의 작은 가속도에는 반응하지 않는다 (떨림 방지)', () => {
    expect(levelingTarget(LEVELING_DEADBAND * 0.9)).toBe(0);
    expect(levelingTarget(-LEVELING_DEADBAND * 0.9)).toBe(0);
  });
  it('보정 각도는 한계(±2°)를 넘지 않는다', () => {
    expect(Math.abs(levelingTarget(100))).toBeLessThanOrEqual(LEVELING_MAX);
    expect(Math.abs(levelingTarget(-100))).toBeLessThanOrEqual(LEVELING_MAX);
  });
  it('부드럽게 변한다: 한 스텝에 목표로 점프하지 않고 점차 수렴한다', () => {
    let a = 0;
    a = stepLeveling(a, -6, 1 / 60);
    const t = levelingTarget(-6);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(t * 0.1);
    for (let i = 0; i < 60 * 3; i++) a = stepLeveling(a, -6, 1 / 60);
    expect(a).toBeCloseTo(t, 3);
  });
  it('가속도가 사라지면 0 으로 복귀하고 진동하지 않는다', () => {
    let a = 0;
    for (let i = 0; i < 120; i++) a = stepLeveling(a, 3, 1 / 60);
    let prev = a;
    let flips = 0;
    for (let i = 0; i < 300; i++) {
      const n = stepLeveling(prev, 0, 1 / 60);
      if ((n - prev) * (prev - a) < 0) flips++;
      prev = n;
    }
    expect(Math.abs(prev)).toBeLessThan(1e-3);
    expect(flips).toBe(0);
  });
  it('하중이 크면 약간 더 아래로 보정된다', () => {
    expect(levelingTarget(0, 1)).toBeLessThan(levelingTarget(0, 0));
  });
});
