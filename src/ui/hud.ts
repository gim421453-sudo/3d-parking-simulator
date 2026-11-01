import type { Action, HeldKey, Input } from '../game/input';
import type { Gear } from '../vehicle/physics';
import { ICON } from './icons';
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
  lightMode: string;
  braking: boolean;
  cameraName: string;
  sensorOn: boolean;
  soundOn: boolean;
  mission: MissionHud | null;
  fpsText: string | null;
}

/** 속도 링: 270° 호. 0 ~ RING_MAX km/h 를 채운다. */
const RING_R = 50;
const RING_LEN = 2 * Math.PI * RING_R;
const ARC_LEN = RING_LEN * 0.75;
const RING_MAX = 50;

function speedRing(): string {
  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const a = ((135 + 270 * (i / 5)) * Math.PI) / 180;
    const r1 = 58;
    const r2 = i % 5 === 0 || i === 0 ? 54 : 55;
    ticks += `<line x1="${(60 + Math.cos(a) * r1).toFixed(1)}" y1="${(60 + Math.sin(a) * r1).toFixed(1)}" x2="${(60 + Math.cos(a) * r2).toFixed(1)}" y2="${(60 + Math.sin(a) * r2).toFixed(1)}" stroke="rgba(255,255,255,.28)" stroke-width="1"/>`;
  }
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
    <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${ARC_LEN.toFixed(2)} ${RING_LEN.toFixed(2)}" transform="rotate(135 60 60)"/>
    <circle id="ring-val" cx="60" cy="60" r="${RING_R}" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-dasharray="0 ${RING_LEN.toFixed(2)}" transform="rotate(135 60 60)"/>
    ${ticks}</svg>`;
}

const STEER_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><g id="swheel"><circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="24" r="3.6" fill="currentColor"/><path d="M7 24h12M29 24h12M24 28v14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="7" r="2.4" fill="#d9531e"/></g></svg>`;

export interface HudHandlers {
  action(a: Action): void;
  input: Input;
}

