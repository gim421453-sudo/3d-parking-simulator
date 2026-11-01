import type { SensorSnapshot } from '../sensors/sensorSystem';
import { proximityLevel } from '../sensors/sensorSystem';

const SHAPES: [string, string][] = [
  ['F-L-out','M61 45 L45 29 Q57 14 77 10 L84 30 Q71 32 61 45Z'],
  ['F-L-in','M85 30 L78 10 Q89 4 110 4 L110 27 Q97 26 85 30Z'],
  ['F-R-in','M112 4 Q133 4 144 10 L137 30 Q125 26 112 27Z'],
  ['F-R-out','M145 10 Q165 14 177 29 L161 45 Q151 32 138 30Z'],
  ['R-L-out','M61 176 L45 192 Q57 207 77 211 L84 191 Q71 189 61 176Z'],
  ['R-L-in','M85 191 L78 211 Q89 217 110 217 L110 194 Q97 195 85 191Z'],
  ['R-R-in','M112 194 L112 217 Q133 217 144 211 L137 191 Q125 195 112 194Z'],
  ['R-R-out','M145 191 L138 191 L145 211 Q165 207 177 192 L161 176 Q151 189 145 191Z'],
  ['L-front','M53 55 L35 46 Q20 67 22 94 L46 94 Q44 71 53 55Z'],
  ['L-rear','M46 127 L22 127 Q20 154 35 175 L53 166 Q44 150 46 127Z'],
  ['R-front','M169 55 L187 46 Q202 67 200 94 L176 94 Q178 71 169 55Z'],
  ['R-rear','M176 127 L200 127 Q202 154 187 175 L169 166 Q178 150 176 127Z'],
];
const COLORS = {none:'#283442',far:'#86ab69',mid:'#e7bd52',near:'#ef873e',critical:'#ed4b4b'} as const;
type Mode = 'split' | 'pdc';
export class PdcDisplay {
  private el: HTMLElement;
  private camera: HTMLElement;
  private status: HTMLElement;
  private cameraButton: HTMLButtonElement;
  private pdcButton: HTMLButtonElement;
  private muteButton: HTMLButtonElement;
  private arcs = new Map<string, SVGPathElement>();
  private mode: Mode = 'split';
  private wasActive = false;
  constructor(parent: HTMLElement, rear: HTMLCanvasElement, onMute: () => void) {
    this.el = document.createElement('section');
    this.el.id = 'parking-assist';
    this.el.className = 'hidden';
    this.el.setAttribute('aria-label','후방 주차 보조 디스플레이');
    this.el.innerHTML = `
      <header class="pa-header"><span>PARKING ASSIST</span><strong>R</strong><em>● PDC</em></header>
      <div class="pa-body">
        <div class="pa-camera"><div class="pa-rear-slot"></div><span>후방 카메라</span></div>
        <div class="pa-sensor"><svg viewBox="0 0 222 221" role="img" aria-label="전체 차량 PDC 탑뷰">
          ${SHAPES.map(([id,d]) => `<path data-id="${id}" d="${d}" fill="${COLORS.none}" stroke="#131b26" stroke-width="1.5"/>`).join('')}
          <rect x="78" y="49" width="66" height="123" rx="19" fill="#8295a9" stroke="#d3dce4" stroke-width="2"/>
          <rect x="84" y="59" width="54" height="39" rx="13" fill="#22384b"/>
          <rect x="85" y="118" width="52" height="39" rx="10" fill="#293e50"/>
          <path d="M86 54 L136 54 M86 169 L136 169" stroke="#dce5ec" stroke-width="3"/>
          <path d="M86 166 L98 166 M124 166 L136 166" stroke="#be4248" stroke-width="3"/>
        </svg><span class="pa-status">센서 대기</span></div>
        <nav class="pa-side" aria-label="주차보조 화면 선택">
          <button type="button" data-pa="split" title="후방카메라 + PDC">▣<small>카메라</small></button>
          <button type="button" data-pa="pdc" title="전체 차량 PDC 탑뷰">◉<small>PDC</small></button>
          <button type="button" data-pa="mute" title="주차 경고음 켜기/끄기">◖))<small>경고음</small></button>
        </nav>
      </div>`;
    parent.appendChild(this.el);
    this.camera = this.el.querySelector('.pa-camera')!;
    this.status = this.el.querySelector('.pa-status')!;
    this.cameraButton = this.el.querySelector('[data-pa="split"]')!;
    this.pdcButton = this.el.querySelector('[data-pa="pdc"]')!;
    this.muteButton = this.el.querySelector('[data-pa="mute"]')!;
    this.el.querySelector('.pa-rear-slot')!.appendChild(rear);
    this.cameraButton.addEventListener('click', () => { this.mode = 'split'; this.layout(); });
    this.pdcButton.addEventListener('click', () => { this.mode = 'pdc'; this.layout(); });
    this.muteButton.addEventListener('click', onMute);
    this.el.querySelectorAll<SVGPathElement>('path[data-id]').forEach(path => this.arcs.set(path.dataset.id!,path));
  }
  update(active: boolean, hasCamera: boolean, enabled: boolean, sound: boolean, snapshot: SensorSnapshot | null): void {
    this.el.classList.toggle('hidden', !active);
    if (!active) { this.wasActive = false; return; }
    if (!this.wasActive) { this.mode = hasCamera ? 'split' : 'pdc'; this.wasActive = true; }
    if (!hasCamera) this.mode = 'pdc';
    this.cameraButton.disabled = !hasCamera;
    this.muteButton.classList.toggle('muted',!sound);
    this.muteButton.setAttribute('aria-pressed', String(sound));
    this.layout();
    const readings = new Map(snapshot?.readings.map(r => [r.id,r.distance]) ?? []);
    let min: number | null = null;
    for (const [id,path] of this.arcs) {
      const d = enabled ? (readings.get(id) ?? null) : null;
      const level = enabled && snapshot ? proximityLevel(d,snapshot.range,snapshot.critical) : 'none';
      path.setAttribute('fill', COLORS[level]);
      if (d !== null && (min === null || d < min)) min = d;
    }
    const level = enabled && snapshot && min !== null ? proximityLevel(min,snapshot.range,snapshot.critical) : 'none';
    this.status.textContent = !enabled ? 'PDC 꺼짐' : !snapshot ? '센서 대기' :
      level === 'critical' ? '정지 · 매우 가까움' : level === 'near' ? '장애물 가까움' :
      level === 'mid' ? '장애물 접근' : level === 'far' ? '장애물 감지' : '주변 확인';
    this.status.dataset.level = level;
  }
  private layout(): void {
    this.el.classList.toggle('pa-pdc-only',this.mode === 'pdc');
    this.camera.classList.toggle('hidden',this.mode === 'pdc');
    this.cameraButton.classList.toggle('active',this.mode === 'split');
    this.pdcButton.classList.toggle('active',this.mode === 'pdc');
    this.cameraButton.setAttribute('aria-pressed',String(this.mode === 'split'));
    this.pdcButton.setAttribute('aria-pressed',String(this.mode === 'pdc'));
  }
}
