/**
 * v0.6.2 부산 사하구 전체 지도 — 데이터 형식과 로더(순수 로직, three.js 없음).
 * 전처리: scripts/saha/build.ts → public/maps/saha/{manifest.json, field.bin, roadnet.json, tiles/<ix>_<iz>.json}
 * 출처: 도로/건물/주차장/경계/토지피복 = © OpenStreetMap contributors (ODbL 1.0), 지형 = Copernicus DEM GLO-30(가공한 추정 지표면).
 * 값마다 실제/추정 플래그가 있다: 차로 ls(1 = OSM 태그, 0 = 추정), 폭 ws, 건물 높이 hs, 교량/터널 종단은 추정.
 */
import type { HeightField, RampSurface } from '../terrain';
import type { BoxCollider } from '../../core/geometry';
import { footprintBoxes, type Pt } from '../../world/footprint';

export interface SahaDeck {
  id: string;
  x: number;
  z: number;
  rot: number;
  length: number;
  width: number;
  y0: number;
  y1: number;
  tunnel: 0 | 1;
}
export interface SahaManifest {
  version: number;
  name: string;
  origin: { lat: number; lon: number; epsg: number; E0: number; N0: number };
  seaLevelY: number;
  facility: { x: number; z: number };
  tileSize: number;
  tiles: string[];
  field: { x0: number; z0: number; w: number; h: number; cell: number; scale: number; file: string; cover: string[] };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  boundary: { name: string; outer: [number, number][][]; inner: [number, number][][] }[];
  decks: SahaDeck[];
  sources: { layer: string; name: string; license: string; attribution: string; snapshot?: string | null }[];
  quality: Record<string, unknown>;
}
/** 도로 조각(타일 안) — 키가 짧은 것은 파일 크기 때문 */
export interface SahaRoad {
  id: string;
  /** 도로명 */
  n?: string;
  ref?: string;
  /** 등급 색인: motorway trunk primary secondary tertiary unclassified residential living_street service */
  c: number;
  lk: 0 | 1;
  /** 일방통행(점 순서 방향) */
  o: 0 | 1;
  /** [전체 차로, 정방향, 역방향] */
  l: [number, number, number];
  /** 차로 수 출처: 1 = OSM 태그(실제), 0 = 등급으로 추정 */
  ls: 0 | 1;
  w: number;
  ws: 'osm' | 'lanes' | 'est';
  t?: string;
  tf?: string;
  tb?: string;
  bus?: string;
  sp: number | null;
  sf: string;
  br: 0 | 1;
  tn: 0 | 1;
  ly: number;
  /** [x, z, y] — y = 노면 높이 */
  p: [number, number, number][];
}
export interface SahaBuilding {
  id: string;
  n?: string;
  k: string;
  o: [number, number][];
  hl?: [number, number][][];
  h: number;
  lv?: number;
  /** 높이 출처 */
  hs: 'osm-height' | 'osm-levels' | 'est';
  /** 바닥 높이(외곽 꼭짓점 지면 최저) */
  y: number;
}
export interface SahaLot {
  id: string;
  n?: string;
  p: [number, number][];
  y: number;
}
/** 도로 표시(실제 OSM 노드 위치): cw 횡단보도, sig 신호 교차(정지선) */
export interface SahaMark {
  k: 'cw' | 'sig';
  x: number;
  z: number;
  /** 그 점의 도로 진행 방향(heading 규칙) */
  h: number;
  w: number;
  o: 0 | 1;
  /** [정방향, 역방향] 차로 */
  l: [number, number];
}
export interface SahaTile {
  roads: SahaRoad[];
  buildings: SahaBuilding[];
  lots: SahaLot[];
  marks?: SahaMark[];
}
export interface SahaRoadNet {
  nodes: [number, number, number][];
  edges: [number, number, 0 | 1][];
  cls: number[];
  lanes: number[];
  speed: number[];
  restrictions: [number, number, number, 0 | 1][];
}
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'] as const;

export interface SahaBase {
  manifest: SahaManifest;
  field: HeightField;
  /** 토지피복(격자, field 와 같은 크기): 0 시가지 1 풀 2 숲 3 물 4 모래 */
  cover: Uint8Array;
  roadNet: SahaRoadNet;
}

