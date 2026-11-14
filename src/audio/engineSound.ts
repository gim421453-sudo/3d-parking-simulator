import type { Engine, EngineProfile } from '../vehicle/engine';

/**
 * 엔진음 합성 파라미터 (순수 함수 → 단위 테스트 가능). RPM/스로틀/상태/카메라(실내·실외)/볼륨에서 결정한다.
 * v0.5.5 재제작: 톱니/사각파 발진기(전자음 같던 원인) 대신 **폭발 펄스열 → 고정 공명(배기관/차체) 필터** 구조(소스-필터 모델).
 * 전부 코드로 합성한 소리이며 실제 차량 녹음이 아니다.
 */
export interface EngineSoundParams {
  /** 점화(기본) 주파수 Hz: rpm/60 × 실린더/2 (4행정) */
  f0: number;
  /** 레이어 이득 — v0.5.5 재제작: saw = 저부하 배기 펄스, square = 고부하(날카로운) 배기 펄스, sub = 점화 주파수 저음, noise = 흡기/기계 소음. (필드 이름은 이전 버전과 호환을 위해 유지) */
  gains: { saw: number; square: number; sub: number; noise: number };
  /** 로우패스 차단 주파수 Hz (실내는 낮게 감쇠) */
  cutoff: number;
  master: number;
  /** 배기 펄스 버퍼 재생 속도 (기준 REF_RPM 에서 1) */
  rate: number;
  /** 파형 왜곡(으르렁) 정도 0~1: 부하·거친 엔진일수록 크다 */
  drive: number;
  /** 공회전 떨림(회전수 흔들림) 깊이: 저회전·무부하에서만 */
  lope: number;
  /** 흡기 소음 대역 중심 Hz */
  intakeHz: number;
  /** 고역 선반 필터 이득 dB: 가속(부하) 때 밝아지고 타력 주행·공회전에서는 어둡다 */
  bright: number;
}

/** 펄스 버퍼의 기준 회전수: 이 회전수에서 버퍼를 1배속으로 재생한다 */
export const REF_RPM = 1200;
/** 버퍼에 담는 엔진 사이클(720°) 수 — 폭발마다 조금씩 다른 세기를 넣어 기계적인 반복감을 줄인다 */
export const PULSE_CYCLES = 8;

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * 배기 펄스 파형(순수 함수): 엔진 사이클마다 실린더 수만큼 폭발 펄스(급한 상승 + 감쇠 진동)를 놓는다.
 * 실린더별 세기 차이(사이클마다 같은 패턴)가 반차수 성분(낮게 깔리는 울림)을 만들고, 폭발마다의 작은 흔들림이 반복감을 줄인다.
 * hard=true 는 고부하용(날카로운 펄스 + 높은 배음). 결과는 [-1,1] 로 정규화, 버퍼 양 끝이 이어지도록(루프) 만든다.
 */
