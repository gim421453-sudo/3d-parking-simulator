import { describe, expect, it } from 'vitest';
import { ENGINE_PROFILES, engineOn, newEngine, powerOn, pressStartStop, profileOf, stepEngine, type Engine } from '../src/vehicle/engine';
import { createVehicleState, stepVehicle } from '../src/vehicle/physics';
import { SELECTABLE_VEHICLES, VEHICLES } from '../src/vehicle/spec';

const sedan = VEHICLES[1];
const ctx = (o: Partial<{ speed: number; gear: 'P' | 'R' | 'N' | 'D'; brake: number }> = {}) => ({ speed: 0, gear: 'P' as const, brake: 1, ...o });
const run = (e: Engine, secs: number, i: { throttle: number; speed: number; gear: 'P' | 'R' | 'N' | 'D' } = { throttle: 0, speed: 0, gear: 'P' }): void => {
  for (let k = 0; k < secs * 60; k++) stepEngine(e, 1 / 60, i);
};

describe('엔진 시동 상태기계', () => {
  it('OFF → 조건 충족 시 STARTING → RUNNING(공회전 RPM), 시동 중에는 구동력 없음', () => {
    const e = newEngine(ENGINE_PROFILES.sedan, false);
    expect(e.state).toBe('OFF');
    expect(pressStartStop(e, ctx()).ok).toBe(true);
    expect(e.state).toBe('STARTING');
    expect(powerOn(e)).toBe(false);
    run(e, 0.5);
    expect(e.state).toBe('STARTING');
    run(e, 1.2);
    expect(e.state).toBe('RUNNING');
    run(e, 2);
    expect(e.rpm).toBeCloseTo(e.profile.idle, -1);
    expect(powerOn(e)).toBe(true);
  });
  it('시동 조건: 정차 / P 또는 N / 브레이크 입력 — 하나라도 어긋나면 거부하고 이유를 준다', () => {
    const e = newEngine(ENGINE_PROFILES.sedan, false);
    expect(pressStartStop(e, ctx({ speed: 3 })).reason).toContain('정차');
    expect(pressStartStop(e, ctx({ gear: 'D' })).reason).toContain('P 또는 N');
    expect(pressStartStop(e, ctx({ gear: 'R' })).ok).toBe(false);
    expect(pressStartStop(e, ctx({ brake: 0 })).reason).toContain('브레이크');
    expect(e.state).toBe('OFF');
    expect(pressStartStop(e, ctx({ gear: 'N' })).ok).toBe(true);
  });
  it('v0.5.5 조건 완화: 정차만 했으면 D/R 에서도 시동을 끌 수 있고 P 자동 변속(autoPark)을 알린다. 주행 중에는 여전히 거부', () => {
    for (const gear of ['D', 'R'] as const) {
      const e = newEngine(ENGINE_PROFILES.sedan, true);
      expect(pressStartStop(e, ctx({ speed: 5, gear })).ok).toBe(false);
      expect(e.state).toBe('RUNNING');
      const r = pressStartStop(e, ctx({ gear }));
      expect(r.ok).toBe(true);
      expect(r.autoPark).toBe(true);
      expect(r.reason).toMatch(/P 단 자동/);
      expect(e.state).toBe('STOPPING');
    }
    const p = newEngine(ENGINE_PROFILES.sedan, true);
    expect(pressStartStop(p, ctx()).autoPark).toBe(false);
  });
  it('시동 종료: 정차 상태에서만, STOPPING 동안 RPM 하강 후 OFF, RPM 0, 동력 차단', () => {
    const e = newEngine(ENGINE_PROFILES.sedan, true);
    expect(pressStartStop(e, ctx({ speed: 5, gear: 'D' })).ok).toBe(false);
    expect(e.state).toBe('RUNNING');
    expect(pressStartStop(e, ctx()).ok).toBe(true);
    expect(e.state).toBe('STOPPING');
    expect(powerOn(e)).toBe(false);
    run(e, 0.4);
    expect(e.rpm).toBeLessThan(ENGINE_PROFILES.sedan.idle);
    run(e, 1.5);
    expect(e.state).toBe('OFF');
    expect(e.rpm).toBe(0);
    expect(engineOn(e)).toBe(false);
  });
  it('RPM: 스로틀 입력과 속도에 따라 상승, 레드라인 이하, 감속하면 공회전으로 복귀', () => {
    const e = newEngine(ENGINE_PROFILES.coupe, true);
    run(e, 3, { throttle: 0, speed: 0, gear: 'D' });
    const idle = e.rpm;
    run(e, 1, { throttle: 1, speed: 20, gear: 'D' });
    expect(e.rpm).toBeGreaterThan(idle + 1500);
    expect(e.rpm).toBeLessThanOrEqual(e.profile.redline);
    run(e, 6, { throttle: 0, speed: 0, gear: 'D' });
    expect(e.rpm).toBeCloseTo(e.profile.idle, -1);
    run(e, 1, { throttle: 1, speed: 0, gear: 'P' }); // 주차 중 공회전 레빙
    expect(e.rpm).toBeGreaterThan(idle + 800);
  });
  it('차종별 합성 프로필(BMW 계열도 합성): 소형 3기통/세단 4/SUV·X6 6/쿠페·M4 6(고회전)', () => {
    const by = (id: string) => profileOf(SELECTABLE_VEHICLES.find((v) => v.id === id)!);
    expect(by('compact').cylinders).toBe(3);
    expect(by('sedan').cylinders).toBe(4);
    expect(by('suv-x6').id).toBe('suv');
    expect(by('coupe-m4').id).toBe('coupe');
    expect(by('coupe-m4').redline).toBeGreaterThan(by('sedan').redline);
    for (const p of Object.values(ENGINE_PROFILES)) expect(p.label).toContain('합성');
  });
});

