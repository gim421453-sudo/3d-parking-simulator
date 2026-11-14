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
  // ---- v0.5.5 계기판 구체화 (전부 실제 게임 상태) ----
  /** 가속/브레이크 페달 입력 0~1 */
  throttle?: number;
  brake?: number;
  /** 차체 앞뒤 기울기(도, 오르막 +) */
  pitchDeg?: number;
  /** 속도계 눈금 최댓값 (speedScale) */
  speedMax?: number;
  /** 회전계 적색 구간 시작(rpm) — 엔진 프로필 */
  redline?: number;
  /** 엔진 종류 표시 (합성 프로필 이름) */
  engineLabel?: string;
  /** 시계 HH:MM */
  clock?: string;
  /** 미등(차폭등) 점등 */
  tail?: boolean;
  /** 운전자 하차 상태(기계식 주차) */
  doorOpen?: boolean;
  /** 차량이 장치에 고정된 상태 */
  locked?: 'lift' | 'mech' | null;
  /** 방향별 PDC 단계(색만) */
  zones?: { front: string; rear: string; left: string; right: string };
  /** v0.6.0 차체 손상: 부위별 0~1 과 단계 */
  damage?: { front: number; rear: number; left: number; right: number; level: 'none' | 'minor' | 'moderate' | 'severe' | 'wrecked' };
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
/** 둥근 사각형 경로 (왼쪽 위 기준) */
const rr = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
};

/** 속도계 눈금 범위: 주차 속도에서는 0~60(세밀), 빨라지면 차량 최고속도 눈금으로 넓힌다(히스테리시스로 경계에서 깜빡이지 않게) */
export function speedScale(speedKmh: number, prevMax: number, vmaxKmh: number): number {
  const wide = Math.max(120, Math.ceil(vmaxKmh / 40) * 40);
  if (prevMax <= 60) return speedKmh > 55 ? wide : 60;
  return speedKmh < 40 ? 60 : wide;
}

/** 게이지 바늘 (눈금 안쪽 → 호 바로 안쪽) */
function needle(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, frac: number, color: string): void {
  const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, frac));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = R * 0.12;
  ctx.strokeStyle = color;
  ctx.lineWidth = R * 0.035;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62);
  ctx.lineTo(cx + Math.cos(a) * R * 0.93, cy + Math.sin(a) * R * 0.93);
  ctx.stroke();
  ctx.restore();
}

