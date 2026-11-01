/** WebAudio 기반 주차 센서 경고음. 사용자 입력 이후에 init()을 호출해야 소리가 난다(브라우저/Android WebView 정책). */
export class Beeper {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private cont: OscillatorNode | null = null;
  private contGain: GainNode | null = null;
  private timer = 0;
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
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  /** interval: null=무음, 0=연속음, 그 외 ms 주기 */
  update(dt: number, interval: number | null): void {
    if (!this.ctx || !this.master) return;
    if (!this.enabled || interval === null) {
      this.stopContinuous();
      this.timer = 0;
      return;
    }
    if (interval === 0) {
      this.startContinuous();
      return;
    }
    this.stopContinuous();
    this.timer -= dt * 1000;
    if (this.timer <= 0) {
      this.beep(0.07);
      this.timer = interval;
    }
  }

  private beep(len: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 1100;
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
    this.cont.frequency.value = 1100;
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
