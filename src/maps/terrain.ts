import { worldToLocal } from '../core/math';

/**
 * 다층 주차타워용 지형(높이) 데이터. 맵 데이터와 3D 에셋을 분리하기 위해 순수 데이터 + 순수 함수만 둔다.
 * - deck:   평평한 층 바닥(회전 가능한 직사각형, 구멍(hole) 가능). y = 바닥 윗면 높이
 * - ramp:   직선 경사로. (x,z) = 시작점 중앙, rot = 진행 방향(heading 규칙: 0 → +z, + → 왼쪽), 시작 높이 y0 → 끝 높이 y1
 * - spiral: 나선형(골뱅이) 경사로. 중심 (cx,cz), 반경 r0~r1, 각도 th0→th1 (x=cx+r·cosθ, z=cz+r·sinθ), 높이 y0→y1 (각도에 선형)
 * 같은 (x,z) 에 여러 층이 겹치므로 `groundAt` 은 차량의 현재 높이(yHint)에 가장 가까운 면을 고른다(층 점프 방지).
 */
export interface Rect2 {
  x: number;
  z: number;
  w: number;
  d: number;
  rot?: number;
}
export interface DeckSurface {
  kind: 'deck';
  id: string;
  rect: Rect2;
  y: number;
  holes?: (Rect2 | CircleHole)[];
  thickness?: number;
}
export interface CircleHole {
  cx: number;
  cz: number;
  r: number;
}
export interface RampSurface {
  kind: 'ramp';
  id: string;
  x: number;
  z: number;
  rot: number;
  length: number;
  width: number;
  y0: number;
  y1: number;
}
export interface SpiralSurface {
  kind: 'spiral';
  id: string;
  cx: number;
  cz: number;
  r0: number;
  r1: number;
  th0: number;
  th1: number;
  y0: number;
  y1: number;
}
export type TerrainSurface = DeckSurface | RampSurface | SpiralSurface;

export interface TerrainLevel {
  id: string;
  name: string; // 표시 이름 (예: 1F)
  y: number;
}
export interface Terrain {
  surfaces: TerrainSurface[];
  levels: TerrainLevel[];
}

const inRect = (r: Rect2, x: number, z: number): boolean => {
  const l = worldToLocal(r.x, r.z, r.rot ?? 0, x, z);
  return Math.abs(l.x) <= r.w / 2 && Math.abs(l.z) <= r.d / 2;
};
const isCircle = (h: Rect2 | CircleHole): h is CircleHole => (h as CircleHole).r !== undefined;
const inHole = (h: Rect2 | CircleHole, x: number, z: number): boolean => (isCircle(h) ? (x - h.cx) ** 2 + (z - h.cz) ** 2 < h.r * h.r : inRect(h, x, z));

/** 각도 정규화 [0, 2π) */
const mod2pi = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

/** 면이 (x,z) 를 덮으면 그 지점의 윗면 높이, 아니면 null */
export function surfaceHeight(s: TerrainSurface, x: number, z: number): number | null {
  if (s.kind === 'deck') {
    if (!inRect(s.rect, x, z)) return null;
    if (s.holes?.some((h) => inHole(h, x, z))) return null;
    return s.y;
  }
  if (s.kind === 'ramp') {
    const dx = x - s.x;
    const dz = z - s.z;
    const fx = Math.sin(s.rot);
    const fz = Math.cos(s.rot);
    const u = dx * fx + dz * fz;
    const v = dx * -fz + dz * fx;
    if (u < 0 || u > s.length || Math.abs(v) > s.width / 2) return null;
    return s.y0 + ((s.y1 - s.y0) * u) / s.length;
  }
  const dx = x - s.cx;
  const dz = z - s.cz;
  const r = Math.hypot(dx, dz);
  if (r < s.r0 || r > s.r1) return null;
  const span = s.th1 - s.th0;
  const th = Math.atan2(dz, dx);
  const k = span >= 0 ? mod2pi(th - s.th0) : mod2pi(s.th0 - th);
  if (k > Math.abs(span)) return null;
  return s.y0 + (s.y1 - s.y0) * (k / Math.abs(span));
}

/**
 * 차량 높이 힌트(yHint) ±maxStep 이내의 지면 중 **가장 높은 면**. 없으면 null (= 올라설 수 있는 면이 없음).
 * "가장 높은 면"을 고르는 이유: 경사로/나선 시작부는 같은 높이의 바닥(deck) 위에서 시작하므로, 가까운 면을 고르면
 * 차가 바닥에 붙어 경사로로 올라가지 못한다. 다른 층(3.2m 차이)은 maxStep 밖이라 섞이지 않는다.
 */
export function groundAt(t: Terrain, x: number, z: number, yHint: number, maxStep = 0.7): number | null {
  let best: number | null = null;
  for (const s of t.surfaces) {
    const h = surfaceHeight(s, x, z);
    if (h === null) continue;
    if (Math.abs(h - yHint) <= maxStep && (best === null || h > best)) best = h;
  }
  return best;
}

/** (x,z) 위쪽으로 가장 가까운 층 바닥 아랫면 높이 (천장). 없으면 Infinity. 카메라 높이 제한용 */
export function ceilingAbove(t: Terrain, x: number, z: number, y: number): number {
  let best = Infinity;
  for (const s of t.surfaces) {
    if (s.kind !== 'deck') continue;
    const h = surfaceHeight(s, x, z);
    if (h === null) continue;
    const bottom = h - (s.thickness ?? 0.3);
    if (bottom > y + 0.4 && bottom < best) best = bottom;
  }
  return best;
}

/** 현재 높이에 가장 가까운 층 */
export function levelAt(t: Terrain, y: number): TerrainLevel {
  let best = t.levels[0];
  for (const l of t.levels) if (Math.abs(l.y - y) < Math.abs(best.y - y)) best = l;
  return best;
}