describe('시동 OFF 와 주행 물리', () => {
  it('엔진 OFF(engineOn=false)에서는 가속페달/크리프/엔진 브레이크가 없다 — 앞으로 움직이지 않는다', () => {
    const s = createVehicleState(sedan, 0, 0, 0);
    s.gear = 'D';
    s.handbrake = false;
    for (let i = 0; i < 600; i++) stepVehicle(s, { throttle: 1, brake: 0, steerInput: 0, engineOn: false }, sedan, 1 / 60);
    expect(Math.abs(s.v)).toBeLessThan(1e-9);
    const t = createVehicleState(sedan, 0, 0, 0);
    t.gear = 'D';
    t.handbrake = false;
    for (let i = 0; i < 600; i++) stepVehicle(t, { throttle: 1, brake: 0, steerInput: 0 }, sedan, 1 / 60);
    expect(t.v).toBeGreaterThan(5); // engineOn 생략(기본) = 기존 동작
  });
  it('엔진 OFF 로 구르는 중이면 크리프 없이 마찰로만 감속한다', () => {
    const s = createVehicleState(sedan, 0, 0, 0);
    s.gear = 'D';
    s.handbrake = false;
    s.v = 2;
    for (let i = 0; i < 60 * 30; i++) stepVehicle(s, { throttle: 0, brake: 0, steerInput: 0, engineOn: false }, sedan, 1 / 60);
    expect(s.v).toBeLessThan(0.05);
  });
});

import { engineSoundParams } from '../src/audio/engineSound';
describe('엔진음 합성 파라미터 (RPM/스로틀/상태/실내외/볼륨 연동)', () => {
  const mk = (rpm: number, state: Engine['state'] = 'RUNNING', prof = ENGINE_PROFILES.sedan): Engine => ({ state, rpm, t: 0, profile: prof, starts: 0, stops: 0 });
  it('기본 주파수 = rpm/60 × 실린더/2, RPM 상승에 비례', () => {
    const lo = engineSoundParams(mk(750), 0, false, 0.5);
    const hi = engineSoundParams(mk(3000), 0, false, 0.5);
    expect(lo.f0).toBeCloseTo((750 / 60) * 2, 6);
    expect(hi.f0).toBeCloseTo(4 * lo.f0, 6);
    expect(engineSoundParams(mk(3000, 'RUNNING', ENGINE_PROFILES.suv), 0, false, 0.5).f0).toBeCloseTo((3000 / 60) * 3, 6);
  });
  it('스로틀 부하가 커지면 거친 고조파/노이즈/차단주파수/마스터가 증가', () => {
    const idle = engineSoundParams(mk(2000), 0, false, 0.5);
    const load = engineSoundParams(mk(2000), 1, false, 0.5);
    expect(load.gains.square).toBeGreaterThan(idle.gains.square);
    expect(load.gains.noise).toBeGreaterThan(idle.gains.noise);
    expect(load.cutoff).toBeGreaterThan(idle.cutoff);
    expect(load.master).toBeGreaterThan(idle.master);
  });
  it('스포츠 프로필은 세단보다 거친 고조파(rough)가 크다', () => {
    const s = engineSoundParams(mk(3000, 'RUNNING', ENGINE_PROFILES.sedan), 0.8, false, 0.5);
    const c = engineSoundParams(mk(3000, 'RUNNING', ENGINE_PROFILES.coupe), 0.8, false, 0.5);
    expect(c.gains.square).toBeGreaterThan(s.gains.square);
  });
  it('실내 카메라는 감쇠(마스터↓, 차단주파수↓), 실외는 더 크다', () => {
    const out = engineSoundParams(mk(2500), 0.5, false, 0.6);
    const inn = engineSoundParams(mk(2500), 0.5, true, 0.6);
    expect(inn.master).toBeLessThan(out.master);
    expect(inn.cutoff).toBeLessThan(out.cutoff);
  });
  it('엔진 OFF/RPM 0/사운드 OFF/볼륨 0 이면 소리가 없다', () => {
    expect(engineSoundParams(mk(0, 'OFF'), 1, false, 0.5).master).toBe(0);
    expect(engineSoundParams(mk(2000), 1, false, 0.5, false).master).toBe(0);
    expect(engineSoundParams(mk(2000), 1, false, 0).master).toBe(0);
    expect(engineSoundParams(mk(0, 'OFF'), 1, false, 0.5).gains.saw).toBe(0);
  });
  it('STARTING 은 약하게, STOPPING 은 RPM 하강에 따라 소리가 줄어든다', () => {
    const run = engineSoundParams(mk(800), 0, false, 0.5);
    expect(engineSoundParams(mk(250, 'STARTING'), 0, false, 0.5).master).toBeLessThan(run.master);
    expect(engineSoundParams(mk(300, 'STOPPING'), 0, false, 0.5).master).toBeLessThan(run.master);
  });
});

