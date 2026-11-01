import * as THREE from 'three';
import { localToWorld } from '../core/math';
import { ICON } from '../ui/icons';
import type { VehicleSpec } from '../vehicle/spec';
import type { AssistCamera } from './assistPolicy';
import { buildGuideLines, guideColor } from './guidelines';
import { PDC_PALETTES, bandLevel, bandLit, zoneGeometry, type PdcPaletteId, type PdcState, type ZoneBandShape } from './pdcModel';

export interface AssistPanelHandlers {
  onToggleSensor(): void;
  onToggleSound(): void;
  onCycleCamera(): void;
  onSettings(): void;
  onClose(): void;
}

export const ASSIST_CAM_W = 480;
export const ASSIST_CAM_H = 270;

const CAMERA_NAME: Record<AssistCamera, string> = { rear: '후방 카메라', front: '전방 카메라' };
const MODE_NAME: Record<'auto' | AssistCamera, string> = { auto: '자동', rear: '후방', front: '전방' };

/**
 * 주차 보조 디스플레이(차량 디스플레이 시스템의 한 화면).
 * 레이아웃/사이드 버튼은 고정이며 카메라 영상(캔버스 내용)과 PDC 상태만 갱신된다. (R↔D 전환 시 DOM 을 재생성하지 않음)
 * 서라운드뷰는 아직 없으므로 360° 관련 버튼/영상을 만들지 않는다.
 */
