/**
 * v0.6.3 건물 외벽 유형(순수 로직, three.js/DOM 없음). OSM building 태그·높이·층수 → 외벽 아틀라스 칸.
 * 실제 건물 사진이 없으므로 "그 종류의 일반적인 외벽"이다 — 실제 외관을 재현했다고 표기하지 말 것.
 * 생성 건물(g:1)은 실제 건물과 구분되도록 별도 칸(gen*)을 쓴다(창문 반사 없음, 회청색).
 */
export const FACADE_CELLS = [
  'apartment', // 0 아파트: 발코니 띠 + 큰 창
  'villa', // 1 다세대/빌라: 벽돌 + 중간 창
  'house', // 2 단독주택: 미장 벽 + 작은 창
  'shop', // 3 상가 위층: 띠창
  'shopGround', // 4 상가 1층: 유리 진열창 + 출입문
  'office', // 5 사무/상업 고층: 커튼월 유리
  'factory', // 6 공장: 골강판 + 높은 띠창
  'warehouse', // 7 창고: 골강판 + 셔터
  'school', // 8 학교·공공: 콘크리트 + 규칙 창
  'parking', // 9 주차타워: 열린 층 띠
  'genBlock', // 10 생성(주거/상가): 무늬 약한 회청 패널
  'genIndustrial', // 11 생성(공장/창고): 회청 골판
] as const;
export type FacadeCell = (typeof FACADE_CELLS)[number];
/** 아틀라스 격자(4×3 = 12칸) */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 3;

export interface FacadeStyle {
  /** 한 칸(모듈)이 덮는 벽 폭(m) */
  module: number;
  /** 층고(m) — 텍스처 한 칸 높이 */
  floor: number;
  main: FacadeCell;
  /** 1층에 쓸 칸(상가 출입구 등). 없으면 main */
  ground: FacadeCell;
  /** 지붕: flat(평지붕) · hip(모임지붕 — 작은 주택) */
  roof: 'flat' | 'hip';
  /** 옥상 구조물(계단실/기계실) */
  rooftop: boolean;
}

const RES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'hut', 'cabin']);
const APT = new Set(['apartments', 'dormitory']);
const SHOP = new Set(['commercial', 'retail', 'kiosk', 'supermarket']);
const OFFICE = new Set(['office', 'hotel']);
const IND = new Set(['industrial', 'manufacture']);
const WARE = new Set(['warehouse', 'storage_tank', 'hangar', 'shed', 'roof']);
const PUBLIC = new Set(['school', 'university', 'college', 'kindergarten', 'public', 'civic', 'government', 'hospital', 'townhall', 'fire_station', 'train_station', 'transportation']);
const PARK = new Set(['parking', 'garage', 'garages', 'carport']);

/**
 * 건물 → 외벽 유형. k = OSM building 태그(생성 건물은 'gen'), gk = 생성 종류, h = 높이(m), lv = 층수(태그/생성), area = 바닥 면적(m²)
 */
