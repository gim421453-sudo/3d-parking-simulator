import type { Engine } from '../vehicle/engine';

/** 엔진음 합성 파라미터 (순수 함수 → 단위 테스트 가능). RPM/스로틀/상태/카메라(실내·실외)/볼륨에서 결정한다 — 단일 음원의 재생속도 조절이 아니다 */
export interface EngineSoundParams {
  /** 점화(기본) 주파수 Hz: rpm/60 × 실린더/2 (4행정) */
  f0: number;
  /** 고조파 레이어 이득 (기본음 saw / 2배음 square / 반배음 triangle / 노이즈) */
  gains: { saw: number; square: number; sub: number; noise: number };
  /** 로우패스 차단 주파수 Hz (실내는 낮게 감쇠) */
  cutoff: number;
  master: number;
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
  return { f0, gains, cutoff, master: Math.min(1, master) };
}

/** Web Audio 기반 합성 엔진음. AudioContext 는 사용자 조작 이후(init)에만 만든다. */
export class EngineSound {
  enabled = true;
  volume = 0.5;
  /** 테스트/디버그: 마지막으로 계산·적용한 값과 호출 횟수 */
  stats = { updates: 0, lastFreq: 0, lastMaster: 0, startSounds: 0, stopSounds: 0, ctx: false };
  private ctx: AudioContext | null = null;
  private osc: { saw: OscillatorNode; square: OscillatorNode; sub: OscillatorNode } | null = null;
  private g: { saw: GainNode; square: GainNode; sub: GainNode; noise: GainNode; master: GainNode } | null = null;
  private lp: BiquadFilterNode | null = null;
  private lastStarts = 0;
  private lastStops = 0;

  /** 사용자 입력 후 호출 (브라우저 자동재생 정책) */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const c = new AC();
      this.ctx = c;
      this.stats.ctx = true;
      const master = c.createGain();
      master.gain.value = 0;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      lp.connect(master);
      master.connect(c.destination);
      const mk = (type: OscillatorType): [OscillatorNode, GainNode] => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = 40;
        const g = c.createGain();
        g.gain.value = 0;
        o.connect(g);
        g.connect(lp);
        o.start();
        return [o, g];
      };
      const [saw, gSaw] = mk('sawtooth');
      const [square, gSq] = mk('square');
      const [sub, gSub] = mk('triangle');
      // 노이즈 레이어(흡기/기계음)
      const len = c.sampleRate * 2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const ns = c.createBufferSource();
      ns.buffer = buf;
      ns.loop = true;
      const gN = c.createGain();
      gN.gain.value = 0;
      ns.connect(gN);
      gN.connect(lp);
      ns.start();
      this.osc = { saw, square, sub };
      this.g = { saw: gSaw, square: gSq, sub: gSub, noise: gN, master };
      this.lp = lp;
    } catch {
      this.ctx = null;
    }
  }

  /** 프레임마다: 엔진 상태에서 파라미터를 계산해 적용. 시동/종료 시 효과음 1회 */
  update(e: Engine, throttle: number, cabin: boolean): void {
    const p = engineSoundParams(e, throttle, cabin, this.volume, this.enabled);
    this.stats.updates++;
    this.stats.lastFreq = p.f0;
    this.stats.lastMaster = p.master;
    if (e.starts !== this.lastStarts) {
      this.lastStarts = e.starts;
      this.stats.startSounds++;
      this.crank(e);
    }
    if (e.stops !== this.lastStops) {
      this.lastStops = e.stops;
      this.stats.stopSounds++;
    }
    if (!this.ctx || !this.osc || !this.g || !this.lp) return;
    const t = this.ctx.currentTime;
    const sm = 0.05;
    this.osc.saw.frequency.setTargetAtTime(Math.max(8, p.f0), t, sm);
    this.osc.square.frequency.setTargetAtTime(Math.max(8, p.f0 * 2), t, sm);
    this.osc.sub.frequency.setTargetAtTime(Math.max(8, p.f0 * 0.5), t, sm);
    this.g.saw.gain.setTargetAtTime(p.gains.saw * 0.5, t, sm);
    this.g.square.gain.setTargetAtTime(p.gains.square * 0.35, t, sm);
    this.g.sub.gain.setTargetAtTime(p.gains.sub * 0.6, t, sm);
    this.g.noise.gain.setTargetAtTime(p.gains.noise * 0.25, t, sm);
    this.lp.frequency.setTargetAtTime(p.cutoff, t, sm);
    this.g.master.gain.setTargetAtTime(p.master, t, 0.08);
  }

  /** 시동 시작(크랭킹) 효과음: 낮은 톱니파가 주기적으로 끊기는 "크르르륵" */
  private crank(e: Engine): void {
    const c = this.ctx;
    if (!c || !this.enabled || this.volume <= 0) return;
    try {
      const t0 = c.currentTime;
      const dur = e.profile.startTime;
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(55, t0);
      o.frequency.linearRampToValueAtTime(95, t0 + dur * 0.8);
      const lfo = c.createOscillator();
      lfo.frequency.value = 11;
      const lg = c.createGain();
      lg.gain.value = 0.5;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.22 * this.volume, t0 + 0.08);
      g.gain.setValueAtTime(0.22 * this.volume, t0 + dur * 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.1);
      lfo.connect(lg);
      lg.connect(g.gain);
      o.connect(g);
      g.connect(c.destination);
      o.start(t0);
      lfo.start(t0);
      o.stop(t0 + dur + 0.2);
      lfo.stop(t0 + dur + 0.2);
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
    try {
      this.osc?.saw.stop();
      this.osc?.square.stop();
      this.osc?.sub.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.osc = null;
    this.g = null;
  }
}