/** 세로 막대 게이지(페달 입력 등): 0~1 */
function vbar(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, w: number, frac: number, color: string, label: string, fontPx: number): void {
  const f = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  rr(ctx, x - w / 2, y0, w, y1 - y0, w / 2);
  ctx.fill();
  if (f > 0.01) {
    ctx.fillStyle = color;
    const hh = (y1 - y0) * f;
    rr(ctx, x - w / 2, y1 - hh, w, hh, w / 2);
    ctx.fill();
  }
  ctx.fillStyle = f > 0.01 ? color : 'rgba(255,255,255,.4)';
  ctx.font = `700 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y1 + fontPx * 0.9);
}

/** 작은 차량 평면도 + 전/후/좌/우 PDC 단계(색만, 숫자 없음) */
function miniCar(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, z: NonNullable<ClusterData['zones']>, on: boolean, dmg?: ClusterData['damage']): void {
  const bw = s * 0.42;
  const bl = s * 0.9;
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  rr(ctx, x - bw / 2, y - bl / 2, bw, bl, bw * 0.3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(120,170,230,.5)';
  rr(ctx, x - bw * 0.36, y - bl * 0.22, bw * 0.72, bl * 0.4, bw * 0.12);
  ctx.fill();
  // 차체 손상 부위: 앞/뒤/좌/우 가장자리를 손상 정도에 따라 주황→빨강으로 칠한다(숫자 없음)
  if (dmg && dmg.level !== 'none') {
    const col = (d: number): string => `rgba(${d > 0.6 ? 255 : 255},${Math.round(170 - 150 * Math.min(1, d))},40,${Math.min(0.95, 0.25 + d)})`;
    const t = bw * 0.22;
    if (dmg.front > 0.02) {
      ctx.fillStyle = col(dmg.front);
      rr(ctx, x - bw / 2, y - bl / 2, bw, bl * 0.18, t);
      ctx.fill();
    }
    if (dmg.rear > 0.02) {
      ctx.fillStyle = col(dmg.rear);
      rr(ctx, x - bw / 2, y + bl / 2 - bl * 0.18, bw, bl * 0.18, t);
      ctx.fill();
    }
    if (dmg.left > 0.02) {
      ctx.fillStyle = col(dmg.left);
      rr(ctx, x - bw / 2, y - bl * 0.3, bw * 0.2, bl * 0.6, t * 0.5);
      ctx.fill();
    }
    if (dmg.right > 0.02) {
      ctx.fillStyle = col(dmg.right);
      rr(ctx, x + bw / 2 - bw * 0.2, y - bl * 0.3, bw * 0.2, bl * 0.6, t * 0.5);
      ctx.fill();
    }
  }
  const seg = (lv: string, x0: number, y0: number, x1: number, y1: number): void => {
    const col = on ? PDC_COL[lv] : undefined;
    ctx.strokeStyle = col ?? 'rgba(255,255,255,.14)';
    ctx.lineWidth = s * (col ? 0.075 : 0.04);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const g = s * 0.13;
  seg(z.front, x - bw * 0.42, y - bl / 2 - g, x + bw * 0.42, y - bl / 2 - g);
  seg(z.rear, x - bw * 0.42, y + bl / 2 + g, x + bw * 0.42, y + bl / 2 + g);
  seg(z.left, x - bw / 2 - g, y - bl * 0.34, x - bw / 2 - g, y + bl * 0.34);
  seg(z.right, x + bw / 2 + g, y - bl * 0.34, x + bw / 2 + g, y + bl * 0.34);
}

/** 경사계: 차체 앞뒤 기울기(피치). 다층 맵 경사로에서 실제 차량 자세를 보여 준다 */
function inclinometer(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pitchDeg: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, 0);
  ctx.lineTo(s * 0.5, 0);
  ctx.stroke();
  ctx.rotate((-Math.max(-25, Math.min(25, pitchDeg)) * Math.PI) / 180);
  const on = Math.abs(pitchDeg) >= 1;
  ctx.fillStyle = on ? '#8fd0ff' : 'rgba(255,255,255,.55)';
  // 옆에서 본 차량 실루엣 (앞 = 오른쪽)
  ctx.beginPath();
  ctx.moveTo(-s * 0.42, -s * 0.04);
  ctx.lineTo(-s * 0.4, -s * 0.16);
  ctx.lineTo(-s * 0.2, -s * 0.18);
  ctx.lineTo(-s * 0.08, -s * 0.3);
  ctx.lineTo(s * 0.14, -s * 0.3);
  ctx.lineTo(s * 0.26, -s * 0.17);
  ctx.lineTo(s * 0.42, -s * 0.13);
  ctx.lineTo(s * 0.42, -s * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#05070a';
  for (const wx of [-0.26, 0.26]) {
    ctx.beginPath();
    ctx.arc(s * wx, -s * 0.04, s * 0.075, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 계기판 (v0.5.5 구체화): 바늘 게이지 2개 + 페달 입력 막대 + PDC 평면도 + 경사계 + 경고등 줄. 표시 값은 전부 실제 게임 상태이며 RPM 만 시뮬레이션 근사(화면에 표기) */
export function drawCluster(ctx: CanvasRenderingContext2D, w: number, h: number, c: ClusterData): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0c1016');
  bg.addColorStop(1, '#030405');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const reverse = c.gear === 'R';
  const accent = reverse ? '#ff7a6a' : '#e9eef5';
  const R = h * 0.4;
  const cy = h * 0.5;
  const lx = w * 0.205;
  const rx = w * 0.795;
  const cx = w / 2;
  // 게이지 뒤 은은한 원판
  for (const gx of [lx, rx]) {
    const rg = ctx.createRadialGradient(gx, cy, R * 0.2, gx, cy, R * 1.08);
    rg.addColorStop(0, 'rgba(60,80,110,.22)');
    rg.addColorStop(1, 'rgba(60,80,110,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(gx, cy, R * 1.08, 0, Math.PI * 2);
    ctx.fill();
  }
  // ---- 속도계 / 회전계 ----
  const sMax = c.speedMax ?? 60;
  const wideS = sMax > 60;
  const rMax = Math.ceil((c.redline ?? 5000) / 1000 + 1) * 1000;
  const redFrom = c.redline ?? 5000;
  dial(ctx, lx, cy, R, c.speedKmh / sMax, { max: sMax, major: wideS ? 40 : 10, minor: wideS ? 20 : 5, labelDiv: 1, color: accent, fontPx: Math.round(h * 0.07) });
  dial(ctx, rx, cy, R, c.rpm / rMax, { max: rMax, major: 1000, minor: 500, labelDiv: 1000, color: c.rpm >= redFrom ? '#ff6a4d' : '#9fb4cf', redFrom, fontPx: Math.round(h * 0.07) });
  needle(ctx, lx, cy, R, c.speedKmh / sMax, reverse ? '#ff7a6a' : '#ffffff');
  needle(ctx, rx, cy, R, c.rpm / rMax, c.rpm >= redFrom ? '#ff6a4d' : '#cfe0f5');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.26)}px ${FONT}`;
  ctx.fillText(String(Math.round(c.speedKmh)), lx, cy - h * 0.02);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = `600 ${Math.round(h * 0.07)}px ${FONT}`;
  ctx.fillText('km/h', lx, cy + h * 0.15);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.15)}px ${FONT}`;
  ctx.fillText((Math.round(c.rpm / 10) * 10).toString(), rx, cy - h * 0.03);
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = `600 ${Math.round(h * 0.055)}px ${FONT}`;
  ctx.fillText('×1000 rpm · 시뮬레이션', rx, cy + h * 0.1);
  // 엔진 상태 (READY / ACC / OFF / 시동 중)
  const es = c.engineState ?? 'RUNNING';
  const esText = es === 'RUNNING' ? 'READY' : es === 'STARTING' ? '시동 중' : es === 'STOPPING' ? '종료 중' : es;
  ctx.fillStyle = es === 'RUNNING' ? '#7fe08a' : '#ffb020';
  ctx.font = `800 ${Math.round(h * 0.062)}px ${FONT}`;
  ctx.fillText(esText, rx, cy + h * 0.2);
  if (c.engineLabel) {
    ctx.fillStyle = 'rgba(255,255,255,.38)';
    ctx.font = `600 ${Math.round(h * 0.048)}px ${FONT}`;
    ctx.fillText(c.engineLabel, rx, h * 0.955);
  }
  // ---- 중앙: 기어 ----
  ctx.fillStyle = reverse ? '#ff7a6a' : '#ffffff';
  ctx.font = `800 ${Math.round(h * 0.3)}px ${FONT}`;
  ctx.fillText(c.gear, cx, h * 0.36);
  ctx.font = `700 ${Math.round(h * 0.075)}px ${FONT}`;
  ['P', 'R', 'N', 'D'].forEach((g, i) => {
    ctx.fillStyle = g === c.gear ? (g === 'R' ? '#ff7a6a' : '#ffffff') : 'rgba(255,255,255,.22)';
    ctx.fillText(g, cx + (i - 1.5) * h * 0.13, h * 0.56);
  });
  // 페달 입력 막대 (실제 입력값): 왼쪽 브레이크, 오른쪽 가속
  const barDx = h * 0.29;
  vbar(ctx, cx - barDx, h * 0.24, h * 0.56, h * 0.035, c.brake ?? 0, '#ff5a4d', 'B', Math.round(h * 0.05));
  vbar(ctx, cx + barDx, h * 0.24, h * 0.56, h * 0.035, c.throttle ?? 0, '#7fe08a', 'A', Math.round(h * 0.05));
  // 아랫줄: 핸들 각도 · PDC 평면도 · 경사계
  const rowY = h * 0.755;
  const wd = c.wheelDeg ?? c.steerDeg * 8;
  ctx.save();
  ctx.translate(cx - h * 0.3, rowY - h * 0.02);
  ctx.rotate((-wd * Math.PI) / 180);
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = h * 0.014;
  ctx.beginPath();
  ctx.arc(0, 0, h * 0.055, 0, Math.PI * 2);
  ctx.moveTo(-h * 0.055, 0);
  ctx.lineTo(h * 0.055, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, h * 0.055);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.font = `600 ${Math.round(h * 0.052)}px ${FONT}`;
  ctx.textAlign = 'center';
  const sd = Math.round(Math.abs(wd));
  ctx.fillText(`${sd}°${sd < 3 ? '' : wd > 0 ? ' 좌' : ' 우'}`, cx - h * 0.3, rowY + h * 0.075);
  miniCar(ctx, cx, rowY, h * 0.19, c.zones ?? { front: 'none', rear: 'none', left: 'none', right: 'none' }, c.pdcOn !== false, c.damage);
  const pitch = c.pitchDeg ?? 0;
  inclinometer(ctx, cx + h * 0.3, rowY + h * 0.02, h * 0.2, pitch);
  ctx.fillStyle = Math.abs(pitch) >= 1 ? '#8fd0ff' : 'rgba(255,255,255,.45)';
  ctx.font = `600 ${Math.round(h * 0.052)}px ${FONT}`;
  ctx.fillText(Math.abs(pitch) < 1 ? '평지' : `${pitch > 0 ? '오르막' : '내리막'} ${Math.round(Math.abs(pitch))}°`, cx + h * 0.3, rowY + h * 0.075);
  // ---- 상단: 방향지시등 / 시계 / 층 / 미션 ----
  arrow(ctx, w * 0.09, h * 0.1, h * 0.065, -1, c.signalLeft || c.hazard);
  arrow(ctx, w * 0.91, h * 0.1, h * 0.065, 1, c.signalRight || c.hazard);
  ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(h * 0.06)}px ${FONT}`;
  const mission = (c.navText ?? c.mission ?? '').slice(0, 18);
  // 층 칩 + 미션 글자를 한 덩어리로 가운데 정렬(서로 겹치지 않게 글자 폭을 잰다)
  const chipW = c.floor ? h * 0.22 : 0;
  const gap = c.floor ? h * 0.04 : 0;
  const tw = ctx.measureText(mission).width;
  const left = cx - (chipW + gap + tw) / 2;
  if (c.floor) chip(ctx, left + chipW / 2, h * 0.09, chipW, h * 0.095, c.floor, true, '#6fa8ff', Math.round(h * 0.065));
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.font = `600 ${Math.round(h * 0.06)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(mission, left + chipW + gap + tw / 2, h * 0.09);
  if (c.clock) {
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = `600 ${Math.round(h * 0.052)}px ${FONT}`;
    ctx.fillText(c.clock, lx, h * 0.955);
  }
  // ---- 중앙 경고 문구 (우선순위: 장애물 근접 > 장치 고정 > 문 열림) ----
  const pdcOn = c.pdcOn !== false;
  const dl = c.damage?.level ?? 'none';
  const warn = c.pdcLevel === 'critical' && pdcOn ? { t: '장애물 근접', col: '#ff3b30' } : dl === 'wrecked' ? { t: '차량 파손 · 운행 불가', col: '#ff3b30' } : dl === 'severe' ? { t: '차체 심한 손상', col: '#ff7a3a' } : c.locked ? { t: c.locked === 'lift' ? '리프트 고정' : '기계식 장치 고정', col: '#ffb020' } : c.doorOpen ? { t: '하차 중', col: '#ffb020' } : null;
  if (warn) {
    ctx.fillStyle = warn.col;
    ctx.font = `800 ${Math.round(h * 0.062)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(warn.t, cx, h * 0.19);
  }
  // ---- 하단: 경고등 줄 (가운데 열 폭 안에 고르게) ----
  const by = h * 0.93;
  const ch = h * 0.085;
  const fp = Math.round(h * 0.046);
  const lvlCol = PDC_COL[c.pdcLevel];
  const lamps: { t: string; on: boolean; col: string }[] = [
    { t: c.lightMode === 'AUTO' ? 'AUTO' : c.lightMode, on: c.lowBeam && !c.highBeam, col: '#5da2ff' },
    { t: '상향', on: !!c.highBeam, col: '#5da2ff' },
    { t: '미등', on: !!c.tail, col: '#7fe08a' },
    { t: 'P', on: c.handbrake, col: '#ff5a4d' },
    { t: '제동', on: (c.brake ?? 0) > 0.05, col: '#ff5a4d' },
    { t: '비상', on: c.hazard, col: '#ffb020' },
    { t: '손상', on: dl !== 'none', col: dl === 'wrecked' || dl === 'severe' ? '#ff3b30' : '#ffb020' },
    { t: pdcOn ? 'PDC' : 'PDC OFF', on: pdcOn && !!lvlCol, col: lvlCol ?? '#7fc24d' },
  ];
  const x0 = lx + R * 0.5;
  const x1 = rx - R * 0.5;
  const step = (x1 - x0) / lamps.length;
  lamps.forEach((l, i) => chip(ctx, x0 + step * (i + 0.5), by, step * 0.9, ch, l.t, l.on, l.col, fp));
}
