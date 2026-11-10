/** 기계식 주차장 효과음 (WebAudio 합성, 외부 오디오 파일 없음). 사용자 입력 이후에만 AudioContext 가 만들어진다. */
let ctx: AudioContext | null = null;
export let sfxPlays = 0;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** 바퀴가 정지 홈에 걸려 안착할 때의 짧은 금속성 "덜커덩". intensity 0..1, volume 0..1 */
export function playClunk(intensity: number, volume: number): void {
  sfxPlays++;
  const c = audio();
  if (!c || volume <= 0) return;
  try {
    if (c.state === 'suspended') void c.resume();
    const t = c.currentTime;
    const gain = c.createGain();
    const peak = Math.min(0.5, 0.12 + 0.3 * intensity) * volume;
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.28);
    gain.connect(c.destination);
    for (const [type, f0, f1] of [['square', 150, 90], ['triangle', 480, 260]] as const) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.18);
      o.connect(gain);
      o.start(t);
      o.stop(t + 0.3);
    }
    // 타격 노이즈
    const len = Math.floor(c.sampleRate * 0.05);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g2 = c.createGain();
    g2.gain.value = peak * 0.8;
    src.connect(g2);
    g2.connect(c.destination);
    src.start(t);
  } catch {
    /* 오디오 실패는 게임 진행에 영향 없음 */
  }
}
