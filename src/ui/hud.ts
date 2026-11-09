import type { Action, HeldKey, Input } from '../game/input';
import type { Gear } from '../vehicle/physics';
import { ICON } from './icons';
import { Minimap } from './minimap';
import { WHEEL_LOCK_DEG, WheelModel } from '../core/wheel';
import { onTap } from './tap';
import { Shifter, type ShifterHost } from './shifter';

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
  shifter: ShifterHost;
}

/** 인게임 HUD. 모든 버튼은 키보드와 같은 Action 경로를 사용한다. */
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  private ringVal!: SVGCircleElement;
  private swheel!: SVGGElement;
  private digital!: HTMLElement;
  private gearInd!: HTMLElement;
  readonly shifter: Shifter;
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
  /** 1080° 회전 핸들 (터치). 조향 입력은 Game 이 wheel.steer() 로 읽는다 */
  readonly wheel = new WheelModel();
  private wheelEl!: HTMLDivElement;
  private wheelShown = NaN;
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
        <div id="gear-panel"><div id="gear-big" role="status" aria-label="현재 기어 P" data-g="P"><span data-g="P">P</span><span data-g="R">R</span><span data-g="N">N</span><span data-g="D">D</span></div></div>
        <div id="floor-ind" class="hidden" role="status" aria-label="현재 층"></div>
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
          ${ab('assistToggle', '인포테인먼트 화면 열기/닫기 (B)', ICON.display)}
          ${ab('camera', '카메라 변경 (C)', ICON.camera)}
          ${ab('mirrorToggle', '3인칭 미러 켜기/끄기 (U)', ICON.mirror)}
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
        </div>
        <div id="actionbar" role="group" aria-label="차량 조작">
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
    this.gearInd = q('#gear-big');
    this.shifter = new Shifter(q('#gear-panel'), this.h.shifter); // v0.4.8: 기어 표시와 실제 레버를 좌측 상단 한 패널에 통합
    this.root.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => {
      this.btns.set(b.dataset.a!, b);
      onTap(b, () => this.h.action(b.dataset.a as Action));
    });

    // 센서 화면 크기 조절 버튼
    const svc = q<HTMLDivElement>('#sv-controls');
    svc.innerHTML = `<button data-sv="small">작게</button><button data-sv="large">크게</button><button data-sv="hidden">숨김</button><button data-sv="reset" title="시점 초기화" aria-label="시점 초기화">${ICON.reset}</button>`;
    this.svControls = svc;
    this.buildTouch();
    window.addEventListener('blur', () => this.releaseWheel());
    document.addEventListener('visibilitychange', () => document.hidden && this.resetTouchInputs());
  }

  svControls: HTMLDivElement;

  onSensorSize: (s: 'small' | 'large' | 'hidden' | 'reset') => void = () => {};

  bindExtra(): void {
    this.svControls.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      onTap(b, () => this.onSensorSize(b.dataset.sv as 'small' | 'large' | 'hidden' | 'reset'));
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
    // ---- 회전형 핸들 (포인터 캡처, 첫 손가락만 추적 → 가속/브레이크/기어 손가락을 가로채지 않음) ----
    const wheel = document.createElement('div');
    wheel.id = 't-wheel';
    wheel.setAttribute('role', 'slider');
    wheel.setAttribute('aria-label', '핸들 (좌우 540°, 총 1080°)');
    wheel.setAttribute('aria-valuemin', String(-WHEEL_LOCK_DEG));
    wheel.setAttribute('aria-valuemax', String(WHEEL_LOCK_DEG));
    wheel.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true"><g class="w-rot"><circle r="43" fill="none" stroke="currentColor" stroke-width="7"/><path d="M-43 0H-9M43 0H9M0 8V43" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle r="9" fill="currentColor" opacity=".35"/><path d="M-6 -43H6" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/></g><path class="w-fix" d="M-4.5 -50H4.5L0 -45Z" fill="currentColor"/></svg>`;
    let wid: number | null = null;
    const ang = (e: PointerEvent): { deg: number; frac: number } => {
      const r = wheel.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { deg: (Math.atan2(dy, dx) * 180) / Math.PI, frac: Math.hypot(dx, dy) / (r.width / 2) };
    };
    wheel.addEventListener('pointerdown', (e) => {
      if (wid !== null) return;
      e.preventDefault();
      wid = e.pointerId;
      wheel.setPointerCapture(e.pointerId);
      this.wheel.begin(ang(e).deg);
      wheel.classList.add('held');
    });
    wheel.addEventListener('pointermove', (e) => {
      if (e.pointerId !== wid) return;
      const a = ang(e);
      this.wheel.move(a.deg, a.frac);
    });
    const wend = (e: PointerEvent): void => {
      if (e.pointerId !== wid) return;
      wid = null;
      this.wheel.end();
      wheel.classList.remove('held');
    };
    wheel.addEventListener('pointerup', wend);
    wheel.addEventListener('pointercancel', wend);
    wheel.addEventListener('lostpointercapture', wend);
    wheel.addEventListener('contextmenu', (e) => e.preventDefault());
    this.releaseWheel = (): void => {
      wid = null;
      this.wheel.end();
      wheel.classList.remove('held');
    };
    this.wheelEl = wheel;
    steer.append(wheel);
    pedals.append(mk('브레이크', 'brake', 'brk'), mk('가속', 'throttle', 'gas'));
    this.touchEl.append(steer, pedals);
  }

  private releaseWheel: () => void = () => {};

  private floorEl: HTMLElement | null = null;
  /** 다층 맵: 현재 층 표시 (평면 맵은 null 로 숨김) */
  setFloor(name: string | null): void {
    if (!this.floorEl) this.floorEl = this.root.querySelector('#floor-ind');
    const el = this.floorEl!;
    if (name === null) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (el.textContent !== name) {
      el.textContent = name;
      el.setAttribute('aria-label', `현재 층 ${name}`);
    }
  }

  /** 조향 방식: wheel = 회전 핸들, buttons = 좌/우 버튼 */
  setSteerControl(mode: 'wheel' | 'buttons'): void {
    this.touchEl.dataset.steer = mode;
    if (mode !== 'wheel') this.releaseWheel();
  }

  /** 앱 전환/일시정지/창 이탈 시 터치 입력을 안전하게 초기화 */
  resetTouchInputs(): void {
    this.releaseWheel();
    this.wheel.reset();
    this.shifter.cancel();
  }

  /** 핸들 회전 표시 (매 프레임, 값이 바뀔 때만 DOM 갱신) */
  renderWheel(): void {
    const a = this.wheel.angle;
    if (a === this.wheelShown) return;
    this.wheelShown = a;
    (this.wheelEl.querySelector('.w-rot') as SVGGElement).style.transform = `rotate(${-a}deg)`;
    this.wheelEl.setAttribute('aria-valuenow', String(Math.round(a)));
  }

  setTouchVisible(v: boolean, scale: number): void {
    this.touchEl.classList.toggle('hidden', !v);
    this.root.classList.toggle('touch-on', v);
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

  /** 버튼의 켜짐 표시를 바꾼다 (HUD 데이터와 무관한 토글용) */
  setOn(a: string, v: boolean): void {
    this.btns.get(a)?.classList.toggle('on', v);
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
    if (this.gearInd.dataset.g !== d.gear) {
      this.gearInd.dataset.g = d.gear;
      this.gearInd.setAttribute('aria-label', `현재 기어 ${d.gear}`);
    }
    this.shifter.update();
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
