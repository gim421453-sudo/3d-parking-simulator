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
  /** 지상(y≈0) 데크는 보통 맵의 지면이 그리므로 슬래브를 만들지 않는다. true 면 강제로 슬래브를 그린다(지하층 지붕 등) */
  render?: boolean;
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
  /**
   * 양 끝의 수직 곡선(완화 구간) 길이 m. 0/생략 = 직선 경사(끝에서 경사가 갑자기 바뀜).
   * 지정하면 시작/끝에서 경사가 0 에서 부드럽게 커졌다 줄어든다 → 차체 피치가 서서히 변하고 하부 접촉(배 긁힘)이 줄어든다.
   */
  ease?: number;
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
/** 차량이 지나갈 수 없는 낮은 천장(보/터널 지붕 등). y = 천장 아랫면 높이 */
export interface CeilingRect {
  id: string;
  rect: Rect2;
  y: number;
}
export interface Terrain {
  surfaces: TerrainSurface[];
  levels: TerrainLevel[];
  /** 데크 아랫면 외의 추가 천장 */
  ceilings?: CeilingRect[];
}

/**
 * 완화 구간이 있는 경사로의 정규화 높이 f(u) ∈ [0,1] (u: 시작점부터의 수평 거리, L: 길이, e: 완화 길이).
 * 양 끝 e 구간은 포물선(경사 0 → 최대), 가운데는 일정 경사. 최대 경사 = (y1-y0)/(L-e).
 */
export function rampProfile(u: number, L: number, e = 0): number {
  const x = Math.min(L, Math.max(0, u));
  const ee = Math.min(Math.max(0, e), L / 2);
  if (ee <= 1e-6) return x / L;
  const k = 1 / (L - ee); // 가운데 구간의 df/du
  if (x < ee) return (k * x * x) / (2 * ee);
  if (x > L - ee) {
    const r = L - x;
    return 1 - (k * r * r) / (2 * ee);
  }
  return k * (x - ee / 2);
}
/** 경사로의 최대 경사(높이/수평) */
export const rampMaxGrade = (r: Pick<RampSurface, 'length' | 'y0' | 'y1' | 'ease'>): number => Math.abs(r.y1 - r.y0) / (r.length - Math.min(Math.max(0, r.ease ?? 0), r.length / 2));

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
    return s.y0 + (s.y1 - s.y0) * rampProfile(u, s.length, s.ease);
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
  for (const s of surfacesNear(t, x, z)) {
    const h = surfaceHeight(s, x, z);
    if (h === null) continue;
    if (Math.abs(h - yHint) <= maxStep && (best === null || h > best)) best = h;
  }
  return best;
}