export class AssistPanel {
  readonly el: HTMLElement;
  readonly cam: HTMLCanvasElement;
  readonly guide: HTMLCanvasElement;
  private svg: SVGSVGElement;
  private statusEl: HTMLElement;
  private gearEl: HTMLElement;
  private chipEl: HTMLElement;
  private btn: Record<'sensor' | 'sound' | 'camera' | 'settings' | 'close', HTMLButtonElement>;
  private zonePaths: { path: SVGPathElement; shape: ZoneBandShape; key: string }[] = [];
  private levels = new Map<string, string>();
  private palette: PdcPaletteId = 'standard';
  private lastState: PdcState | null = null;
  private currentCamera: AssistCamera = 'rear';
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
        <span class="pa-title">주차 보조</span>
        <span class="pa-gear">R</span>
        <span class="pa-chip">후방 카메라</span>
        <span class="pa-fill"></span>
        <button type="button" class="pa-close" data-pa="close" aria-label="닫기" title="닫기 (다음 기어 변경까지)">${ICON.close}</button>
      </header>
      <div class="pa-body">
        <div class="pa-cam">
          <canvas class="pa-cam-canvas" width="${ASSIST_CAM_W}" height="${ASSIST_CAM_H}"></canvas>
          <canvas class="pa-guide-canvas" width="${ASSIST_CAM_W}" height="${ASSIST_CAM_H}"></canvas>
        </div>
        <div class="pa-pdc">
          <svg class="pa-svg" role="img" aria-label="차량 주변 주차거리감지(PDC)"></svg>
          <div class="pa-status">센서 대기</div>
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
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
  setVisible(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
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
    const M = 1.7;
    const vbW = spec.width + M * 2;
    const vbH = spec.length + M * 2;
    const X = (x: number): number => vbW / 2 - x; // 왼쪽(+x) → 화면 왼쪽
    const Y = (z: number): number => vbH / 2 - z; // 앞(+z) → 화면 위
    this.svg.setAttribute('viewBox', `0 0 ${vbW.toFixed(3)} ${vbH.toFixed(3)}`);
    const hw = spec.width / 2;
    const hl = spec.length / 2;
    const body = '#' + spec.color.toString(16).padStart(6, '0');
    let zones = '';
    this.zonePaths = [];
    const shapes = zoneGeometry(spec);
    shapes.forEach((s, i) => {
      const d = s.points.map((p, k) => `${k ? 'L' : 'M'}${X(p.x).toFixed(3)} ${Y(p.z).toFixed(3)}`).join('') + 'Z';
      zones += `<path data-zone="${s.sensorId}" data-band="${s.band}" data-group="${s.group}" d="${d}" fill="${PDC_PALETTES[this.palette].idle}" opacity=".55"/>`;
      void i;
    });
    const rr = (x: number, z: number, w: number, h: number, r: number, extra: string): string =>
      `<rect x="${X(x + w / 2).toFixed(3)}" y="${Y(z + h / 2).toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" rx="${r}" ${extra}/>`;
    const axleRear = -hl + spec.rearOverhang;
    const axleFront = axleRear + spec.wheelbase;
    let wheels = '';
    for (const z of [axleRear, axleFront]) for (const sx of [1, -1]) wheels += rr(sx * (hw - 0.02), z, 0.24, spec.wheelRadius * 2.1, 0.06, 'fill="#0b0e12"');
    const car = `
      <defs>
        <linearGradient id="pa-body" x1="0" x2="1"><stop offset="0" stop-color="${body}" stop-opacity=".78"/><stop offset=".5" stop-color="#e9eef3" stop-opacity=".92"/><stop offset="1" stop-color="${body}" stop-opacity=".78"/></linearGradient>
      </defs>
      ${wheels}
      ${rr(0, 0, spec.width, spec.length, spec.width * 0.28, 'fill="url(#pa-body)" stroke="#dfe7ee" stroke-width=".035"')}
      ${rr(0, spec.length * -0.04, spec.width * 0.82, spec.length * 0.44, spec.width * 0.18, 'fill="#17222e" opacity=".92"')}
      ${rr(0, spec.length * -0.075, spec.width * 0.72, spec.length * 0.26, spec.width * 0.12, 'fill="#cdd6de" opacity=".85"')}
      ${rr(hw + 0.05, spec.length * 0.17, 0.13, 0.2, 0.04, 'fill="#aab6c2"')}${rr(-hw - 0.05, spec.length * 0.17, 0.13, 0.2, 0.04, 'fill="#aab6c2"')}
      ${rr(hw * 0.62, hl - 0.07, spec.width * 0.2, 0.1, 0.04, 'fill="#f6f1d8"')}${rr(-hw * 0.62, hl - 0.07, spec.width * 0.2, 0.1, 0.04, 'fill="#f6f1d8"')}
      ${rr(hw * 0.62, -hl + 0.07, spec.width * 0.2, 0.1, 0.04, 'fill="#c93a3a"')}${rr(-hw * 0.62, -hl + 0.07, spec.width * 0.2, 0.1, 0.04, 'fill="#c93a3a"')}`;
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

  setGear(g: string): void {
    this.gearEl.textContent = g;
    this.el.dataset.gear = g;
  }

  setCamera(cam: AssistCamera, mode: 'auto' | AssistCamera): void {
    if (cam !== this.currentCamera) {
      this.currentCamera = cam;
      this.el.dataset.camera = cam;
      this.chipEl.textContent = CAMERA_NAME[cam];
      // 레이아웃은 그대로, 영상만 교체: 짧은 전환 효과
      this.el.classList.add('pa-switching');
      setTimeout(() => this.el.classList.remove('pa-switching'), 180);
    }
    (this.btn.camera.querySelector('.v-camera') as HTMLElement).textContent = MODE_NAME[mode];
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
  drawGuides(o: { camera: THREE.PerspectiveCamera; pose: { x: number; z: number; heading: number }; steer: number; dir: 1 | -1; mirror: boolean; show: boolean }): void {
    const g = this.gctx;
    g.clearRect(0, 0, ASSIST_CAM_W, ASSIST_CAM_H);
    const spec = this.spec;
    if (!o.show || !spec) return;
    const pal = PDC_PALETTES[this.palette].colors;
    const lines = buildGuideLines(spec, o.steer, o.dir);
    const v = new THREE.Vector3();
    const proj = (p: { x: number; z: number }): { x: number; y: number } | null => {
      const w = localToWorld(o.pose.x, o.pose.z, o.pose.heading, p.x, p.z);
      v.set(w.x, 0.03, w.z).project(o.camera);
      if (v.z < -1 || v.z > 1) return null;
      const nx = o.mirror ? -v.x : v.x;
      return { x: (nx * 0.5 + 0.5) * ASSIST_CAM_W, y: (-v.y * 0.5 + 0.5) * ASSIST_CAM_H };
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const stroke = (pts: { x: number; z: number; s: number }[], width: number, color: (s: number) => string, alpha = 1, dash: number[] = []): void => {
      g.setLineDash(dash);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = proj(pts[i]);
        const b = proj(pts[i + 1]);
        if (!a || !b) continue;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.strokeStyle = 'rgba(0,0,0,0.55)';
        g.lineWidth = width + 2;
        g.globalAlpha = alpha;
        g.stroke();
        g.strokeStyle = color((pts[i].s + pts[i + 1].s) / 2);
        g.lineWidth = width;
        g.stroke();
      }
      g.setLineDash([]);
      g.globalAlpha = 1;
    };
    // 직진 기준 폭 표시선 (흐리게)
    stroke(lines.straightLeft, 1.5, () => '#ffffff', 0.35, [6, 6]);
    stroke(lines.straightRight, 1.5, () => '#ffffff', 0.35, [6, 6]);
    // 현재 조향 예상 경로 (거리 구간별 색)
    const col = (s: number): string => pal[guideColor(s)];
    stroke(lines.left, 3.2, col);
    stroke(lines.right, 3.2, col);
    // 거리 구분선
    for (const m of lines.marks) {
      const a = proj(m.left);
      const b = proj(m.right);
      if (!a || !b) continue;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = col(m.s);
      g.lineWidth = 2.6;
      g.stroke();
    }
  }
}
