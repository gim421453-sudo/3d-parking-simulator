import { drawPdcCanvas } from '../pdc/pdcCanvas';
import type { PdcPaletteId, PdcState } from '../pdc/pdcModel';
import type { NavState } from '../nav/navigator';
import type { VehicleSpec } from '../vehicle/spec';
import type { InfoContent } from './controller';

/** 1인칭 실내 센터 디스플레이: 3인칭 플로팅 패널과 같은 상태(content/카메라/PDC/내비)를 그린다. */
export interface CenterData {
  content: InfoContent;
  cam: HTMLCanvasElement;
  guide: HTMLCanvasElement;
  navCanvas: HTMLCanvasElement | null;
  spec: VehicleSpec;
  pdc: PdcState | null;
  /** 3D 서라운드뷰 캔버스(+경고선) — 있으면 센서 PDC 대신 사용 */
  surround?: HTMLCanvasElement | null;
  surroundOv?: HTMLCanvasElement | null;
  pdcView?: 'surround' | 'sensor';
  surroundSupported?: boolean;
  palette: PdcPaletteId;
  viewName: string;
  gear: string;
  nav: NavState;
  sensorOn: boolean;
  soundOn: boolean;
  cameraMode: string;
  mission: string;
  /** 후방카메라 전용 차량: 카메라 화면 선택 항목 없음 */
  rearOnly?: boolean;
}

/** 실내 디스플레이에서 눌러 조작할 수 있는 영역 (캔버스 좌표) */
export type CabinAction = 'sensor' | 'sound' | 'camera' | 'settings' | 'content' | 'expand' | 'pdcMode';
export interface CabinHit {
  action: CabinAction;
  x: number;
  y: number;
  w: number;
  h: number;
}
const MENU_ACTION: Record<string, CabinAction> = { '주차 보조': 'sensor', '경고음': 'sound', '카메라 화면': 'camera', '설정': 'settings', '화면 전환': 'content', '표시 방식': 'pdcMode' };

const MENU = (d: CenterData): [string, string][] => {
  const m: [string, string][] = [
    ['주차 보조', d.sensorOn ? '켜짐' : '꺼짐'],
    ['경고음', d.soundOn ? '켜짐' : '꺼짐'],
    ['카메라 화면', d.cameraMode],
    ['표시 방식', (d.pdcView ?? 'surround') === 'surround' ? '3D 서라운드' : '센서'],
    ['화면 전환', d.content === 'parking' ? '→ 내비' : '→ 주차'],
    ['설정', ''],
  ];
  return m.filter((x) => (x[0] !== '카메라 화면' || !d.rearOnly) && (x[0] !== '표시 방식' || d.surroundSupported));
};