// ---- 지형 면 공간 인덱스 (v0.5.4): 대형 맵에서 (x,z) 주변의 면만 검사한다 ----
const T_CELL = 16;
interface TIndex {
  n: number;
  cells: Map<number, TerrainSurface[]>;
  /** 격자에 넣기엔 너무 큰 면(전체 지면 등)은 항상 검사 */
  big: TerrainSurface[];
}
const tIndex = new WeakMap<Terrain, TIndex>();
const tKey = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768);
function surfaceAabb(s: TerrainSurface): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (s.kind === 'deck') {
    const r = s.rect;
    const c = Math.abs(Math.cos(r.rot ?? 0));
    const sn = Math.abs(Math.sin(r.rot ?? 0));
    const ex = (r.w / 2) * c + (r.d / 2) * sn;
    const ez = (r.w / 2) * sn + (r.d / 2) * c;
    return { minX: r.x - ex, maxX: r.x + ex, minZ: r.z - ez, maxZ: r.z + ez };
  }
  if (s.kind === 'ramp') {
    const fx = Math.sin(s.rot);
    const fz = Math.cos(s.rot);
    const ex = s.x + fx * s.length;
    const ez = s.z + fz * s.length;
    const hw = s.width / 2;
    return { minX: Math.min(s.x, ex) - hw, maxX: Math.max(s.x, ex) + hw, minZ: Math.min(s.z, ez) - hw, maxZ: Math.max(s.z, ez) + hw };
  }
  return { minX: s.cx - s.r1, maxX: s.cx + s.r1, minZ: s.cz - s.r1, maxZ: s.cz + s.r1 };
}
function buildTIndex(t: Terrain): TIndex {
  const idx: TIndex = { n: t.surfaces.length, cells: new Map(), big: [] };
  for (const s of t.surfaces) {
    const b = surfaceAabb(s);
    const x0 = Math.floor(b.minX / T_CELL);
    const x1 = Math.floor(b.maxX / T_CELL);
    const z0 = Math.floor(b.minZ / T_CELL);
    const z1 = Math.floor(b.maxZ / T_CELL);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 64) {
      idx.big.push(s);
      continue;
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = tKey(ix, iz);
        const a = idx.cells.get(k);
        if (a) a.push(s);
        else idx.cells.set(k, [s]);
      }
    }
  }
  return idx;
}
const NO_SURF: TerrainSurface[] = [];
/** (x,z) 를 덮을 수 있는 면 후보. 면이 적은 지형(≤12)은 인덱스 없이 전체를 돌려준다 */
export function surfacesNear(t: Terrain, x: number, z: number): readonly TerrainSurface[] {
  if (t.surfaces.length <= 12) return t.surfaces;
  let idx = tIndex.get(t);
  if (!idx || idx.n !== t.surfaces.length) {
    idx = buildTIndex(t);
    tIndex.set(t, idx);
  }
  const cell = idx.cells.get(tKey(Math.floor(x / T_CELL), Math.floor(z / T_CELL))) ?? NO_SURF;
  if (!idx.big.length) return cell;
  if (!cell.length) return idx.big;
  scratchSurf.length = 0;
  for (const s of idx.big) scratchSurf.push(s);
  for (const s of cell) scratchSurf.push(s);
  return scratchSurf;
}
const scratchSurf: TerrainSurface[] = [];

/** (x,z) 위쪽으로 가장 가까운 층 바닥 아랫면 높이 (천장). 없으면 Infinity. 카메라 높이 제한용 */
export function ceilingAbove(t: Terrain, x: number, z: number, y: number): number {
  let best = Infinity;
  for (const s of surfacesNear(t, x, z)) {
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

/**
 * (x,z) 에서 높이 y 위에 있는 가장 낮은 천장(데크 아랫면/추가 천장)까지의 여유. 없으면 Infinity.
 * 차량 높이 검사용: 반환값 < 차고 이면 그 지점을 지나갈 수 없다.
 */
export function headroomAt(t: Terrain, x: number, z: number, y: number): number {
  let best = Infinity;
  for (const s of surfacesNear(t, x, z)) {
    if (s.kind !== 'deck') continue;
    const h = surfaceHeight(s, x, z);
    if (h === null) continue;
    const bottom = h - (s.thickness ?? 0.3);
    if (bottom > y + 0.5 && bottom - y < best) best = bottom - y;
  }
  for (const c of t.ceilings ?? []) {
    if (!inRect(c.rect, x, z)) continue;
    if (c.y > y + 0.5 && c.y - y < best) best = c.y - y;
  }
  return best;
}

/**
 * 하부(배) 여유: 앞·뒤 차축 접지점을 잇는 직선과 그 사이 지면의 최소 간격에 지상고를 더한 값(m).
 * 0 이하면 볼록한 경사 전환부(마루)에서 차체 바닥이 닿는다. 지면이 없는 표본점은 건너뛴다.
 */
export function underbodyGap(t: Terrain, rx: number, rz: number, yR: number, fx: number, fz: number, yF: number, clearance: number, samples = 5): number {
  let gap = Infinity;
  for (let i = 1; i < samples; i++) {
    const k = i / samples;
    const x = rx + (fx - rx) * k;
    const z = rz + (fz - rz) * k;
    const line = yR + (yF - yR) * k;
    const g = groundAt(t, x, z, line, 0.9);
    if (g === null) continue;
    gap = Math.min(gap, line + clearance - g);
  }
  return gap;
}

/** 지형이 차지하는 높이 범위 (지하층 포함) */
export function terrainYRange(t: Terrain): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const l of t.levels) {
    min = Math.min(min, l.y);
    max = Math.max(max, l.y);
  }
  return { min, max };
}