import { PULSE_CYCLES, REF_RPM, enginePulseWave } from '../src/audio/engineSound';
describe('엔진음 재제작 (v0.5.5): 폭발 펄스 파형 + 추가 파라미터', () => {
  const SR = 24000;
  const mk = (rpm: number, state: Engine['state'] = 'RUNNING', prof = ENGINE_PROFILES.sedan): Engine => ({ state, rpm, t: 0, profile: prof, starts: 0, stops: 0 });
  /** 단일 주파수 성분 크기(DFT 한 점) */
  const mag = (w: Float32Array, hz: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < w.length; i++) {
      const a = (2 * Math.PI * hz * i) / SR;
      re += w[i] * Math.cos(a);
      im -= w[i] * Math.sin(a);
    }
    return Math.hypot(re, im) / w.length;
  };
  it('버퍼 길이 = 기준 회전수의 사이클 8개, [-1,1] 정규화, 직류 성분 0, 같은 입력이면 같은 파형(결정적)', () => {
    const w = enginePulseWave(4, SR, false, 0.3);
    expect(w.length).toBe(Math.round((120 / REF_RPM) * PULSE_CYCLES * SR));
    let peak = 0;
    let sum = 0;
    for (const v of w) {
      peak = Math.max(peak, Math.abs(v));
      sum += v;
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(peak).toBeCloseTo(1, 5);
    expect(Math.abs(sum / w.length)).toBeLessThan(1e-6);
    expect(Array.from(enginePulseWave(4, SR, false, 0.3))).toEqual(Array.from(w));
  });
  it('가장 강한 성분은 점화 주파수(기준 1200rpm: 4기통 40Hz, 6기통 60Hz, 3기통 30Hz)이고 그 사이 주파수보다 훨씬 크다', () => {
    for (const cyl of [3, 4, 6]) {
      const w = enginePulseWave(cyl, SR, false, 0.3);
      const f = (REF_RPM / 60) * (cyl / 2);
      expect(mag(w, f), `cyl ${cyl}`).toBeGreaterThan(4 * mag(w, f * 1.37));
      expect(mag(w, f), `cyl ${cyl}`).toBeGreaterThan(4 * mag(w, f * 0.71));
    }
  });
  it('실린더별 세기 차이가 반차수 성분(사이클 주파수 10Hz 의 배수)을 만든다 — 거친 엔진일수록 크다', () => {
    const smooth = enginePulseWave(6, SR, false, 0.05);
    const rough = enginePulseWave(6, SR, false, 0.9);
    const half = (w: Float32Array): number => mag(w, 10) + mag(w, 20) + mag(w, 30);
    expect(half(rough)).toBeGreaterThan(0.003);
    expect(half(rough)).toBeGreaterThan(1.5 * half(smooth));
  });
  it('고부하용(hard) 파형은 높은 배음이 더 많다', () => {
    const hi = (w: Float32Array): number => [5, 6, 7, 8, 9].reduce((a, k) => a + mag(w, 40 * k), 0) / mag(w, 40);
    expect(hi(enginePulseWave(4, SR, true, 0.3))).toBeGreaterThan(1.5 * hi(enginePulseWave(4, SR, false, 0.3)));
  });
  it('재생 속도는 회전수에 비례, 왜곡은 부하·거친 엔진에서 증가, 공회전 떨림은 공회전·무부하에서만', () => {
    expect(engineSoundParams(mk(1200), 0, false, 0.5).rate).toBeCloseTo(1, 9);
    expect(engineSoundParams(mk(3600), 0, false, 0.5).rate).toBeCloseTo(3, 9);
    expect(engineSoundParams(mk(2500), 1, false, 0.5).drive).toBeGreaterThan(engineSoundParams(mk(2500), 0, false, 0.5).drive);
    expect(engineSoundParams(mk(2500, 'RUNNING', ENGINE_PROFILES.coupe), 0.5, false, 0.5).drive).toBeGreaterThan(engineSoundParams(mk(2500, 'RUNNING', ENGINE_PROFILES.suv), 0.5, false, 0.5).drive);
    expect(engineSoundParams(mk(750), 0, false, 0.5).lope).toBeGreaterThan(0);
    expect(engineSoundParams(mk(750), 0.5, false, 0.5).lope).toBe(0);
    expect(engineSoundParams(mk(3000), 0, false, 0.5).lope).toBe(0);
    expect(engineSoundParams(mk(0, 'OFF'), 0, false, 0.5).drive).toBe(0);
    // 가속하면 밝아진다(고역 선반 이득)
    expect(engineSoundParams(mk(2500), 1, false, 0.5).bright).toBeGreaterThan(engineSoundParams(mk(2500), 0, false, 0.5).bright + 6);
  });
});
