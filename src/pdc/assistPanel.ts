import * as THREE from 'three';
import type { ObstacleZone } from './overlay';
import { inFront, projectSegment } from './clip';
import { localToWorld } from '../core/math';
import { ICON } from '../ui/icons';
import type { VehicleSpec } from '../vehicle/spec';
import type { InfoContent } from '../infotainment/controller';
import type { NavState } from '../nav/navigator';
import { ASSIST_VIEW_NAME, type AssistView } from './viewPolicy';
import { buildGuideLines, guideColor } from './guidelines';
import { PDC_PALETTES, bandLevel, bandLit, outlinePoint, zoneGeometry, type PdcPaletteId, type PdcState, type ZoneBandShape } from './pdcModel';

export interface AssistPanelHandlers {
  onToggleSensor(): void;
  onToggleSound(): void;
  onCycleCamera(): void;
  onSettings(): void;
  onClose(): void;
  onCycleDestination(): void;
}

export const ASSIST_CAM_W = 480;
export const ASSIST_CAM_H = 270;

const MODE_NAME: Record<'auto' | AssistView, string> = { auto: '자동', rear: '후방', front: '전방', left: '좌측', right: '우측', top: '탑뷰', topZoom: '측면집중', topFront: '전방집중', topRear: '후방집중', oblique: '사선' };

/**
 * 주차 보조 디스플레이(차량 디스플레이 시스템의 한 화면).
 * 레이아웃/사이드 버튼은 고정이며 카메라 영상(캔버스 내용)과 PDC 상태만 갱신된다. (R↔D 전환 시 DOM 을 재생성하지 않음)
 * 서라운드뷰는 아직 없으므로 360° 관련 버튼/영상을 만들지 않는다.
 */
export class AssistPanel {
  readonly el: HTMLElement;
  readonly cam: HTMLCanvasElement;
  readonly guide: HTMLCanvasElement;
  readonly navCanvas: HTMLCanvasElement;
  private svg: SVGSVGElement;
  private statusEl: HTMLElement;
  private gearEl: HTMLElement;
  private chipEl: HTMLElement;
  private btn: Record<'sensor' | 'sound' | 'camera' | 'settings' | 'close', HTMLButtonElement>;
  private zonePaths: { path: SVGPathElement; shape: ZoneBandShape; key: string }[] = [];
  private levels = new Map<string, string>();
  private palette: PdcPaletteId = 'standard';
  private lastState: PdcState | null = null;
  private currentCamera: AssistView = 'rear';
  private content: InfoContent = 'parking';
  private ctx: CanvasRenderingContext2D;
  private gctx: CanvasRenderingContext2D;
  private spec: VehicleSpec | null = null;

