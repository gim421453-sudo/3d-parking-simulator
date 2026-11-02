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
export type CabinAction = 'sensor' | 'sound' | 'camera' | 'settings' | 'content' | 'expand';
export interface CabinHit {
  action: CabinAction;
  x: number;
  y: number;
  w: number;
  h: number;
}
const MENU_ACTION: Record<string, CabinAction> = { '주차 보조': 'sensor', '경고음': 'sound', '카메라 화면': 'camera', '설정': 'settings', '화면 전환': 'content' };

const MENU = (d: CenterData): [string, string][] => {
  const m: [string, string][] = [
    ['주차 보조', d.sensorOn ? '켜짐' : '꺼짐'],
    ['경고음', d.soundOn ? '켜짐' : '꺼짐'],
    ['카메라 화면', d.cameraMode],
    ['화면 전환', d.content === 'parking' ? '→ 내비' : '→ 주차'],
    ['설정', ''],
  ];
  return d.rearOnly ? m.filter((x) => x[0] !== '카메라 화면') : m;
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
  rpm: number;
  signalLeft: boolean;
  signalRight: boolean;
  hazard: boolean;
  lightMode: string;
  lowBeam: boolean;
  handbrake: boolean;
  pdcLevel: string;
  steerDeg: number;
}

/** 1인칭 계기판: 속도, 변속 상태, 방향지시등, 경고등, 전조등/주차브레이크, PDC 경고 요약 */
export function drawCluster(ctx: CanvasRenderingContext2D, w: number, h: number, c: ClusterData): void {
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h * 0.54;
  const R = h * 0.4;
  // 속도 링
  ctx.lineCap = 'round';
  ctx.lineWidth = h * 0.05;
  ctx.strokeStyle = 'rgba(255,255,255,.1)';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25);
  ctx.stroke();
  ctx.strokeStyle = c.gear === 'R' ? '#ff7a6a' : '#8fb8ff';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * Math.min(1, c.speedKmh / 50)));
  ctx.stroke();
  ctx.fillStyle = '#e8edf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(h * 0.34)}px sans-serif`;
  ctx.fillText(String(Math.round(c.speedKmh)), cx, cy - h * 0.02);
  ctx.fillStyle = '#66758a';
  ctx.font = `${Math.round(h * 0.09)}px sans-serif`;
  ctx.fillText('km/h', cx, cy + h * 0.22);
  // 기어 (P R N D)
  ctx.font = `700 ${Math.round(h * 0.14)}px sans-serif`;
  ['P', 'R', 'N', 'D'].forEach((g, i) => {
    ctx.fillStyle = g === c.gear ? (g === 'R' ? '#ff7a6a' : '#ffffff') : '#3a4656';
    ctx.fillText(g, cx - h * 0.35 + i * h * 0.23, h * 0.9);
  });
  // 좌/우 정보
  ctx.textAlign = 'left';
  ctx.fillStyle = '#9aa8b8';
  ctx.font = `${Math.round(h * 0.09)}px sans-serif`;
  ctx.fillText(`RPM ${Math.round(c.rpm)} (시뮬레이션)`, 10, h * 0.1);
  ctx.textAlign = 'right';
  ctx.fillText(`조향 ${Math.round(Math.abs(c.steerDeg))}°`, w - 10, h * 0.1);
  // 방향지시등
  ctx.font = `700 ${Math.round(h * 0.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = c.signalLeft || c.hazard ? '#7fe08a' : '#1c2530';
  ctx.fillText('◀', w * 0.1, cy);
  ctx.fillStyle = c.signalRight || c.hazard ? '#7fe08a' : '#1c2530';
  ctx.fillText('▶', w * 0.9, cy);
  // 상태등
  ctx.font = `700 ${Math.round(h * 0.1)}px sans-serif`;
  ctx.fillStyle = c.lowBeam ? '#5da2ff' : '#2a3544';
  ctx.fillText(c.lightMode, w * 0.1, h * 0.8);
  ctx.fillStyle = c.handbrake ? '#ff5a4d' : '#2a3544';
  ctx.fillText('(P)', w * 0.9, h * 0.8);
  const warn = c.pdcLevel === 'critical' ? '#ff3b30' : c.pdcLevel === 'near' ? '#f08a2b' : c.pdcLevel === 'mid' ? '#f1d13a' : c.pdcLevel === 'far' ? '#7fc24d' : '#2a3544';
  ctx.fillStyle = warn;
  ctx.fillText('PDC', w * 0.9, h * 0.55 + h * 0.2);
}