/** 인게임 HUD. 모든 버튼은 키보드와 같은 Action 경로를 사용한다. */
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  private ringVal!: SVGCircleElement;
  private swheel!: SVGGElement;
  private digital!: HTMLElement;
  private gearBtns = new Map<Gear, HTMLButtonElement>();
  private missionEl!: HTMLDivElement;
  private toasts!: HTMLDivElement;
  private flashEl!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private camLabel!: HTMLDivElement;
  private steerText!: HTMLElement;
  private speedoEl!: HTMLElement;
  private btns = new Map<string, HTMLButtonElement>();
  private hintEl!: HTMLDivElement;
  private minimapWrap!: HTMLDivElement;
  readonly sensorSlot: HTMLDivElement;
  private touchEl: HTMLDivElement;
  private lastMissionKey = '';

  constructor(
    parent: HTMLElement,
    private h: HudHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.className = 'hidden';
    const ab = (a: string, title: string, icon: string, extra = ''): string => `<button class="ab" data-a="${a}" title="${title}" aria-label="${title}">${icon}${extra}</button>`;
    this.root.innerHTML = `
      <div id="left-col">
        <div id="mission-panel" class="glass"></div>
        <div id="sv-controls"></div>
        <div id="sensor-slot"></div>
      </div>
      <div id="cam-label"></div>
      <div id="toasts"></div>
      <div id="flash"></div>
      <div id="fps" class="hidden"></div>
      <div id="top-right">
        <div class="iconbar">
          ${ab('camera', '카메라 변경 (C)', ICON.camera)}
          ${ab('sensorView', '주차 센서 3D 화면 (V)', ICON.sensor)}
          ${ab('sensorToggle', '주차 센서 켜기/끄기', ICON.parkAssist)}
          ${ab('soundToggle', '경고음 켜기/끄기', ICON.volume)}
          ${ab('minimap', '미니맵 (M)', ICON.map)}
          ${ab('pause', '일시정지 (Esc)', ICON.pause)}
          ${ab('restart', '미션 재시작', ICON.restart)}
        </div>
        <div id="minimap-wrap" class="glass"><canvas id="minimap"></canvas></div>
      </div>
      <div id="cluster" class="glass">
        <div class="cl-main">
          <div id="steer-box" title="조향">${STEER_SVG}<b id="steer-text">0°</b></div>
          <div id="speedo">${speedRing()}<div class="digital"><span id="spd">0</span><small>km/h</small></div></div>
          <div id="gears" role="group" aria-label="기어">
            <button data-g="P" aria-label="주차 P">P</button><button data-g="R" aria-label="후진 R">R</button>
            <button data-g="N" aria-label="중립 N">N</button><button data-g="D" aria-label="전진 D">D</button>
          </div>
        </div>
        <div id="actionbar" role="group" aria-label="차량 조작">
          ${ab('assistToggle', '주차 보조 화면 (B)', ICON.assist)}
          ${ab('signalLeft', '좌 방향지시등 (Q)', ICON.left)}
          ${ab('hazard', '비상등 (H)', ICON.hazard)}
          ${ab('signalRight', '우 방향지시등 (E)', ICON.right)}
          ${ab('headlights', '조명 모드 순환 (L)', ICON.headlight, '<span class="t">AUTO</span>')}
          ${ab('handbrake', '주차 브레이크 (Space)', ICON.parkBrake)}
          ${ab('reset', '차량 초기화 (T)', ICON.reset)}
        </div>
      </div>
      <div id="hint"></div>
      <div id="touch"></div>`;
    parent.appendChild(this.root);
    const q = <T extends Element>(s: string): T => this.root.querySelector(s) as T;
    this.ringVal = q('#ring-val');
    this.swheel = q('#swheel');
    this.digital = q('#spd');
    this.speedoEl = q('#speedo');
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
    this.root.querySelectorAll<HTMLButtonElement>('#gears button').forEach((b) => {
      const g = b.dataset.g as Gear;
      this.gearBtns.set(g, b);
      b.addEventListener('click', () => this.h.action(('gear' + g) as Action));
    });
    this.root.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => {
      this.btns.set(b.dataset.a!, b);
      b.addEventListener('click', () => this.h.action(b.dataset.a as Action));
    });

    // 센서 화면 크기 조절 버튼
    const svc = q<HTMLDivElement>('#sv-controls');
    svc.innerHTML = `<button data-sv="small">작게</button><button data-sv="large">크게</button><button data-sv="hidden">숨김</button><button data-sv="reset" title="시점 초기화" aria-label="시점 초기화">${ICON.reset}</button>`;
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
      if (key === 'left') b.innerHTML = ICON.left;
      if (key === 'right') b.innerHTML = ICON.right;
      b.setAttribute('aria-label', key === 'left' ? '왼쪽 조향' : key === 'right' ? '오른쪽 조향' : key === 'brake' ? '브레이크' : '가속');
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
    steer.append(mk('', 'left'), mk('', 'right'));
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

  setAssistOpen(on: boolean): void {
    this.root.classList.toggle('assist-open', on);
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
    const ratio = Math.min(1, d.speedKmh / RING_MAX);
    this.ringVal.setAttribute('stroke-dasharray', `${(ARC_LEN * ratio).toFixed(2)} ${RING_LEN.toFixed(2)}`);
    this.speedoEl.dataset.gear = d.gear;
    this.digital.textContent = String(Math.round(d.speedKmh));
    this.swheel.setAttribute('transform', `rotate(${d.steerWheelDeg.toFixed(1)} 24 24)`);
    this.steerText.textContent = `${Math.abs(Math.round(d.steerDeg))}°`;
    for (const [g, b] of this.gearBtns) b.classList.toggle('cur', g === d.gear);
    const on = (a: string, v: boolean): void => {
      this.btns.get(a)?.classList.toggle('on', v);
    };
    on('signalLeft', d.signalLeft);
    on('signalRight', d.signalRight);
    on('hazard', d.hazard);
    on('headlights', d.headlights);
    on('handbrake', d.handbrake);
    on('sensorToggle', d.sensorOn);
    on('soundToggle', d.soundOn);
    const ht = this.btns.get('headlights')?.querySelector('.t');
    if (ht) ht.textContent = d.lightMode;
    const sb = this.btns.get('soundToggle');
    if (sb) sb.innerHTML = d.soundOn ? ICON.volume : ICON.volumeOff;
    this.camLabel.textContent = d.cameraName;
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
        this.missionEl.innerHTML = `<div class="mc-head"><span class="mc-name">자유주행</span></div><div class="mc-sub">미션 없이 자유롭게 연습합니다</div>`;
        this.lastMissionKey = key;
      }
      return;
    }
    const key = m.name + m.timeText + m.checks.map((c) => c.value + c.ok).join('|') + Math.round(m.holdPct);
    if (key === this.lastMissionKey) return;
    this.lastMissionKey = key;
    this.missionEl.innerHTML =
      `<div class="mc-head"><span class="mc-name">${m.name}</span><span class="mc-time">${m.timeText}</span></div><ul class="mc-list">` +
      m.checks.map((c) => `<li><i class="dot ${c.ok === null ? 'na' : c.ok ? 'ok' : 'bad'}"></i><span class="k">${c.label}</span><span class="v">${c.value}</span></li>`).join('') +
      `</ul><div class="bar"><i style="width:${m.holdPct.toFixed(0)}%"></i></div>`;
  }
}