  constructor(parent: HTMLElement, h: AssistPanelHandlers) {
    this.el = document.createElement('section');
    this.el.id = 'parking-assist';
    this.el.className = 'hidden';
    this.el.dataset.camera = 'rear';
    this.el.setAttribute('aria-label', '주차 보조 디스플레이');
    this.el.innerHTML = `
      <header class="pa-head">
        <span class="pa-p" aria-hidden="true">${ICON.parkAssist}</span>
        <span class="pa-title">주차 보조</span>
        <span class="pa-gear">R</span>
        <span class="pa-chip">후방 카메라</span>
        <span class="pa-fill"></span>
        <span class="pa-mission"></span>
        <button type="button" class="pa-close" data-pa="close" aria-label="닫기" title="닫기 (다음 기어 변경까지)">${ICON.close}</button>
      </header>
      <div class="pa-body">
        <div class="pa-cam">
          <canvas class="pa-cam-canvas" width="${ASSIST_CAM_W}" height="${ASSIST_CAM_H}"></canvas>
          <canvas class="pa-guide-canvas" width="${ASSIST_CAM_W}" height="${ASSIST_CAM_H}"></canvas>
          <canvas class="pa-nav-canvas" width="${ASSIST_CAM_W}" height="${ASSIST_CAM_H}"></canvas>
        </div>
        <div class="pa-pdc">
          <svg class="pa-svg" role="img" aria-label="차량 주변 주차거리감지(PDC)"></svg>
          <div class="pa-status">센서 대기</div>
          <div class="pa-guidance">
            <div class="pa-turn" data-turn="straight"><svg viewBox="0 0 48 48" aria-hidden="true"><path class="arrow" d="M24 40V14M24 14l-9 9M24 14l9 9" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div class="pa-nav-text">목적지를 선택하세요</div>
            <div class="pa-nav-dist"></div>
            <button type="button" class="pa-dest" data-pa="dest">목적지</button>
          </div>
        </div>
        <nav class="pa-side" aria-label="주차 보조 메뉴">
          <button type="button" data-pa="sensor"><i>${ICON.parkAssist}</i><span>주차 보조<em class="v-sensor">켜짐</em></span></button>
          <button type="button" data-pa="sound"><i>${ICON.volume}</i><span>경고음<em class="v-sound">켜짐</em></span></button>
          <button type="button" data-pa="camera"><i>${ICON.cameraSwitch}</i><span>카메라 화면<em class="v-camera">자동</em></span></button>
          <button type="button" data-pa="settings"><i>${ICON.settings}</i><span>설정</span></button>
        </nav>
      </div>`;
    parent.appendChild(this.el);
    const q = <T extends Element>(s: string): T => this.el.querySelector(s) as T;
    this.cam = q('.pa-cam-canvas');
    this.guide = q('.pa-guide-canvas');
    this.navCanvas = q('.pa-nav-canvas');
    this.el.dataset.content = 'parking';
    this.el.dataset.open = 'false';
    this.svg = q('.pa-svg');
    this.statusEl = q('.pa-status');
    this.gearEl = q('.pa-gear');
    this.chipEl = q('.pa-chip');
    this.ctx = this.cam.getContext('2d')!;
    this.gctx = this.guide.getContext('2d')!;
    this.btn = {
      sensor: q('[data-pa="sensor"]'),
      sound: q('[data-pa="sound"]'),
      camera: q('[data-pa="camera"]'),
      settings: q('[data-pa="settings"]'),
      close: q('[data-pa="close"]'),
    };
    this.btn.sensor.addEventListener('click', h.onToggleSensor);
    this.btn.sound.addEventListener('click', h.onToggleSound);
    this.btn.camera.addEventListener('click', h.onCycleCamera);
    this.btn.settings.addEventListener('click', h.onSettings);
    this.btn.close.addEventListener('click', h.onClose);
    (this.el.querySelector('[data-pa="dest"]') as HTMLButtonElement).addEventListener('click', h.onCycleDestination);
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
  private hideTimer = 0;
  /** 부드러운 등장/퇴장. (hidden 클래스는 퇴장 애니메이션이 끝난 뒤에 붙는다) */
  setVisible(on: boolean): void {
    if (on) {
      clearTimeout(this.hideTimer);
      if (this.el.classList.contains('hidden')) {
        this.el.classList.remove('hidden');
        this.el.classList.add('pa-enter');
        void this.el.offsetWidth;
      }
      this.el.classList.remove('pa-leave');
      this.el.dataset.open = 'true';
      requestAnimationFrame(() => this.el.classList.remove('pa-enter'));
    } else if (this.el.dataset.open !== 'false') {
      // 퇴장 시작은 한 번만: 매 프레임 호출돼도 숨김 타이머를 다시 걸지 않는다
      // (이전에는 프레임 간격이 190ms 보다 짧으면 타이머가 계속 초기화되어 패널이 영원히 닫히지 않았다)
      this.el.dataset.open = 'false';
      this.el.classList.add('pa-leave');
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => {
        if (this.el.dataset.open === 'false') {
          this.el.classList.add('hidden');
          this.el.classList.remove('pa-leave');
        }
      }, 190);
    }
  }

  /** 콘텐츠 전환 (주차 보조 ↔ 내비게이션). DOM/사이드 메뉴는 그대로, 보이는 내용만 바뀐다 */
  setContent(c: InfoContent): void {
    if (c === this.content) return;
    this.content = c;
    this.el.dataset.content = c;
    this.chipEl.textContent = c === 'nav' ? '경로 안내' : ASSIST_VIEW_NAME[this.currentCamera];
    (this.el.querySelector('.pa-title') as HTMLElement).textContent = c === 'nav' ? '내비게이션' : '주차 보조';
  }