export function drawCenterScreen(ctx: CanvasRenderingContext2D, w: number, h: number, d: CenterData): CabinHit[] {
  const hits: CabinHit[] = [];
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, w, h);
  // 상단 라인
  const top = Math.round(h * 0.11);
  ctx.fillStyle = '#0d131a';
  ctx.fillRect(0, 0, w, top);
  ctx.fillStyle = '#d9531e';
  ctx.fillRect(0, top - 2, w * 0.55, 2);
  ctx.fillStyle = '#9aa8b8';
  ctx.font = `600 ${Math.round(top * 0.5)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(d.content === 'parking' ? '주차 보조' : '내비게이션', 12, top / 2);
  ctx.fillStyle = d.gear === 'R' ? '#e5372f' : '#8fb8ff';
  ctx.fillText(d.gear, 12 + ctx.measureText(d.content === 'parking' ? '주차 보조  ' : '내비게이션  ').width, top / 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9aa8b8';
  ctx.fillText(d.content === 'parking' ? d.viewName : d.mission, w - 12, top / 2);
  const bh = h - top;
  const sideW = Math.round(w * 0.2);
  const midW = Math.round(w * 0.24);
  const mainW = w - sideW - midW;
  // 메인(카메라 / 지도)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, mainW, bh);
  ctx.clip();
  if (d.content === 'parking') {
    ctx.drawImage(d.cam, 0, top, mainW, mainW * (9 / 16) > bh ? bh : mainW * (9 / 16));
    ctx.drawImage(d.guide, 0, top, mainW, mainW * (9 / 16) > bh ? bh : mainW * (9 / 16));
  } else if (d.navCanvas) {
    ctx.drawImage(d.navCanvas, 0, top, mainW, bh);
  }
  ctx.restore();
  // 중앙(PDC / 안내)
  ctx.fillStyle = '#0b1017';
  ctx.fillRect(mainW, top, midW, bh);
  if (d.content === 'parking') {
    if (d.surround && d.surround.width > 0) {
      ctx.drawImage(d.surround, mainW, top, midW, bh - 18);
      if (d.surroundOv) ctx.drawImage(d.surroundOv, mainW, top, midW, bh - 18);
    } else drawPdcCanvas(ctx, mainW, top, midW, bh - 18, d.spec, d.pdc, d.palette);
    ctx.fillStyle = '#c6d1dc';
    ctx.font = `${Math.round(h * 0.055)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(d.pdc?.statusText ?? '', mainW + midW / 2, h - 10);
  } else {
    ctx.fillStyle = '#e8edf3';
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(h * 0.17)}px sans-serif`;
    const arrow = { left: '↰', right: '↱', straight: '↑', uturn: '↶', arrive: '●' }[d.nav.next.type];
    ctx.fillText(arrow, mainW + midW / 2, top + bh * 0.3);
    ctx.font = `600 ${Math.round(h * 0.07)}px sans-serif`;
    ctx.fillText(d.nav.text, mainW + midW / 2, top + bh * 0.58);
    ctx.font = `${Math.round(h * 0.06)}px sans-serif`;
    ctx.fillStyle = '#9aa8b8';
    if (d.nav.status === 'guiding') ctx.fillText(`${Math.round(d.nav.next.distM)} m`, mainW + midW / 2, top + bh * 0.74);
  }
  // 사이드 메뉴 (3인칭 패널과 같은 4개 항목, 고정 위치)
  ctx.fillStyle = '#0d1319';
  ctx.fillRect(mainW + midW, top, sideW, bh);
  const items = MENU(d);
  const ih = bh / items.length;
  items.forEach(([a, b], i) => {
    const y = top + i * ih;
    hits.push({ action: MENU_ACTION[a], x: mainW + midW, y, w: sideW, h: ih });
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.beginPath();
    ctx.moveTo(mainW + midW, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8edf3';
    ctx.font = `600 ${Math.round(h * 0.06)}px sans-serif`;
    ctx.fillText(a, mainW + midW + 10, y + ih * 0.4);
    ctx.fillStyle = b === '꺼짐' ? '#d86b5c' : '#7fc24d';
    ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
    ctx.fillText(b, mainW + midW + 10, y + ih * 0.72);
  });
  hits.push({ action: 'expand', x: 0, y: top, w: mainW + midW, h: bh });
  return hits;
}

export interface ClusterData {
  speedKmh: number;
  gear: string;
  /** 엔진 회전수 — 물리 엔진에 없는 **시뮬레이션 값**(속도/가속에서 만든 근사). 화면에도 "시뮬레이션"으로 표기한다 */
  rpm: number;
  /** 엔진 상태 (OFF 이면 계기판에 표시) */
  engineState?: string;
  signalLeft: boolean;
  signalRight: boolean;
  hazard: boolean;
  lightMode: string;
  lowBeam: boolean;
  highBeam?: boolean;
  handbrake: boolean;
  /** PDC 전체 경고 단계(센서 거리 → 색), 숫자는 표시하지 않는다 */
  pdcLevel: string;
  pdcOn?: boolean;
  steerDeg: number;
  /** 핸들 각도(도, 왼쪽 +, ±540) */
  wheelDeg?: number;
  /** 현재 층(다층 맵), 없으면 null */
  floor?: string | null;
  mission?: string;
  /** 간단한 내비 안내 (있을 때만) */
  navText?: string;
  vehicleName?: string;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif';
const PDC_COL: Record<string, string> = { critical: '#ff3b30', near: '#f08a2b', mid: '#f1d13a', far: '#7fc24d' };

/** 270° 원형 게이지: 눈금/라벨/값 호. a0=135°, a1=405° (아래 가운데가 열림) */
function dial(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, frac: number, o: { max: number; major: number; minor: number; labelDiv: number; color: string; redFrom?: number; fontPx: number }): void {
  const a0 = Math.PI * 0.75;
  const span = Math.PI * 1.5;
  ctx.lineCap = 'round';
  ctx.lineWidth = R * 0.07;
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.arc(cx, cy, R, a0, a0 + span);
  ctx.stroke();
  if (o.redFrom !== undefined) {
    ctx.strokeStyle = 'rgba(240,138,43,.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0 + span * (o.redFrom / o.max), a0 + span);
    ctx.stroke();
  }
  ctx.strokeStyle = o.color;
  ctx.lineWidth = R * 0.085;
  ctx.beginPath();
  ctx.arc(cx, cy, R, a0, a0 + span * Math.max(0.003, Math.min(1, frac)));
  ctx.stroke();
  // 눈금
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= o.max + 1e-6; v += o.minor) {
    const a = a0 + span * (v / o.max);
    const isMajor = Math.abs(v / o.major - Math.round(v / o.major)) < 1e-6;
    const r0 = R - R * (isMajor ? 0.2 : 0.13);
    const r1 = R - R * 0.07;
    ctx.strokeStyle = isMajor ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.3)';
    ctx.lineWidth = isMajor ? R * 0.028 : R * 0.016;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.font = `600 ${o.fontPx}px ${FONT}`;
      const rl = R - R * 0.36;
      ctx.fillText(String(Math.round(v / o.labelDiv)), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
    }
  }
}

const chip = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, on: boolean, col: string, fontPx: number): void => {
  ctx.fillStyle = on ? col + '33' : 'rgba(255,255,255,.05)';
  ctx.strokeStyle = on ? col : 'rgba(255,255,255,.14)';
  ctx.lineWidth = Math.max(1, h * 0.06);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h * 0.3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,.35)';
  ctx.font = `700 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + h * 0.04);
};