export function enginePulseWave(cylinders: number, sampleRate: number, hard: boolean, rough = 0.3, seed = 1): Float32Array {
  const cyc = 120 / REF_RPM; // 한 사이클(2회전) 시간
  const n = Math.round(cyc * PULSE_CYCLES * sampleRate);
  const out = new Float32Array(n);
  const fires = cylinders * PULSE_CYCLES;
  const T = n / fires; // 폭발 간격(샘플)
  const rnd = mulberry32(seed * 7919 + cylinders * 31 + (hard ? 17 : 0));
  const cylAmp = Array.from({ length: cylinders }, () => 1 + (rnd() * 2 - 1) * (0.1 + 0.25 * rough));
  const cylShift = Array.from({ length: cylinders }, () => (rnd() * 2 - 1) * 0.04 * (0.5 + rough));
  const span = Math.ceil(T * 2.2);
  for (let k = 0; k < fires; k++) {
    const amp = cylAmp[k % cylinders] * (1 + (rnd() * 2 - 1) * (0.04 + 0.1 * rough));
    const start = (k + cylShift[k % cylinders]) * T;
    const i0 = Math.ceil(start);
    for (let j = 0; j < span; j++) {
      const u = (i0 + j - start) / T; // 폭발 간격 단위 시간
      // 급한 상승(1 - e^-40u) × 감쇠 진동. soft: 낮은 울림 위주, hard: 날카로운 성분 추가
      const rise = 1 - Math.exp(-u * (hard ? 60 : 28));
      let v = Math.exp(-u * (hard ? 3.2 : 4.2)) * Math.sin(2 * Math.PI * 1.0 * u + 0.4);
      v += 0.7 * Math.exp(-u * 6) * Math.sin(2 * Math.PI * 2.6 * u);
      v += 0.55 * Math.exp(-u * 9) * Math.sin(2 * Math.PI * 7.4 * u + 0.7); // 금속성 중역(배기 매니폴드 울림)
      if (hard) v += 0.9 * Math.exp(-u * 8) * Math.sin(2 * Math.PI * 5.3 * u + 1.1) + 0.7 * Math.exp(-u * 12) * Math.sin(2 * Math.PI * 11.1 * u) + 0.5 * Math.exp(-u * 16) * Math.sin(2 * Math.PI * 17.7 * u + 2.0);
      // 폭발 순간의 짧은 충격(넓은 대역, 상승 포락선을 거치지 않는다): 이게 없으면 저음만 남아 둔탁하다
      const click = (hard ? 1.4 : 0.7) * (Math.exp(-u * 30) - Math.exp(-u * 200));
      out[(i0 + j) % n] += amp * (rise * v + click);
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    out[i] -= mean;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}


export function engineSoundParams(e: Engine, throttle: number, cabin: boolean, volume: number, enabled = true): EngineSoundParams {
  const p = e.profile;
  const rpm = Math.max(0, e.rpm);
  const alive = enabled && rpm > 30 ? 1 : 0;
  const f0 = Math.max(0, (rpm / 60) * (p.cylinders / 2));
  const load = Math.min(1, Math.max(0, throttle));
  const rpmN = Math.min(1, rpm / p.redline);
  const gains = {
    saw: alive * (0.35 + 0.35 * load),
    square: alive * p.rough * (0.15 + 0.5 * load) * (0.4 + 0.6 * rpmN),
    sub: alive * (0.4 - 0.2 * rpmN),
    noise: alive * (0.03 + 0.1 * load + 0.08 * rpmN),
  };
  // 시동(STARTING)은 크랭킹 소리(별도 효과)가 담당하므로 본 음은 약하게
  const stateGain = e.state === 'STARTING' ? 0.35 : e.state === 'STOPPING' ? Math.min(1, rpm / p.idle) : 1;
  const cutoff = (cabin ? 420 : 1300) + rpm * (cabin ? 0.35 : 0.9) + load * (cabin ? 150 : 600);
  const master = alive * volume * (cabin ? 0.45 : 1) * stateGain * (0.5 + 0.5 * Math.min(1, 0.4 + rpmN * 0.8 + load * 0.3));
  const rate = Math.max(0.05, rpm / REF_RPM);
  const drive = Math.min(1, alive * (0.15 + 0.55 * load + 0.3 * p.rough) * (0.5 + 0.5 * rpmN));
  const lope = alive * (0.006 + 0.03 * p.rough) * Math.max(0, 1 - load * 3) * Math.max(0, 1 - Math.max(0, rpm - p.idle) / 600);
  const intakeHz = 500 + rpm * 0.45 + load * 500;
  const bright = -5 + 11 * load + 3 * p.rough;
  return { f0, gains, cutoff, master: Math.min(1, master), rate, drive, lope, intakeHz, bright };
}

/** 엔진음 그래프(실시간/오프라인 렌더 공용). ctx 는 AudioContext 또는 OfflineAudioContext */
export interface EngineGraph {
  soft: AudioBufferSourceNode;
  hard: AudioBufferSourceNode;
  sub: OscillatorNode;
  noise: AudioBufferSourceNode;
  gSoft: GainNode;
  gHard: GainNode;
  gSub: GainNode;
  gNoise: GainNode;
  intake: BiquadFilterNode;
  shaper: WaveShaperNode;
  shelf: BiquadFilterNode;
  pre: GainNode;
  lp: BiquadFilterNode;
  master: GainNode;
  profileId: string;
}

const shapeCurve = (k: number): Float32Array<ArrayBuffer> => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // 비대칭 왜곡: 짝수·홀수 배음이 함께 생긴다(대칭 tanh 는 홀수 배음만)
    c[i] = (Math.tanh((x + 0.25) * k) - Math.tanh(0.25 * k)) / Math.tanh(1.25 * k);
  }
  return c;
};

