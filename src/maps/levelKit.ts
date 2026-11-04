import { slotPaint, slotRow, wallBox, pillar, type RowOptions } from './helpers';
import type { RampSurface } from './terrain';
import type { MapSlot, ObstacleDef, PaintRect } from './types';

/**
 * 다층/경사 주차장 맵을 데이터로 조립하는 도구 (v0.4.9). 3D 외형(towerBuilder)과 무관하게 충돌체·주차칸·도색만 만든다.
 * y > 0 이면 층 데이터(y0, levelPaint), y === 0 이면 지면 데이터를 쓴다.
 */
export interface Kit {
  obstacles: ObstacleDef[];
  slots: MapSlot[];
  paint: PaintRect[];
  levelPaint: (PaintRect & { y: number })[];
}
export const newKit = (): Kit => ({ obstacles: [], slots: [], paint: [], levelPaint: [] });

const putPaint = (k: Kit, y: number, ps: PaintRect[]): void => {
  for (const p of ps) {
    if (y === 0) k.paint.push(p);
    else k.levelPaint.push({ ...p, y });
  }
};

/** 슬롯 한 줄 + 주차된 차량 + 도색 */
export function addRow(k: Kit, y: number, o: RowOptions): MapSlot[] {
  const r = slotRow(o);
  for (const s of r.slots) {
    k.slots.push({ ...s, y });
    putPaint(k, y, slotPaint(s));
  }
  for (const c of r.cars) k.obstacles.push({ ...c, y0: y });
  return r.slots;
}

/** 임의 위치/각도의 슬롯(+선택적 주차 차량) */
export function addSlot(k: Kit, y: number, s: MapSlot, car?: ObstacleDef): void {
  k.slots.push({ ...s, y });
  putPaint(k, y, slotPaint(s));
  if (car) k.obstacles.push({ ...car, y0: y });
}

export function addWall(k: Kit, y: number, id: string, cx: number, cz: number, w: number, d: number, h: number, color = 0x8e8e8a, rot = 0): void {
  k.obstacles.push({ ...wallBox(id, cx, cz, w, d, h, 'wall', color, rot), y0: y });
}
export function addPillar(k: Kit, y: number, id: string, x: number, z: number, size: number, h: number): void {
  k.obstacles.push({ ...pillar(id, x, z, size, h), y0: y });
}

/** 직사각 외곽 벽 (북/남/동/서 중 gaps 에 지정한 변의 [z0,z1] 또는 [x0,x1] 구간은 비움) */
export function addPerimeter(
  k: Kit,
  y: number,
  prefix: string,
  r: { x0: number; x1: number; z0: number; z1: number },
  h: number,
  gaps: { w?: [number, number][]; e?: [number, number][]; n?: [number, number][]; s?: [number, number][] } = {},
  t = 0.3,
): void {
  const seg = (side: 'n' | 's' | 'e' | 'w', a: number, b: number, fixed: number): void => {
    const gs = (gaps[side] ?? []).slice().sort((p, q) => p[0] - q[0]);
    let cur = a;
    const emit = (u0: number, u1: number, i: number): void => {
      if (u1 - u0 < 0.05) return;
      const c = (u0 + u1) / 2;
      const len = u1 - u0;
      if (side === 'n' || side === 's') addWall(k, y, `${prefix}-${side}${i}`, c, fixed, len, t, h);
      else addWall(k, y, `${prefix}-${side}${i}`, fixed, c, t, len, h);
    };
    gs.forEach((g, i) => {
      emit(cur, g[0], i);
      cur = g[1];
    });
    emit(cur, b, gs.length);
  };
  seg('n', r.x0 - t, r.x1 + t, r.z1 + t / 2);
  seg('s', r.x0 - t, r.x1 + t, r.z0 - t / 2);
  seg('e', r.z0, r.z1, r.x1 + t / 2);
  seg('w', r.z0, r.z1, r.x0 - t / 2);
}

/** 직선 경사로 양쪽 측벽(경사를 따라 올라가는 계단식 난간) */
export function addRampWalls(k: Kit, ramp: RampSurface, n = 11): void {
  const seg = ramp.length / n;
  const fx = Math.sin(ramp.rot);
  const fz = Math.cos(ramp.rot);
  const px = Math.cos(ramp.rot);
  const pz = -Math.sin(ramp.rot);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * seg;
    const yy = ramp.y0 + ((ramp.y1 - ramp.y0) * u) / ramp.length;
    for (const side of [1, -1]) {
      const off = side * (ramp.width / 2 + 0.15);
      k.obstacles.push({ ...wallBox(`${ramp.id}-w${side > 0 ? 'l' : 'r'}${i}`, ramp.x + fx * u + px * off, ramp.z + fz * u + pz * off, 0.3, seg + 0.02, 1.5, 'wall', 0x9a9a96, ramp.rot), y0: yy - 0.25 });
    }
  }
}

/** 나선 경사로 안/바깥 난간 */
export function addSpiralWalls(k: Kit, sp: { id: string; cx: number; cz: number; r0: number; r1: number; th0: number; th1: number; y0: number; y1: number }, steps = 40): void {
  const dth = (sp.th1 - sp.th0) / steps;
  for (let i = 0; i < steps; i++) {
    const th = sp.th0 + (i + 0.5) * dth;
    const yy = sp.y0 + ((sp.y1 - sp.y0) * (i + 0.5)) / steps - 0.25;
    for (const [tag, r] of [['o', sp.r1 + 0.15], ['i', sp.r0 - 0.15]] as const) {
      const chord = 2 * r * Math.sin(Math.abs(dth) / 2) + 0.06;
      k.obstacles.push({ ...wallBox(`${sp.id}-${tag}${i}`, sp.cx + r * Math.cos(th), sp.cz + r * Math.sin(th), 0.3, chord, 1.5, 'wall', 0x9a9a96, -th), y0: yy });
    }
  }
}

/** 바닥 구멍(경사로가 아래에서 올라오는 개구부) 가장자리 난간. open: 경사로가 도착하는 쪽 끝(난간 없음) */
export function addHoleGuards(k: Kit, y: number, id: string, h: { x0: number; x1: number; zc: number; hw: number }, open: 'x0' | 'x1'): void {
  const len = h.x1 - h.x0;
  const cx = (h.x0 + h.x1) / 2;
  addWall(k, y, `${id}-gn`, cx, h.zc + h.hw + 0.15, len + 0.6, 0.3, 1.1, 0x9a9a96);
  addWall(k, y, `${id}-gs`, cx, h.zc - h.hw - 0.15, len + 0.6, 0.3, 1.1, 0x9a9a96);
  const endX = open === 'x1' ? h.x0 - 0.15 : h.x1 + 0.15;
  addWall(k, y, `${id}-ge`, endX, h.zc, 0.3, 2 * h.hw, 1.1, 0x9a9a96);
}