const arrow = (ctx: CanvasRenderingContext2D, x: number, y: number, s: number, dir: 1 | -1, on: boolean): void => {
  ctx.fillStyle = on ? '#4cd964' : 'rgba(255,255,255,.1)';
  ctx.beginPath();
  ctx.moveTo(x + dir * s, y);
  ctx.lineTo(x - dir * s * 0.2, y - s * 0.8);
  ctx.lineTo(x - dir * s * 0.2, y - s * 0.32);
  ctx.lineTo(x - dir * s, y - s * 0.32);
  ctx.lineTo(x - dir * s, y + s * 0.32);
  ctx.lineTo(x - dir * s * 0.2, y + s * 0.32);
  ctx.lineTo(x - dir * s * 0.2, y + s * 0.8);
  ctx.closePath();
  ctx.fill();
};

/**
 * 1인칭 디지털 계기판 (v0.4.9). 검정 바탕 + 흰색 중심, 경고만 색상.
 *  좌: 속도계(디지털 속도 + 눈금) / 중앙: 기어(P R N D) · 핸들 각도 · 층/미션 · 점등 상태 / 우: 회전계(시뮬레이션 값, 명시).
 *  데이터는 모두 실제 게임 상태이며 RPM 만 시뮬레이션 근사(화면에 표기)다.
 */