/** 파일 가져오기(브라우저 fetch / 테스트 fs) */
export interface SahaSource {
  json<T>(rel: string): Promise<T>;
  bin(rel: string): Promise<ArrayBuffer>;
}

export function decodeField(m: SahaManifest, buf: ArrayBuffer): { field: HeightField; cover: Uint8Array } {
  const n = m.field.w * m.field.h;
  const dv = new DataView(buf);
  const data = new Float32Array(n);
  for (let k = 0; k < n; k++) data[k] = dv.getInt16(k * 2, true) * m.field.scale;
  const cover = new Uint8Array(buf.slice(n * 2, n * 3));
  return { field: { x0: m.field.x0, z0: m.field.z0, w: m.field.w, h: m.field.h, cell: m.field.cell, data }, cover };
}

export async function loadSahaBase(src: SahaSource): Promise<SahaBase> {
  const manifest = await src.json<SahaManifest>('manifest.json');
  const [buf, roadNet] = await Promise.all([src.bin(manifest.field.file), src.json<SahaRoadNet>('roadnet.json')]);
  const { field, cover } = decodeField(manifest, buf);
  return { manifest, field, cover, roadNet };
}

/** 교량/터널 상판 → 지형 경사 면(ramp). 상판은 추정 종단(양 끝 지면 높이를 직선으로 잇고 교량은 가운데를 올림) */
export function deckSurfaces(m: SahaManifest): RampSurface[] {
  return m.decks.map((d) => ({ kind: 'ramp', id: `deck-${d.id}`, x: d.x, z: d.z, rot: d.rot, length: d.length, width: d.width, y0: d.y0, y1: d.y1 }));
}

export const tileKeyOf = (m: Pick<SahaManifest, 'tileSize'>, x: number, z: number): string => `${Math.floor(x / m.tileSize)}_${Math.floor(z / m.tileSize)}`;
/** (x,z) 반경 r 안에 걸치는 타일 키 */
export function tilesWithin(m: Pick<SahaManifest, 'tileSize'>, x: number, z: number, r: number): string[] {
  const s = m.tileSize;
  const out: string[] = [];
  for (let ix = Math.floor((x - r) / s); ix <= Math.floor((x + r) / s); ix++)
    for (let iz = Math.floor((z - r) / s); iz <= Math.floor((z + r) / s); iz++) {
      const cx = Math.max(ix * s, Math.min(x, (ix + 1) * s));
      const cz = Math.max(iz * s, Math.min(z, (iz + 1) * s));
      if (Math.hypot(cx - x, cz - z) <= r) out.push(`${ix}_${iz}`);
    }
  return out;
}

/** 점이 사하구 경계(법정동 합집합) 안인가 */
export function inSaha(m: SahaManifest, x: number, z: number): boolean {
  const inR = (pts: [number, number][]): boolean => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, zi] = pts[i];
      const [xj, zj] = pts[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  return m.boundary.some((d) => d.outer.some(inR) && !d.inner.some(inR));
}

/**
 * 건물 기초 깊이(m): 바닥 높이(b.y)는 외곽 꼭짓점 지면의 최저값이라, 경사지에서는 외곽 안/옆 지면이 그보다 낮을 수 있다.
 * 충돌체를 그만큼 아래로 내려 낮은 쪽에서 다가오는 차가 건물 밑으로 지나가지 못하게 한다(실제 회귀: e2e-v062 건물 충돌).
 */
export const BUILDING_FOUNDATION = 6;
/** 건물 외곽 → 회전 상자 충돌체(1m 격자 분해). 스트리밍·검사가 같은 함수를 쓴다 */
export function buildingColliders(b: SahaBuilding): BoxCollider[] {
  return footprintBoxes(b.o as Pt[], 1).map((q, k) => ({ kind: 'box', id: `sb-${b.id}-${k}`, tag: 'building', x: q.x, z: q.z, w: q.w, d: q.d, rot: q.rot, y0: b.y - BUILDING_FOUNDATION, h: b.h + BUILDING_FOUNDATION }));
}
