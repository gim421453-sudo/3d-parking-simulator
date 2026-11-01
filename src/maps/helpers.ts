import { VEHICLES } from '../vehicle/spec';
import type { MapData, MapSlot, ObstacleDef, PaintRect } from './types';

export const WHITE = 0xf4f4f4;
export const YELLOW = 0xf2c200;

const CAR_COLORS = [0xb8b8c0, 0x222428, 0xf0f0f0, 0x8a1f2a, 0x1f4d8a, 0x6a7a86, 0xc9b27a, 0x2e6b46];

/** 결정적 의사난수 (같은 id → 항상 같은 값) */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function wallBox(id: string, cx: number, cz: number, w: number, d: number, h: number, tag: ObstacleDef['tag'] = 'wall', color = 0x9a9a96, rot = 0): ObstacleDef {
  return { id, tag, shape: 'box', x: cx, z: cz, w, d, h, color, rot };
}

/** 맵 경계 외벽 4면 */
export function perimeter(bounds: MapData['bounds'], thick: number, h: number, color: number, prefix = 'edge'): ObstacleDef[] {
  const { minX, maxX, minZ, maxZ } = bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  return [
    wallBox(`${prefix}-n`, (minX + maxX) / 2, maxZ + thick / 2, w + thick * 2, thick, h, 'wall', color),
    wallBox(`${prefix}-s`, (minX + maxX) / 2, minZ - thick / 2, w + thick * 2, thick, h, 'wall', color),
    wallBox(`${prefix}-e`, maxX + thick / 2, (minZ + maxZ) / 2, thick, d, h, 'wall', color),
    wallBox(`${prefix}-w`, minX - thick / 2, (minZ + maxZ) / 2, thick, d, h, 'wall', color),
  ];
}

export function cone(id: string, x: number, z: number): ObstacleDef {
  return { id, tag: 'cone', shape: 'cyl', x, z, r: 0.2, h: 0.72, color: 0xff6a1a };
}

export function pillar(id: string, x: number, z: number, size: number, h: number, color = 0xb4b2ac): ObstacleDef {
  return { id, tag: 'pillar', shape: 'box', x, z, w: size, d: size, h, color };
}

export function lamp(id: string, x: number, z: number): ObstacleDef {
  return { id, tag: 'lamp', shape: 'cyl', x, z, r: 0.14, h: 6.5, color: 0x4a4f55 };
}

export function tree(id: string, x: number, z: number): ObstacleDef {
  return { id, tag: 'tree', shape: 'cyl', x, z, r: 0.28, h: 6, color: 0x5a3d26 };
}

export function drum(id: string, x: number, z: number): ObstacleDef {
  return { id, tag: 'drum', shape: 'cyl', x, z, r: 0.3, h: 0.9, color: 0x2a6bd0 };
}

export function parkedCar(id: string, x: number, z: number, heading: number, specIdx: number): ObstacleDef {
  const spec = VEHICLES[specIdx % VEHICLES.length];
  const j = hash01(id);
  return {
    id,
    tag: 'car',
    shape: 'box',
    x: x + (j - 0.5) * 0.14,
    z: z + (hash01(id + 'z') - 0.5) * 0.3,
    w: spec.width,
    d: spec.length,
    h: spec.height,
    rot: heading + (hash01(id + 'r') - 0.5) * 0.035,
    carSpec: specIdx,
    color: CAR_COLORS[Math.floor(hash01(id + 'c') * CAR_COLORS.length)],
  };
}

export interface RowOptions {
  prefix: string;
  startX: number;
  z: number;
  count: number;
  pitch: number;
  w: number;
  l: number;
  dir: number;
  style?: 'u' | 'box';
  /** 주차 차량이 있는 인덱스를 제외하고 비워둘 인덱스 */
  empty: number[];
}

/** 가로로 늘어선 주차 구획 한 줄 + 주차된 차량 */
export function slotRow(o: RowOptions): { slots: MapSlot[]; cars: ObstacleDef[] } {
  const slots: MapSlot[] = [];
  const cars: ObstacleDef[] = [];
  for (let i = 0; i < o.count; i++) {
    const x = o.startX + o.pitch * i;
    slots.push({ id: `${o.prefix}-${i}`, x, z: o.z, w: o.w, l: o.l, dir: o.dir, style: o.style ?? 'u' });
    if (!o.empty.includes(i)) cars.push(parkedCar(`${o.prefix}-car${i}`, x, o.z, o.dir, i + o.prefix.length));
  }
  return { slots, cars };
}

/** 구획 선 도색: 로컬 좌표(가로 x, 세로 z)에서 사각형 선을 만든다 */
export function slotPaint(s: MapSlot, lineW = 0.1): PaintRect[] {
  const out: PaintRect[] = [];
  const add = (lx: number, lz: number, w: number, d: number): void => {
    const c = Math.cos(s.dir);
    const sn = Math.sin(s.dir);
    out.push({ x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c, w, d, rot: s.dir, color: WHITE });
  };
  // 좌우 긴 선
  add(s.w / 2, 0, lineW, s.l + lineW);
  add(-s.w / 2, 0, lineW, s.l + lineW);
  // 안쪽 끝선(차가 들어가는 방향 끝)
  add(0, s.l / 2, s.w + lineW, lineW);
  if (s.style === 'box') add(0, -s.l / 2, s.w + lineW, lineW);
  return out;
}