export function facadeStyleOf(b: { k: string; g?: 1; gk?: string; h: number; lv?: number }, area: number): FacadeStyle {
  const floorOf = (def: number): number => (b.lv && b.lv > 0 ? Math.min(4.5, Math.max(2.6, (b.h - 0.8) / b.lv)) : def);
  if (b.g) {
    const ind = b.gk === 'factory' || b.gk === 'warehouse';
    if (ind) return { module: 6, floor: b.gk === 'warehouse' ? b.h : floorOf(4.5), main: 'genIndustrial', ground: 'genIndustrial', roof: 'flat', rooftop: false };
    return { module: 3.2, floor: floorOf(2.9), main: 'genBlock', ground: 'genBlock', roof: b.gk === 'house' && area < 140 ? 'hip' : 'flat', rooftop: false };
  }
  const k = b.k;
  const small = area < 160 && b.h <= 9;
  if (RES.has(k) || (k === 'yes' && small) || (k === 'residential' && small)) return { module: 3.6, floor: floorOf(2.9), main: 'house', ground: 'house', roof: area < 220 ? 'hip' : 'flat', rooftop: false };
  if (APT.has(k) || ((k === 'residential' || k === 'yes') && b.h >= 30)) return { module: 3.0, floor: floorOf(2.8), main: 'apartment', ground: 'apartment', roof: 'flat', rooftop: true };
  if (k === 'residential' || k === 'yes') return { module: 3.2, floor: floorOf(2.9), main: 'villa', ground: b.h > 9 && area > 120 ? 'shopGround' : 'villa', roof: 'flat', rooftop: b.h > 12 };
  if (OFFICE.has(k) || (SHOP.has(k) && b.h >= 25)) return { module: 3.0, floor: floorOf(3.6), main: 'office', ground: 'shopGround', roof: 'flat', rooftop: true };
  if (SHOP.has(k)) return { module: 3.4, floor: floorOf(3.4), main: 'shop', ground: 'shopGround', roof: 'flat', rooftop: b.h > 12 };
  if (IND.has(k)) return { module: 6, floor: floorOf(4.5), main: 'factory', ground: 'factory', roof: 'flat', rooftop: false };
  if (WARE.has(k)) return { module: 6, floor: Math.max(3, b.h), main: 'warehouse', ground: 'warehouse', roof: 'flat', rooftop: false };
  if (PUBLIC.has(k)) return { module: 3.2, floor: floorOf(3.6), main: 'school', ground: 'school', roof: 'flat', rooftop: b.h > 10 };
  if (PARK.has(k)) return { module: 5, floor: floorOf(2.9), main: 'parking', ground: 'parking', roof: 'flat', rooftop: false };
  return { module: 3.2, floor: floorOf(3.0), main: 'villa', ground: 'villa', roof: 'flat', rooftop: b.h > 12 };
}

/** 칸 → 아틀라스 좌하단 오프셋(0~1) */
export function cellOffset(c: FacadeCell): [number, number] {
  const i = FACADE_CELLS.indexOf(c);
  const col = i % ATLAS_COLS;
  const row = Math.floor(i / ATLAS_COLS);
  return [col / ATLAS_COLS, 1 - (row + 1) / ATLAS_ROWS];
}

/**
 * 모임지붕(hip) 정점: 직사각형에 가까운 4각 외곽만(그 외는 평지붕). 용마루는 긴 변 방향, 높이 = 짧은 변 × 0.3(최대 2.2m).
 * 반환: 삼각형 목록 [x,y,z]×3 (바깥을 보는 감기), 없으면 null.
 */
export function hipRoof(o: [number, number][], y: number): [number, number, number][][] | null {
  if (o.length !== 4) return null;
  const e = (i: number): number => Math.hypot(o[(i + 1) % 4][0] - o[i][0], o[(i + 1) % 4][1] - o[i][1]);
  const L0 = (e(0) + e(2)) / 2;
  const L1 = (e(1) + e(3)) / 2;
  if (Math.min(L0, L1) < 3) return null;
  const cx = o.reduce((a, p) => a + p[0], 0) / 4;
  const cz = o.reduce((a, p) => a + p[1], 0) / 4;
  // 긴 변 방향(변 0 또는 변 1)
  const along = L0 >= L1 ? 0 : 1;
  const ax = o[along + 1][0] - o[along][0];
  const az = o[along + 1][1] - o[along][1];
  const al = Math.hypot(ax, az);
  const short = Math.min(L0, L1);
  const half = Math.max(0, Math.max(L0, L1) / 2 - short / 2);
  const rh = Math.min(2.2, short * 0.3);
  const r0: [number, number, number] = [cx - (ax / al) * half, y + rh, cz - (az / al) * half];
  const r1: [number, number, number] = [cx + (ax / al) * half, y + rh, cz + (az / al) * half];
  const P = o.map(([x, z]) => [x, y, z] as [number, number, number]);
  // 각 변의 처마 두 점 + 가까운 용마루 점(들)
  const near = (p: [number, number, number]): [number, number, number] => (Math.hypot(p[0] - r0[0], p[2] - r0[2]) <= Math.hypot(p[0] - r1[0], p[2] - r1[2]) ? r0 : r1);
  const tris: [number, number, number][][] = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i];
    const b = P[(i + 1) % 4];
    const na = near(a);
    const nb = near(b);
    if (na === nb) tris.push([a, b, na]);
    else {
      tris.push([a, b, nb]);
      tris.push([a, nb, na]);
    }
  }
  return tris;
}
