import { localToWorld, worldToLocal } from '../core/math';
import type { MapData } from '../maps/types';
import type { VehicleSpec } from '../vehicle/spec';
import type { NavState } from './navigator';

const TAG: Record<string, string> = { wall: '#6f7882', pillar: '#9aa1a8', cone: '#ff7a2a', barrier: '#d8d8d8', building: '#7d7466', lamp: '#d9c45a', tree: '#3d7a46', planter: '#566b47', curb: '#555b62', drum: '#3a79e0', car: '#51627a' };
const SURF: Record<string, string> = { asphalt: '#1f2a35', concrete: '#27303a', sidewalk: '#3a424b', grass: '#1d3524' };

/** 내비게이션 지도 (차량 진행 방향이 위쪽, 맵의 실제 데이터를 그린다) */
export function drawNavMap(ctx: CanvasRenderingContext2D, w: number, h: number, map: MapData, pose: { x: number; z: number; heading: number }, nav: NavState, spec: VehicleSpec, windowM = 42): void {
  const s = h / windowM;
  const cx = w / 2;
  const cy = h * 0.68;
  const P = (x: number, z: number): [number, number] => {
    const l = worldToLocal(pose.x, pose.z, pose.heading, x, z);
    return [cx - l.x * s, cy - l.z * s];
  };
  ctx.fillStyle = '#0b1117';
  ctx.fillRect(0, 0, w, h);
  const poly = (pts: [number, number][], fill: string | null, stroke: string | null = null, lw = 1): void => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  };
  const near = (x: number, z: number, r: number): boolean => Math.hypot(x - pose.x, z - pose.z) < windowM * 1.4 + r;
  for (const sf of map.surfaces) {
    const c = [[-sf.w / 2, -sf.d / 2], [sf.w / 2, -sf.d / 2], [sf.w / 2, sf.d / 2], [-sf.w / 2, sf.d / 2]].map(([dx, dz]) => P(sf.x + dx, sf.z + dz));
    poly(c as [number, number][], SURF[sf.kind] ?? '#222');
  }
  for (const sl of map.slots) {
    if (!near(sl.x, sl.z, 8)) continue;
    const c = [[-sl.w / 2, -sl.l / 2], [sl.w / 2, -sl.l / 2], [sl.w / 2, sl.l / 2], [-sl.w / 2, sl.l / 2]].map(([a, b]) => {
      const q = localToWorld(sl.x, sl.z, sl.dir, a, b);
      return P(q.x, q.z);
    });
    const isDest = nav.destination?.id === sl.id;
    poly(c as [number, number][], isDest ? 'rgba(53,224,122,.35)' : null, isDest ? '#35e07a' : 'rgba(255,255,255,.28)', isDest ? 2 : 1);
  }
  for (const o of map.obstacles) {
    if (!near(o.x, o.z, 6)) continue;
    ctx.fillStyle = TAG[o.tag] ?? '#777';
    if (o.shape === 'cyl') {
      const [x, y] = P(o.x, o.z);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, (o.r ?? 0.3) * s), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const hw = (o.w ?? 1) / 2;
      const hd = (o.d ?? 1) / 2;
      const c = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => {
        const q = localToWorld(o.x, o.z, o.rot ?? 0, a, b);
        return P(q.x, q.z);
      });
      poly(c as [number, number][], TAG[o.tag] ?? '#777');
    }
  }
  // 경로
  if (nav.route && nav.route.points.length > 1) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    nav.route.points.forEach((p, i) => {
      const [x, y] = P(p.x, p.z);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = Math.max(6, 1.6 * s);
    ctx.stroke();
    ctx.strokeStyle = nav.offRoute ? '#f1d13a' : '#5da2ff';
    ctx.lineWidth = Math.max(4, 1.1 * s);
    ctx.stroke();
  }
  if (nav.destination) {
    const [dx, dy] = P(nav.destination.x, nav.destination.z);
    ctx.fillStyle = '#35e07a';
    ctx.beginPath();
    ctx.arc(dx, dy, Math.max(5, 0.9 * s), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#06210f';
    ctx.font = `700 ${Math.max(9, 0.9 * s)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', dx, dy + 0.5);
  }
  // 내 차 (진행 방향 위)
  const cw = Math.max(8, spec.width * s);
  const cl = Math.max(14, spec.length * s);
  ctx.fillStyle = '#e8f1ff';
  ctx.strokeStyle = '#2a6ee0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cx - cw / 2, cy - cl / 2, cw, cl, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2a6ee0';
  ctx.beginPath();
  ctx.moveTo(cx, cy - cl / 2 - 5);
  ctx.lineTo(cx - cw / 2, cy - cl / 2 + 4);
  ctx.lineTo(cx + cw / 2, cy - cl / 2 + 4);
  ctx.closePath();
  ctx.fill();
}