  /** 내비게이션 안내 갱신 */
  setNav(st: NavState, destName: string): void {
    const turn = this.el.querySelector('.pa-turn') as HTMLElement;
    turn.dataset.turn = st.status === 'guiding' ? st.next.type : st.status === 'arrived' ? 'arrive' : 'straight';
    (this.el.querySelector('.pa-nav-text') as HTMLElement).textContent = st.text;
    (this.el.querySelector('.pa-nav-dist') as HTMLElement).textContent = st.status === 'guiding' ? `${Math.round(st.next.distM)} m 후 · 남은 ${Math.round(st.remainingM)} m` : '';
    (this.el.querySelector('.pa-dest') as HTMLElement).textContent = destName ? `목적지 ${destName}` : '목적지 선택';
  }

  setPalette(p: PdcPaletteId): void {
    if (p === this.palette) return;
    this.palette = p;
    this.zonePaths.forEach((z) => (z.key = ''));
    if (this.lastState) this.updateZones(this.lastState);
  }

  /** 차량(제원) 변경 시 PDC 차량 그래픽과 구역을 다시 만든다 */
  setSpec(spec: VehicleSpec): void {
    this.spec = spec;
    this.el.dataset.layout = spec.assist.panelLayout; // rear: 후방카메라 전용 컴팩트 / surround: 전·후방 + 3D
    const M = 1.45;
    const vbW = spec.width + M * 2;
    const vbH = spec.length + M * 2;
    const X = (x: number): number => vbW / 2 - x; // 왼쪽(+x) → 화면 왼쪽
    const Y = (z: number): number => vbH / 2 - z; // 앞(+z) → 화면 위
    this.svg.setAttribute('viewBox', `0 0 ${vbW.toFixed(3)} ${vbH.toFixed(3)}`);
    const hw = spec.width / 2;
    const hl = spec.length / 2;
    const L = spec.length;
    const base = '#' + spec.color.toString(16).padStart(6, '0');
    const shapes = zoneGeometry(spec);
    const zones = shapes
      .map((s) => {
        const d = s.points.map((p, k) => `${k ? 'L' : 'M'}${X(p.x).toFixed(3)} ${Y(p.z).toFixed(3)}`).join('') + 'Z';
        return `<path data-zone="${s.sensorId}" data-band="${s.band}" data-group="${s.group}" d="${d}" fill="${PDC_PALETTES[this.palette].idle}" opacity=".55"/>`;
      })
      .join('');
    // 차체 외곽(구역과 같은 외곽선, offset 0)
    const outline: string[] = [];
    for (let i = 0; i < 72; i++) {
      const p = outlinePoint(spec, (i / 72) * Math.PI * 2, 0);
      outline.push(`${i ? 'L' : 'M'}${X(p.x).toFixed(3)} ${Y(p.z).toFixed(3)}`);
    }
    const bodyPath = outline.join('') + 'Z';
    const kind = spec.visual.body;
    // 캐빈 위치(차체 중심 기준 z 비율): [앞유리 바닥, 앞유리 상단(=지붕 앞), 지붕 뒤, 뒷유리 바닥]
    const C = kind === 'sedan' ? [0.2, 0.07, -0.12, -0.25] : kind === 'hatch' ? [0.19, 0.06, -0.17, -0.31] : [0.21, 0.09, -0.27, -0.34];
    const poly = (pts: [number, number][], r = 0.08): string => {
      // 모서리를 둥글게 하는 폴리곤(2차 곡선)
      const n = pts.length;
      let d = '';
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i + n - 1) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const v1 = [p0[0] - p1[0], p0[1] - p1[1]];
        const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
        const l1 = Math.hypot(v1[0], v1[1]);
        const l2 = Math.hypot(v2[0], v2[1]);
        const a = [p1[0] + (v1[0] / l1) * Math.min(r, l1 / 2), p1[1] + (v1[1] / l1) * Math.min(r, l1 / 2)];
        const b = [p1[0] + (v2[0] / l2) * Math.min(r, l2 / 2), p1[1] + (v2[1] / l2) * Math.min(r, l2 / 2)];
        d += `${i ? 'L' : 'M'}${a[0].toFixed(3)} ${a[1].toFixed(3)}Q${p1[0].toFixed(3)} ${p1[1].toFixed(3)} ${b[0].toFixed(3)} ${b[1].toFixed(3)}`;
      }
      return d + 'Z';
    };
    const P = (x: number, zf: number): [number, number] => [X(x), Y(zf * L)];
    const wFront = hw * 0.8;
    const wRoof = hw * 0.74;
    const wRear = hw * 0.76;
    const windshield = poly([P(wFront, C[0]), P(-wFront, C[0]), P(-wRoof, C[1]), P(wRoof, C[1])], 0.1);
    const rearGlass = poly([P(wRoof * 0.98, C[2]), P(-wRoof * 0.98, C[2]), P(-wRear, C[3]), P(wRear, C[3])], 0.1);
    const roof = poly([P(wRoof, C[1]), P(-wRoof, C[1]), P(-wRoof * 0.98, C[2]), P(wRoof * 0.98, C[2])], 0.06);
    const axleRear = -hl + spec.rearOverhang;
    const axleFront = axleRear + spec.wheelbase;
    let wheels = '';
    for (const z of [axleRear, axleFront]) {
      for (const sx of [1, -1]) {
        wheels += `<rect x="${(X(sx * (hw - 0.04)) - 0.13).toFixed(3)}" y="${(Y(z) - spec.wheelRadius * 1.05).toFixed(3)}" width="0.26" height="${(spec.wheelRadius * 2.1).toFixed(3)}" rx="0.07" fill="#07090c" stroke="#1d242d" stroke-width=".02"/>`;
      }
    }
    const mirror = (sx: number): string => `<ellipse cx="${X(sx * (hw + 0.07)).toFixed(3)}" cy="${Y(L * 0.19).toFixed(3)}" rx="0.09" ry="0.13" fill="url(#pa-body)" stroke="#cfd8e1" stroke-width=".015" transform="rotate(${sx * -14} ${X(sx * (hw + 0.07)).toFixed(3)} ${Y(L * 0.19).toFixed(3)})"/>`;
    const head = (sx: number): string => {
      const x0 = X(sx * hw * 0.86);
      const x1 = X(sx * hw * 0.38);
      const y = Y(hl - 0.045);
      return `<path d="M${x0.toFixed(3)} ${(y + 0.02).toFixed(3)} Q${((x0 + x1) / 2).toFixed(3)} ${(y - 0.06).toFixed(3)} ${x1.toFixed(3)} ${(y + 0.01).toFixed(3)} L${x1.toFixed(3)} ${(y + 0.06).toFixed(3)} Q${((x0 + x1) / 2).toFixed(3)} ${(y + 0.0).toFixed(3)} ${x0.toFixed(3)} ${(y + 0.09).toFixed(3)}Z" fill="#eaf3ff" opacity=".92"/>`;
    };
    const tailY = Y(-hl + 0.07);
    const car = `
      <defs>
        <linearGradient id="pa-body" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="${base}" stop-opacity=".62"/><stop offset=".22" stop-color="${base}"/>
          <stop offset=".5" stop-color="#f4f8fc" stop-opacity=".95"/><stop offset=".78" stop-color="${base}"/><stop offset="1" stop-color="${base}" stop-opacity=".62"/>
        </linearGradient>
        <linearGradient id="pa-glass" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2b3f55"/><stop offset="1" stop-color="#0d1722"/></linearGradient>
        <radialGradient id="pa-spec" cx=".5" cy=".3" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
        <filter id="pa-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation=".16"/></filter>
        <pattern id="pa-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="rgba(255,255,255,.045)" stroke-width=".015"/></pattern>
      </defs>
      <rect x="0" y="0" width="${vbW.toFixed(3)}" height="${vbH.toFixed(3)}" fill="url(#pa-grid)"/>
      <ellipse cx="${(vbW / 2).toFixed(3)}" cy="${(vbH / 2 + 0.05).toFixed(3)}" rx="${(hw * 1.12).toFixed(3)}" ry="${(hl * 1.04).toFixed(3)}" fill="#000" opacity=".55" filter="url(#pa-blur)"/>
      ${wheels}
      <path d="${bodyPath}" fill="url(#pa-body)" stroke="#e7eef5" stroke-opacity=".75" stroke-width=".03"/>
      <path d="${bodyPath}" fill="url(#pa-spec)"/>
      <path d="M${X(hw * 0.7).toFixed(3)} ${Y(L * 0.33).toFixed(3)} Q${(vbW / 2).toFixed(3)} ${Y(L * 0.37).toFixed(3)} ${X(-hw * 0.7).toFixed(3)} ${Y(L * 0.33).toFixed(3)}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width=".02"/>
      <path d="${rearGlass}" fill="url(#pa-glass)" stroke="#05080c" stroke-width=".02"/>
      <path d="${roof}" fill="url(#pa-body)" stroke="#05080c" stroke-opacity=".5" stroke-width=".015"/>
      <path d="${roof}" fill="url(#pa-spec)" opacity=".7"/>
      <path d="${windshield}" fill="url(#pa-glass)" stroke="#05080c" stroke-width=".02"/>
      ${mirror(1)}${mirror(-1)}
      ${head(1)}${head(-1)}
      <rect x="${X(hw * 0.84).toFixed(3)}" y="${(tailY - 0.03).toFixed(3)}" width="${(hw * 1.68).toFixed(3)}" height="0.06" rx="0.03" fill="#ff3b30" opacity=".88"/>`;
    this.svg.innerHTML = `<g class="pa-zones">${zones}</g><g class="pa-car">${car}</g>`;
    const paths = [...this.svg.querySelectorAll<SVGPathElement>('path[data-zone]')];
    this.zonePaths = paths.map((path, i) => ({ path, shape: shapes[i], key: '' }));
    this.levels.clear();
  }

  /** 센서 결과로 구역 점등 갱신. 미검출 구역은 소등 상태 유지 */
  updateZones(state: PdcState): void {
    this.lastState = state;
    const pal = PDC_PALETTES[this.palette];
    const lvById = new Map(state.zones.map((z) => [z.id, z.level]));
    for (const z of this.zonePaths) {
      const level = lvById.get(z.shape.sensorId) ?? 'none';
      const lit = bandLit(level, z.shape.band);
      const key = lit ? bandLevel(z.shape.band) : 'off';
      if (key !== z.key) {
        z.key = key;
        z.path.setAttribute('fill', lit ? pal.colors[bandLevel(z.shape.band)] : pal.idle);
        z.path.setAttribute('opacity', lit ? '1' : '.55');
      }
      this.levels.set(z.shape.sensorId, level);
    }
    this.statusEl.textContent = state.statusText;
    this.statusEl.dataset.level = state.overall;
    this.statusEl.dataset.enabled = String(state.enabled);
  }

  /** 테스트/디버그: 센서 id → 현재 표시 단계 */
  zoneLevels(): Record<string, string> {
    return Object.fromEntries(this.levels);
  }

  setMission(text: string): void {
    const el = this.el.querySelector('.pa-mission') as HTMLElement;
    if (el.textContent !== text) el.textContent = text;
  }

  setGear(g: string): void {
    this.gearEl.textContent = g;
    this.el.dataset.gear = g;
  }

  setCamera(cam: AssistView, mode: 'auto' | AssistView, auto = false): void {
    if (cam !== this.currentCamera) {
      this.currentCamera = cam;
      this.el.dataset.camera = cam;
      if (this.content === 'parking') this.chipEl.textContent = ASSIST_VIEW_NAME[cam] + (auto && cam !== 'rear' && cam !== 'front' ? ' (자동)' : '');
      // 레이아웃은 그대로, 영상만 교체: 짧은 전환 효과
      this.el.classList.add('pa-switching');
      setTimeout(() => this.el.classList.remove('pa-switching'), 180);
    }
    (this.btn.camera.querySelector('.v-camera') as HTMLElement).textContent = MODE_NAME[mode];
    this.el.dataset.autoView = String(auto);
  }

  setToggles(sensorOn: boolean, soundOn: boolean): void {
    (this.btn.sensor.querySelector('.v-sensor') as HTMLElement).textContent = sensorOn ? '켜짐' : '꺼짐';
    (this.btn.sound.querySelector('.v-sound') as HTMLElement).textContent = soundOn ? '켜짐' : '꺼짐';
    this.btn.sensor.classList.toggle('off', !sensorOn);
    this.btn.sound.classList.toggle('off', !soundOn);
    (this.btn.sound.querySelector('i') as HTMLElement).innerHTML = soundOn ? ICON.volume : ICON.volumeOff;
  }

  /** 렌더된 카메라 영상(메인 캔버스의 일부)을 패널 캔버스로 복사 */
  blit(source: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, mirror: boolean): void {
    const g = this.ctx;
    g.save();
    if (mirror) {
      g.translate(ASSIST_CAM_W, 0);
      g.scale(-1, 1);
    }
    try {
      g.drawImage(source, sx, sy, sw, sh, 0, 0, ASSIST_CAM_W, ASSIST_CAM_H);
    } catch {
      /* 일부 환경에서 WebGL 캔버스 복사가 막히면 영상 갱신만 건너뜀 */
    }
    g.restore();
  }

  /** 조향각 기반 동적 가이드라인을 실제 카메라 투영으로 오버레이 */
  private zoneAnim = new Map<string, { c: { x: number; z: number }[]; a: number; target: number; level: ObstacleZone['level']; hits: number }>();

  /** 오버레이 상태 초기화 (시점/차량 변경 시) */
  resetOverlay(): void {
    this.zoneAnim.clear();
  }

  /**
   * 카메라/3D 영상 위 오버레이: ① 실제 감지된 장애물 구역(반투명 컬러, 보간) → ② 예측 조향 경로(근평면/화면 클리핑).
   * 장애물 구역을 아래에, 조향선을 위에 그려 겹쳐도 읽기 쉽게 한다. 거리 숫자는 그리지 않는다.
   */
  drawOverlay(o: {
    camera: THREE.PerspectiveCamera;
    pose: { x: number; z: number; heading: number; y?: number };
    steer: number;
    dir: 1 | -1;
    mirror: boolean;
    showGuides: boolean;
    zones: ObstacleZone[];
    /** 예측 경로를 장애물 직전에서 자를 거리(m). 생략하면 전체 */
    guideMax?: number;
  }): void {
    const g = this.gctx;
    g.clearRect(0, 0, ASSIST_CAM_W, ASSIST_CAM_H);
    const spec = this.spec;
    if (!spec) return;
    const pal = PDC_PALETTES[this.palette].colors;
    const cam = o.camera;
    // ---- 장애물 구역 (부드러운 크기/위치/투명도 보간) ----
    const seen = new Set<string>();
    for (const z of o.zones) {
      seen.add(z.sensorId);
      const st = this.zoneAnim.get(z.sensorId);
      if (!st) this.zoneAnim.set(z.sensorId, { c: z.corners.map((q) => ({ ...q })), a: 0, target: 1, level: z.level, hits: z.hits });
      else {
        for (let i = 0; i < 4; i++) {
          st.c[i].x += (z.corners[i].x - st.c[i].x) * 0.4;
          st.c[i].z += (z.corners[i].z - st.c[i].z) * 0.4;
        }
        st.target = 1;
        st.level = z.level;
        st.hits = z.hits;
      }
    }
    for (const [id, st] of this.zoneAnim) {
      if (!seen.has(id)) st.target = 0;
      st.a += (st.target - st.a) * 0.3;
      if (st.target === 0 && st.a < 0.03) {
        this.zoneAnim.delete(id);
        continue;
      }
      // 각 변을 근평면/화면 클리핑한 뒤 외곽선과 면을 그린다 (모서리 하나라도 카메라 뒤면 면은 생략하고 선만)
      const pts: { x: number; y: number }[] = [];
      let allFront = true;
      for (const c of st.c) {
        const p = { x: c.x, y: (o.pose.y ?? 0) + 0.03, z: c.z };
        if (!inFront(p, cam)) {
          allFront = false;
          break;
        }
        v3.set(p.x, p.y, p.z).project(cam);
        pts.push({ x: ((o.mirror ? -v3.x : v3.x) * 0.5 + 0.5) * ASSIST_CAM_W, y: (-v3.y * 0.5 + 0.5) * ASSIST_CAM_H });
      }
      if (!allFront) continue;
      g.save();
      g.beginPath();
      g.rect(0, 0, ASSIST_CAM_W, ASSIST_CAM_H);
      g.clip();
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
      g.closePath();
      g.globalAlpha = st.a * (st.hits > 1 ? 0.4 : 0.22);
      g.fillStyle = pal[st.level];
      g.fill();
      g.globalAlpha = st.a * 0.9;
      g.strokeStyle = pal[st.level];
      g.lineWidth = 2;
      g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;
    if (!o.showGuides) return;
    // ---- 예측 조향 경로 ----
    const lines = buildGuideLines(spec, o.steer, o.dir, Math.max(0.25, o.guideMax ?? 4.5));
    const W = ASSIST_CAM_W;
    const H = ASSIST_CAM_H;
    const world = (p: { x: number; z: number }): { x: number; y: number; z: number } => {
      const w = localToWorld(o.pose.x, o.pose.z, o.pose.heading, p.x, p.z);
      return { x: w.x, y: (o.pose.y ?? 0) + 0.03, z: w.z };
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const stroke = (pts: { x: number; z: number; s: number }[], width: number, color: (s: number) => string, alpha = 1, dash: number[] = []): void => {
      g.setLineDash(dash);
      g.globalAlpha = alpha;
      for (let i = 0; i < pts.length - 1; i++) {
        const seg = projectSegment(world(pts[i]), world(pts[i + 1]), cam, W, H, o.mirror);
        if (!seg) continue;
        g.beginPath();
        g.moveTo(seg[0].x, seg[0].y);
        g.lineTo(seg[1].x, seg[1].y);
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = width + 2;
        g.stroke();
        g.strokeStyle = color((pts[i].s + pts[i + 1].s) / 2);
        g.lineWidth = width;
        g.stroke();
      }
      g.setLineDash([]);
      g.globalAlpha = 1;
    };
    // 예상 차체 이동 범위(면): 좌/우 경로 사이를 얇게 칠한다. 네 모서리가 모두 카메라 앞일 때만 (잘못된 면 방지)
    for (let i = 0; i < lines.left.length - 1; i++) {
      const q = [lines.left[i], lines.left[i + 1], lines.right[i + 1], lines.right[i]].map(world);
      if (!q.every((p) => inFront(p, cam))) continue;
      g.beginPath();
      q.forEach((p, k) => {
        v3.set(p.x, p.y, p.z).project(cam);
        const x = ((o.mirror ? -v3.x : v3.x) * 0.5 + 0.5) * W;
        const y = (-v3.y * 0.5 + 0.5) * H;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.globalAlpha = 0.1;
      g.fillStyle = pal[guideColor((lines.left[i].s + lines.left[i + 1].s) / 2)];
      g.fill();
    }
    g.globalAlpha = 1;
    stroke(lines.straightLeft, 1.5, () => '#ffffff', 0.3, [6, 6]);
    stroke(lines.straightRight, 1.5, () => '#ffffff', 0.3, [6, 6]);
    const col = (s: number): string => pal[guideColor(s)];
    stroke(lines.left, 3.2, col);
    stroke(lines.right, 3.2, col);
    for (const m of lines.marks) {
      const seg = projectSegment(world(m.left), world(m.right), cam, W, H, o.mirror);
      if (!seg) continue;
      g.beginPath();
      g.moveTo(seg[0].x, seg[0].y);
      g.lineTo(seg[1].x, seg[1].y);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = col(m.s);
      g.lineWidth = 2.6;
      g.stroke();
    }
  }
}

const v3 = new THREE.Vector3();