export function buildEngineGraph(c: BaseAudioContext, profile: EngineProfile): EngineGraph {
  const mkBuf = (hard: boolean): AudioBuffer => {
    const w = enginePulseWave(profile.cylinders, c.sampleRate, hard, profile.rough);
    const b = c.createBuffer(1, w.length, c.sampleRate);
    b.getChannelData(0).set(w);
    return b;
  };
  const master = c.createGain();
  master.gain.value = 0;
  // 순서: 레이어 합 → 왜곡(부하) → 공명 필터(고정 주파수 = 배기관/차체 울림) → 로우패스 → 마스터
  const pre = c.createGain();
  pre.gain.value = 1;
  const shaper = c.createWaveShaper();
  shaper.curve = shapeCurve(2.2);
  shaper.oversample = '2x';
  const body1 = c.createBiquadFilter();
  body1.type = 'peaking';
  body1.frequency.value = 95;
  body1.Q.value = 1.1;
  body1.gain.value = 4;
  const body2 = c.createBiquadFilter();
  body2.type = 'peaking';
  body2.frequency.value = 240 + profile.rough * 120;
  body2.Q.value = 1.6;
  body2.gain.value = 4 + profile.rough * 4;
  const body3 = c.createBiquadFilter();
  body3.type = 'peaking';
  body3.frequency.value = 720;
  body3.Q.value = 1.0;
  body3.gain.value = 7;
  const dip = c.createBiquadFilter();
  dip.type = 'peaking';
  dip.frequency.value = 2400;
  dip.Q.value = 0.8;
  dip.gain.value = -3;
  const shelf = c.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 900;
  shelf.gain.value = 0;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 28;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0.5;
  pre.connect(shaper);
  shaper.connect(body1);
  body1.connect(body2);
  body2.connect(body3);
  body3.connect(dip);
  dip.connect(shelf);
  shelf.connect(hp);
  hp.connect(lp);
  lp.connect(master);
  // 리미터(DynamicsCompressor)는 쓰지 않는다: 자동 보정 이득 때문에 볼륨 설정과 무관하게 커진다. 크기는 왜곡(tanh) 뒤 고정 이득으로 제한한다
  master.connect(c.destination);
  const src = (buf: AudioBuffer): [AudioBufferSourceNode, GainNode] => {
    const s = c.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const g = c.createGain();
    g.gain.value = 0;
    s.connect(g);
    g.connect(pre);
    s.start();
    return [s, g];
  };
  const [soft, gSoft] = src(mkBuf(false));
  const [hard, gHard] = src(mkBuf(true));
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 30;
  const gSub = c.createGain();
  gSub.gain.value = 0;
  sub.connect(gSub);
  gSub.connect(body1); // 저음은 왜곡을 거치지 않는다
  sub.start();
  // 흡기/기계 소음: 백색 소음 → 회전수를 따라가는 대역 필터
  const len = Math.round(c.sampleRate * 1.7);
  const nb = c.createBuffer(1, len, c.sampleRate);
  const d = nb.getChannelData(0);
  const rnd = mulberry32(99);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  const noise = c.createBufferSource();
  noise.buffer = nb;
  noise.loop = true;
  const intake = c.createBiquadFilter();
  intake.type = 'bandpass';
  intake.frequency.value = 800;
  intake.Q.value = 0.9;
  const gNoise = c.createGain();
  gNoise.gain.value = 0;
  noise.connect(intake);
  intake.connect(gNoise);
  gNoise.connect(dip);
  noise.start();
  return { soft, hard, sub, noise, gSoft, gHard, gSub, gNoise, intake, shaper, shelf, pre, lp, master, profileId: profile.id };
}

/** 파라미터를 그래프에 적용 (wobble: -1~1 공회전 떨림 위상값) */
export function applyEngineParams(g: EngineGraph, p: EngineSoundParams, t: number, wobble = 0, sm = 0.05): void {
  const rate = p.rate * (1 + p.lope * wobble);
  g.soft.playbackRate.setTargetAtTime(rate, t, sm);
  g.hard.playbackRate.setTargetAtTime(rate, t, sm);
  g.sub.frequency.setTargetAtTime(Math.max(8, p.f0 * (1 + p.lope * wobble)), t, sm);
  g.gSoft.gain.setTargetAtTime(p.gains.saw * 0.9, t, sm);
  g.gHard.gain.setTargetAtTime(p.gains.square * 0.9, t, sm);
  g.gSub.gain.setTargetAtTime(p.gains.sub * 0.12, t, sm);
  g.gNoise.gain.setTargetAtTime(p.gains.noise * 0.9, t, sm);
  g.intake.frequency.setTargetAtTime(p.intakeHz, t, sm);
  g.pre.gain.setTargetAtTime(0.55 + 1.6 * p.drive, t, sm);
  g.shelf.gain.setTargetAtTime(p.bright, t, sm);
  g.lp.frequency.setTargetAtTime(p.cutoff, t, sm);
  g.master.gain.setTargetAtTime(p.master * 0.32, t, 0.08);
}