export function drawCluster(ctx: CanvasRenderingContext2D, w: number, h: number, c: ClusterData): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0c1016');
  bg.addColorStop(1, '#030405');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const reverse = c.gear === 'R';
  const accent = reverse ? '#ff7a6a' : '#e9eef5';
  const R = h * 0.4;
  const cy = h * 0.55;
  const lx = w * 0.205;
  const rx = w * 0.795;
  // ---- 속도계 / 회전계 ----
  dial(ctx, lx, cy, R, c.speedKmh / 60, { max: 60, major: 10, minor: 5, labelDiv: 1, color: accent, fontPx: Math.round(h * 0.075) });
  dial(ctx, rx, cy, R, c.rpm / 6000, { max: 6000, major: 1000, minor: 500, labelDiv: 1000, color: '#9fb4cf', redFrom: 5000, fontPx: Math.round(h * 0.075) });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.3)}px ${FONT}`;
  ctx.fillText(String(Math.round(c.speedKmh)), lx, cy - h * 0.02);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = `600 ${Math.round(h * 0.075)}px ${FONT}`;
  ctx.fillText('km/h', lx, cy + h * 0.17);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.17)}px ${FONT}`;
  ctx.fillText((Math.round(c.rpm / 10) * 10).toString(), rx, cy - h * 0.02);
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  ctx.font = `600 ${Math.round(h * 0.062)}px ${FONT}`;
  ctx.fillText(c.engineState && c.engineState !== 'RUNNING' ? `ENGINE ${c.engineState}` : 'RPM · 시뮬레이션', rx, cy + h * 0.15);
  // ---- 중앙: 기어 ----
  const cx = w / 2;
  ctx.fillStyle = reverse ? '#ff7a6a' : '#ffffff';
  ctx.font = `800 ${Math.round(h * 0.34)}px ${FONT}`;
  ctx.fillText(c.gear, cx, h * 0.4);
  ctx.font = `700 ${Math.round(h * 0.085)}px ${FONT}`;
  ['P', 'R', 'N', 'D'].forEach((g, i) => {
    ctx.fillStyle = g === c.gear ? (g === 'R' ? '#ff7a6a' : '#ffffff') : 'rgba(255,255,255,.22)';
    ctx.fillText(g, cx + (i - 1.5) * h * 0.14, h * 0.66);
  });
  // 핸들 각도 아이콘 + 값
  const wd = c.wheelDeg ?? c.steerDeg * 8;
  ctx.save();
  ctx.translate(cx - h * 0.2, h * 0.8);
  ctx.rotate((-wd * Math.PI) / 180);
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = h * 0.016;
  ctx.beginPath();
  ctx.arc(0, 0, h * 0.062, 0, Math.PI * 2);
  ctx.moveTo(-h * 0.062, 0);
  ctx.lineTo(h * 0.062, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, h * 0.062);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.font = `600 ${Math.round(h * 0.07)}px ${FONT}`;
  ctx.textAlign = 'left';
  const sd = Math.round(Math.abs(wd));
  ctx.fillText(`${sd}°${sd < 3 ? '' : wd > 0 ? ' 좌' : ' 우'}`, cx - h * 0.1, h * 0.8);
  // ---- 상단: 방향지시등 / 층 / 미션 ----
  arrow(ctx, w * 0.09, h * 0.1, h * 0.065, -1, c.signalLeft || c.hazard);
  arrow(ctx, w * 0.91, h * 0.1, h * 0.065, 1, c.signalRight || c.hazard);
  ctx.textAlign = 'center';
  if (c.floor) chip(ctx, cx - w * 0.1, h * 0.1, h * 0.26, h * 0.1, c.floor, true, '#6fa8ff', Math.round(h * 0.07));
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.font = `600 ${Math.round(h * 0.066)}px ${FONT}`;
  const mission = (c.navText ?? c.mission ?? '').slice(0, 20);
  ctx.fillText(mission, c.floor ? cx + h * 0.1 : cx, h * 0.1);
  // ---- 하단: 점등/경고 ----
  const by = h * 0.93;
  const cw = h * 0.3;
  const ch = h * 0.1;
  chip(ctx, w * 0.07, by, cw, ch, c.lightMode === 'AUTO' ? 'AUTO' : c.lightMode, c.lowBeam && !c.highBeam, '#5da2ff', Math.round(h * 0.062));
  chip(ctx, w * 0.07 + cw * 1.12, by, cw * 0.72, ch, '상향', !!c.highBeam, '#5da2ff', Math.round(h * 0.062));
  chip(ctx, w * 0.5 - cw * 0.3, by, cw * 0.6, ch, 'P', c.handbrake, '#ff5a4d', Math.round(h * 0.07));
  chip(ctx, w * 0.5 + cw * 0.6, by, cw * 0.9, ch, '비상등', c.hazard, '#ffb020', Math.round(h * 0.058));
  const lvlCol = PDC_COL[c.pdcLevel];
  const pdcOn = c.pdcOn !== false;
  chip(ctx, w * 0.93 - cw * 0.5, by, cw * 1.1, ch, pdcOn ? 'PDC' : 'PDC OFF', pdcOn && !!lvlCol, lvlCol ?? '#7fc24d', Math.round(h * 0.062));
  if (c.pdcLevel === 'critical' && pdcOn) {
    ctx.fillStyle = '#ff3b30';
    ctx.font = `800 ${Math.round(h * 0.075)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('장애물 근접', cx, h * 0.54);
  }
}
