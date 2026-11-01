import type { Action, HeldKey, Input } from '../game/input';
import type { Gear } from '../vehicle/physics';
import { Minimap } from './minimap';

export interface MissionHud {
  name: string;
  timeText: string;
  checks: { label: string; value: string; ok: boolean | null }[];
  holdPct: number;
  status: 'running' | 'success' | 'failed';
}

export interface HudData {
  speedKmh: number;
  gear: Gear;
  steerDeg: number;
  steerWheelDeg: number;
  handbrake: boolean;
  signalLeft: boolean;
  signalRight: boolean;
  hazard: boolean;
  headlights: boolean;
  braking: boolean;
  cameraName: string;
  sensorOn: boolean;
  soundOn: boolean;
  mission: MissionHud | null;
  fpsText: string | null;
}

const TICKS = 13; // 0~60km/h, 5km/h 간격

function speedoSvg(): string {
  let ticks = '';
  for (let i = 0; i < TICKS; i++) {
    const a = ((-120 + (240 * i) / (TICKS - 1)) * Math.PI) / 180;
    const major = i % 2 === 0;
    const r1 = 82;
    const r2 = major ? 70 : 75;
    const x1 = 100 + Math.sin(a) * r1;
    const y1 = 100 - Math.cos(a) * r1;
    const x2 = 100 + Math.sin(a) * r2;
    const y2 = 100 - Math.cos(a) * r2;
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? '#dfe7f1' : '#6c7b8f'}" stroke-width="${major ? 2.5 : 1.5}"/>`;
    if (major) {
      const tx = 100 + Math.sin(a) * 58;
      const ty = 100 - Math.cos(a) * 58 + 4;
      ticks += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="#9fb0c5" font-size="11" text-anchor="middle">${i * 5}</text>`;
    }
  }
  return `<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="94" fill="rgba(10,14,20,.85)" stroke="rgba(255,255,255,.18)" stroke-width="2"/>${ticks}
  <g id="needle"><line x1="100" y1="100" x2="100" y2="30" stroke="#ff5a4d" stroke-width="3.5" stroke-linecap="round"/></g>
  <circle cx="100" cy="100" r="7" fill="#dfe7f1"/></svg>`;
}

const STEER_SVG = `<svg viewBox="0 0 48 48"><g id="swheel"><circle cx="24" cy="24" r="19" fill="none" stroke="#dfe7f1" stroke-width="4"/><circle cx="24" cy="24" r="4" fill="#dfe7f1"/><line x1="5" y1="24" x2="43" y2="24" stroke="#dfe7f1" stroke-width="3"/><line x1="24" y1="24" x2="24" y2="43" stroke="#dfe7f1" stroke-width="3"/><circle cx="24" cy="5" r="2.6" fill="#ff5a4d"/></g></svg>`;

export interface HudHandlers {
  action(a: Action): void;
  input: Input;
}

/** 인게임 HUD. 모든 버튼은 키보드와 같은 Action 경로를 사용한다. */
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  private needle!: SVGGElement;
  private swheel!: SVGGElement;
  private digital!: HTMLElement;
  private gearBtns = new Map<Gear, HTMLButtonElement>();
  private missionEl!: HTMLDivElement;
  private toasts!: HTMLDivElement;
  private flashEl!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private camLabel!: HTMLDivElement;
  private steerText!: HTMLElement;
  private inds = new Map<string, HTMLElement>();
  private btns = new Map<string, HTMLButtonElement>();
  private hintEl!: HTMLDivElement;
  private minimapWrap!: HTMLDivElement;
  readonly sensorSlot: HTMLDivElement;
  private touchEl: HTMLDivElement;
  private lastMissionKey = '';

  constructor(parent: HTMLElement, private h: HudHandlers) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div id="left-col">
        <div id="mission-panel" class="panel"></div>
        <div id="sv-controls"></div>
        <div id="sensor-slot"></div>
      </div>
      <div id="cam-label"></div>
      <div id="toasts"></div>
      <div id="flash"></div>
      <div id="fps" class="hidden"></div>
      <div id="top-right">
        <div class="iconbar">
          <button data-a="camera" title="카메라 (C)">📷<span class="t"> 카메라</span></button>
          <button data-a="sensorView" title="주차 센서 화면 (V)">📡<span class="t"> 화면</span></button>
          <button data-a="sensorToggle" title="주차 센서 ON/OFF">센서</button>
          <button data-a="soundToggle" title="경고음 ON/OFF">🔊</button>
          <button data-a="minimap" title="미니맵 (M)">🗺<span class="t"> 맵</span></button>
          <button data-a="pause" title="일시정지 (Esc)">⏸</button>
          <button data-a="restart" title="미션 재시작">↻</button>
        </div>
        <div id="minimap-wrap" class="panel"><canvas id="minimap"></canvas></div>
      </div>
      <div id="actionbar">
        <button data-a="signalLeft" title="좌 방향지시등 (Q)">◀<span class="t"> 깜빡이</span></button>
        <button data-a="hazard" title="비상등 (H)">⚠<span class="t"> 비상등</span></button>
        <button data-a="signalRight" title="우 방향지시등 (E)"><span class="t">깜빡이 </span>▶</button>
        <button data-a="headlights" title="전조등 (L)">💡<span class="t"> 전조등</span></button>
        <button data-a="handbrake" title="주차 브레이크 (Space)">🅿<span class="t"> 주차브레이크</span></button>
        <button data-a="reset" title="차량 초기화 (T)">⟲<span class="t"> 초기화</span></button>
      </div>
      <div id="cluster" class="panel">
        <div id="steer-box">${STEER_SVG}<b id="steer-text">0°</b><div>조향</div></div>
        <div id="speedo">${speedoSvg()}<div class="digital"><span id="spd">0</span><small>km/h</small></div></div>
        <div id="gears">
          <button data-g="P">P</button><button data-g="R">R</button>
          <button data-g="N">N</button><button data-g="D">D</button>
        </div>
        <div id="indicators">
          <div class="ind sig" id="ind-l" title="좌 방향지시등">◀</div>
          <div class="ind sig" id="ind-r" title="우 방향지시등">▶</div>
          <div class="ind haz" id="ind-h" title="비상등">⚠</div>
          <div class="ind head" id="ind-head" title="전조등">💡</div>
          <div class="ind brake" id="ind-pb" title="주차 브레이크">P!</div>
          <div class="ind brake" id="ind-br" title="브레이크">■</div>
        </div>
      </div>
      <div id="hint"></div>
      <div id="touch"></div>`;
    parent.appendChild(this.root);
    const q = <T extends Element>(s: string): T => this.root.querySelector(s) as T;
    this.needle = q('#needle');
    this.swheel = q('#swheel');
    this.digital = q('#spd');
    this.missionEl = q('#mission-panel');
    this.toasts = q('#toasts');
    this.flashEl = q('#flash');
    this.fpsEl = q('#fps');
    this.camLabel = q('#cam-label');
    this.steerText = q('#steer-text');
    this.hintEl = q('#hint');
    this.minimapWrap = q('#minimap-wrap');
    this.sensorSlot = q('#sensor-slot');
    this.touchEl = q('#touch');
    this.minimap = new Minimap(q('#minimap'));
    for (const id of ['ind-l', 'ind-r', 'ind-h', 'ind-head', 'ind-pb', 'ind-br']) this.inds.set(id, q('#' + id));
    this.root.querySelectorAll<HTMLButtonElement>('#gears button').forEach((b) => {
      const g = b.dataset.g as Gear;
      this.gearBtns.set(g, b);
      b.addEventListener('click', () => this.h.action(('gear' + (g === 'D' ? 'D' : g)) as Action));
    });
    this.root.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => {
      this.btns.set(b.dataset.a!, b);
      b.addEventListener('click', () => this.h.action(b.dataset.a as Action));
    });

    // 센서 화면 크기 조절 버튼
    const svc = q<HTMLDivElement>('#sv-controls');
    svc.innerHTML = `<button data-sv="small">작게</button><button data-sv="large">크게</button><button data-sv="hidden">숨김</button><button data-sv="reset" title="시점 초기화">↺</button>`;
    this.svControls = svc;
    this.buildTouch();
  }

  svControls: HTMLDivElement;

  onSensorSize: (s: 'small' | 'large' | 'hidden' | 'reset') => void = () => {};

  bindExtra(): void {
    this.svControls.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => this.onSensorSize(b.dataset.sv as 'small' | 'large' | 'hidden' | 'reset'));
    });
  }

  private buildTouch(): void {
    const steer = document.createElement('div');
    steer.id = 't-steer';
    const pedals = document.createElement('div');
    pedals.id = 't-pedals';
    const mk = (label: string, key: HeldKey, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'tbtn ' + cls;
      b.textContent = label;
      const down = new Set<number>();
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        if (!down.has(e.pointerId)) {
          down.add(e.pointerId);
          this.h.input.press(key);
        }
        b.classList.add('held');
      });
      const up = (e: PointerEvent): void => {
        if (down.delete(e.pointerId)) this.h.input.release(key);
        if (!down.size) b.classList.remove('held');
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    steer.append(mk('◀', 'left'), mk('▶', 'right'));
    pedals.append(mk('브레이크', 'brake', 'brk'), mk('가속', 'throttle', 'gas'));
    this.touchEl.append(steer, pedals);
  }

  setTouchVisible(v: boolean, scale: number): void {
    this.touchEl.classList.toggle('hidden', !v);
    this.root.style.setProperty('--touch', String(scale));
  }

  show(): void {
    this.root.classList.remove('hidden');
  }
  hide(): void {
    this.root.classList.add('hidden');
  }

  setMinimapMode(m: 'small' | 'large' | 'hidden'): void {
    this.minimapWrap.classList.toggle('hidden', m === 'hidden');
    this.minimapWrap.classList.toggle('large', m === 'large');
  }

  setSensorControls(size: 'small' | 'large' | 'hidden'): void {
    this.svControls.classList.toggle('large', size === 'large');
    this.svControls.classList.toggle('hidden', size === 'hidden');
  }

  setParkingOpen(on: boolean): void {
    this.root.classList.toggle('pdc-open', on);
  }

  setPip(on: boolean): void {
    this.root.classList.toggle('pip', on);
  }

  hint(text: string | null): void {
    if (!text) {
      this.hintEl.classList.add('fade');
      return;
    }
    this.hintEl.innerHTML = text;
    this.hintEl.classList.remove('fade');
  }

  toast(msg: string, kind: '' | 'warn' | 'bad' | 'good' = ''): void {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.remove(), 2400);
  }

  flash(): void {
    this.flashEl.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => this.flashEl.classList.remove('on')));
  }

  update(d: HudData): void {
    // 속도계: 0~60 km/h → -120°~120°
    const a = -120 + (240 * Math.min(60, d.speedKmh)) / 60;
    this.needle.setAttribute('transform', `rotate(${a.toFixed(1)} 100 100)`);
    this.digital.textContent = String(Math.round(d.speedKmh));
    this.swheel.setAttribute('transform', `rotate(${d.steerWheelDeg.toFixed(1)} 24 24)`);
    this.steerText.textContent = `${Math.abs(Math.round(d.steerDeg))}°${d.steerDeg > 0.5 ? ' ←' : d.steerDeg < -0.5 ? ' →' : ''}`;
    for (const [g, b] of this.gearBtns) b.classList.toggle('cur', g === d.gear);
    const on = (id: string, v: boolean): void => {
      this.inds.get(id)?.classList.toggle('on', v);
    };
    on('ind-l', d.signalLeft);
    on('ind-r', d.signalRight);
    on('ind-h', d.hazard);
    on('ind-head', d.headlights);
    on('ind-pb', d.handbrake);
    on('ind-br', d.braking);
    this.btns.get('headlights')?.classList.toggle('on', d.headlights);
    this.btns.get('handbrake')?.classList.toggle('on', d.handbrake);
    this.btns.get('hazard')?.classList.toggle('on', d.hazard);
    this.btns.get('sensorToggle')?.classList.toggle('on', d.sensorOn);
    this.btns.get('soundToggle')?.classList.toggle('on', d.soundOn);
    const sb = this.btns.get('soundToggle');
    if (sb) sb.textContent = d.soundOn ? '🔊' : '🔇';
    this.camLabel.textContent = `📷 ${d.cameraName}`;
    if (d.fpsText) {
      this.fpsEl.classList.remove('hidden');
      this.fpsEl.textContent = d.fpsText;
    } else {
      this.fpsEl.classList.add('hidden');
    }
    this.renderMission(d.mission);
  }

  private renderMission(m: MissionHud | null): void {
    if (!m) {
      const key = 'free';
      if (this.lastMissionKey !== key) {
        this.missionEl.innerHTML = `<div class="mname">자유주행</div><div style="color:var(--muted);margin-top:4px">미션 없이 자유롭게 연습합니다.</div>`;
        this.lastMissionKey = key;
      }
      return;
    }
    const key = m.name + m.timeText + m.checks.map((c) => c.value + c.ok).join('|') + Math.round(m.holdPct);
    if (key === this.lastMissionKey) return;
    this.lastMissionKey = key;
    this.missionEl.innerHTML =
      `<div class="mhead"><span class="mname">${m.name}</span><span class="mtime">${m.timeText}</span></div><ul>` +
      m.checks.map((c) => `<li class="${c.ok === null ? '' : c.ok ? 'ok' : 'bad'}"><span>${c.ok === null ? '·' : c.ok ? '✔' : '✖'} ${c.label}</span><span>${c.value}</span></li>`).join('') +
      `</ul><div class="bar"><i style="width:${m.holdPct.toFixed(0)}%"></i></div>`;
  }
}