/** Web Audio 기반 합성 엔진음. AudioContext 는 사용자 조작 이후(init)에만 만든다. */
export class EngineSound {
  enabled = true;
  volume = 0.5;
  /** 테스트/디버그: 마지막으로 계산·적용한 값과 호출 횟수 */
  stats = { updates: 0, lastFreq: 0, lastMaster: 0, startSounds: 0, stopSounds: 0, ctx: false, rebuilds: 0, lastRate: 0 };
  private ctx: AudioContext | null = null;
  private g: EngineGraph | null = null;
  private lastStarts = 0;
  private lastStops = 0;

  /** 사용자 입력 후 호출 (브라우저 자동재생 정책). 그래프는 첫 update 에서 차량 엔진 프로필로 만든다 */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.stats.ctx = true;
    } catch {
      this.ctx = null;
    }
  }

  private teardown(): void {
    const g = this.g;
    if (!g) return;
    try {
      g.master.gain.value = 0;
      g.soft.stop();
      g.hard.stop();
      g.sub.stop();
      g.noise.stop();
      g.master.disconnect();
    } catch {
      /* ignore */
    }
    this.g = null;
  }

  /** 프레임마다: 엔진 상태에서 파라미터를 계산해 적용. 시동/종료 시 효과음 1회 */
  update(e: Engine, throttle: number, cabin: boolean): void {
    const p = engineSoundParams(e, throttle, cabin, this.volume, this.enabled);
    this.stats.updates++;
    this.stats.lastFreq = p.f0;
    this.stats.lastMaster = p.master;
    this.stats.lastRate = p.rate;
    if (e.starts !== this.lastStarts) {
      this.lastStarts = e.starts;
      this.stats.startSounds++;
      this.crank(e);
    }
    if (e.stops !== this.lastStops) {
      this.lastStops = e.stops;
      this.stats.stopSounds++;
    }
    if (!this.ctx) return;
    try {
      // 차량(엔진 프로필)이 바뀌면 실린더 수에 맞는 펄스 버퍼로 다시 만든다
      if (!this.g || this.g.profileId !== e.profile.id) {
        this.teardown();
        this.g = buildEngineGraph(this.ctx, e.profile);
        this.stats.rebuilds++;
      }
      const t = this.ctx.currentTime;
      // 공회전 떨림: 서로 다른 느린 주기 두 개의 합(규칙적인 트레몰로처럼 들리지 않게)
      const wobble = 0.6 * Math.sin(t * 2 * Math.PI * 1.7) + 0.4 * Math.sin(t * 2 * Math.PI * 2.9 + 1.3);
      applyEngineParams(this.g, p, t, wobble);
    } catch {
      /* 오디오 실패는 게임 진행에 영향 없음 */
    }
  }

  /** 시동(크랭킹) 효과음: 스타터 모터의 윙 소리 + 압축 행정마다 끊기는 낮은 "츠츠츠" */
  private crank(e: Engine): void {
    const c = this.ctx;
    if (!c || !this.enabled || this.volume <= 0) return;
    try {
      const t0 = c.currentTime;
      const dur = e.profile.startTime;
      const v = this.volume;
      const out = c.createGain();
      out.gain.setValueAtTime(0.0001, t0);
      out.gain.linearRampToValueAtTime(0.5 * v, t0 + 0.06);
      out.gain.setValueAtTime(0.5 * v, t0 + dur * 0.8);
      out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.1);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      lp.connect(out);
      out.connect(c.destination);
      // 스타터 모터 윙 소리
      const whine = c.createOscillator();
      whine.type = 'triangle';
      whine.frequency.setValueAtTime(260, t0);
      whine.frequency.linearRampToValueAtTime(340, t0 + dur * 0.7);
      const gw = c.createGain();
      gw.gain.value = 0.12;
      whine.connect(gw);
      gw.connect(lp);
      // 압축 행정 맥동: 낮은 음 + 약 9Hz 로 끊기는 진폭
      const chug = c.createOscillator();
      chug.type = 'sawtooth';
      chug.frequency.setValueAtTime(48, t0);
      chug.frequency.linearRampToValueAtTime(80, t0 + dur * 0.8);
      const gc = c.createGain();
      gc.gain.value = 0.3;
      const lfo = c.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(7, t0);
      lfo.frequency.linearRampToValueAtTime(11, t0 + dur * 0.8);
      const lg = c.createGain();
      lg.gain.value = 0.28;
      lfo.connect(lg);
      lg.connect(gc.gain);
      chug.connect(gc);
      gc.connect(lp);
      for (const o of [whine, chug, lfo]) {
        o.start(t0);
        o.stop(t0 + dur + 0.2);
      }
    } catch {
      /* 오디오 실패는 게임 진행에 영향 없음 */
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }
  /** 소리만 즉시 제거 (일시정지/결과/메뉴) */
  silence(): void {
    if (this.g && this.ctx) this.g.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }
  dispose(): void {
    this.teardown();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }
}
