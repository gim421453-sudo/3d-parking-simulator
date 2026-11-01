import type { VehicleSpec } from '../vehicle/spec';
import { PDC_PALETTES, bandLevel, bandLit, outlinePoint, zoneGeometry, type PdcPaletteId, type PdcState, type ZoneBandShape } from './pdcModel';

const cache = new Map<string, ZoneBandShape[]>();

/** 센서 PDC 탑뷰를 캔버스에 그린다 (실내 센터 디스플레이용). 3인칭 패널의 SVG 와 같은 기하/상태를 사용한다. */
export function drawPdcCanvas(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, spec: VehicleSpec, st: PdcState | null, palette: PdcPaletteId): void {
  let shapes = cache.get(spec.id);
  if (!shapes) {
    shapes = zoneGeometry(spec);
    cache.set(spec.id, shapes);
  }
  const M = 1.45;
  const vbW = spec.width + M * 2;
  const vbH = spec.length + M * 2;
  const s = Math.min(w / vbW, h / vbH);
  const ox = x + w / 2;
  const oy = y + h / 2;
  const X = (lx: number): number => ox - lx * s;
  const Y = (lz: number): number => oy - lz * s;
  const pal = PDC_PALETTES[palette];
  const lv = new Map(st?.zones.map((z) => [z.id, z.level]) ?? []);
  for (const sh of shapes) {
    const lit = bandLit(lv.get(sh.sensorId) ?? 'none', sh.band);
    ctx.beginPath();
    sh.points.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.z)) : ctx.moveTo(X(p.x), Y(p.z))));
    ctx.closePath();
    ctx.globalAlpha = lit ? 1 : 0.55;
    ctx.fillStyle = lit ? pal.colors[bandLevel(sh.band)] : pal.idle;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 차체
  ctx.beginPath();
  for (let i = 0; i < 72; i++) {
    const p = outlinePoint(spec, (i / 72) * Math.PI * 2, 0);
    if (i) ctx.lineTo(X(p.x), Y(p.z));
    else ctx.moveTo(X(p.x), Y(p.z));
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(X(spec.width / 2), 0, X(-spec.width / 2), 0);
  const base = '#' + spec.color.toString(16).padStart(6, '0');
  g.addColorStop(0, base);
  g.addColorStop(0.5, '#f1f6fb');
  g.addColorStop(1, base);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(230,238,245,.7)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.stroke();
  // 유리/지붕
  const gl = (z0: number, z1: number, wTop: number, wBot: number): void => {
    ctx.beginPath();
    ctx.moveTo(X(wBot), Y(z0 * spec.length));
    ctx.lineTo(X(-wBot), Y(z0 * spec.length));
    ctx.lineTo(X(-wTop), Y(z1 * spec.length));
    ctx.lineTo(X(wTop), Y(z1 * spec.length));
    ctx.closePath();
    ctx.fillStyle = '#16212d';
    ctx.fill();
  };
  const hw = spec.width / 2;
  gl(0.2, 0.07, hw * 0.74, hw * 0.8);
  gl(-0.12, -0.25, hw * 0.76, hw * 0.74);
}
