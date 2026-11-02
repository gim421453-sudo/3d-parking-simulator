import { BEEP_VOICES } from './beepPlan';
import type { SensorGroup } from '../vehicle/spec';

/** WebAudio 기반 주차 센서 경고음. 사용자 입력 이후에 init()을 호출해야 소리가 난다(브라우저/Android WebView 정책). */
export class Beeper {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private cont: OscillatorNode | null = null;
  private contGain: GainNode | null = null;
  private timer = 0;
  private pan: StereoPannerNode | null = null;
  private group: SensorGroup = 'rear';
  /** 마지막으로 울린 방향 (테스트/표시용) */
  lastGroup: SensorGroup | null = null;
  beepCount = 0;
  volume = 0.5;
  enabled = true;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      // 좌우 방향감: 스테레오 패너 (미지원 환경에서는 모노로 동작)
      if (typeof this.ctx.createStereoPanner === 'function') {
        this.pan = this.ctx.createStereoPanner();
        this.pan.connect(this.ctx.destination);
        this.master.connect(this.pan);
      } else this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  /** interval: null=무음, 0=연속음, 그 외 ms 주기 */
  update(dt: number, interval: number | null, group: SensorGroup = 'rear'): void {
    this.group = group;
    if (!this.ctx || !this.master) return;
    if (!this.enabled || interval === null) {
      this.stopContinuous();
      this.timer = 0;
      return;
    }
    if (interval === 0) {
      this.startContinuous();
      if (this.cont && this.lastGroup !== this.group && this.ctx) {
        // 연속음 중 방향이 바뀌면 주파수/패닝만 부드럽게 바꾼다
        const v = BEEP_VOICES[this.group];
        this.cont.frequency.setTargetAtTime(v.freq, this.ctx.currentTime, 0.03);
        this.pan?.pan.setTargetAtTime(v.pan, this.ctx.currentTime, 0.03);
        this.lastGroup = this.group;
      }
      return;
    }
    this.stopContinuous();
    this.timer -= dt * 1000;
    if (this.timer <= 0) {
      this.beep(BEEP_VOICES[this.group].len);
      this.timer = interval;
    }
  }

  private beep(len: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const voice = BEEP_VOICES[this.group];
    this.lastGroup = this.group;
    this.beepCount++;
    if (this.pan) this.pan.pan.setValueAtTime(voice.pan, t);
    osc.type = 'square';
    osc.frequency.value = voice.freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * this.volume, t + 0.005);
    g.gain.setValueAtTime(0.18 * this.volume, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.01);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }

  private startContinuous(): void {
    if (!this.ctx || !this.master || this.cont) return;
    this.cont = this.ctx.createOscillator();
    this.contGain = this.ctx.createGain();
    this.cont.type = 'square';
    this.cont.frequency.value = BEEP_VOICES[this.group].freq;
    this.lastGroup = this.group;
    if (this.pan) this.pan.pan.value = BEEP_VOICES[this.group].pan;
    this.contGain.gain.value = 0.16 * this.volume;
    this.cont.connect(this.contGain).connect(this.master);
    this.cont.start();
  }

  private stopContinuous(): void {
    if (this.cont) {
      try {
        this.cont.stop();
      } catch {
        /* 이미 정지 */
      }
      this.cont.disconnect();
      this.contGain?.disconnect();
      this.cont = null;
      this.contGain = null;
    }
  }

  silence(): void {
    this.stopContinuous();
    this.timer = 0;
  }
}
