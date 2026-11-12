import { composeMap, type ZonePlacement } from './compose';
import { MAP_CARPARK3 } from './mapCarpark3';
import { MAP_GARAGE5 } from './mapGarage5';
import { MAP_LOT } from './mapLot';
import { MAP_MECHPARK } from './mapMechPark';
import { MAP_MODLOT } from './mapModLot';
import { MAP_OUTDOOR } from './mapOutdoor';
import { MAP_SPIRAL } from './mapSpiral';
import { MAP_TOWER } from './mapTower';
import { MAP_UNDERGROUND } from './mapUnderground';
import { rampProfile } from './terrain';
import type { MapData, ObstacleDef, PaintRect, RoadSeg, SurfaceRect } from './types';

/**
 * 통합 주차 시뮬레이션 맵 `megapark` (v0.5.2 → v0.5.4 개편): 기존 9개 맵의 구조/미션을 **하나의 장면**에 배치하고 도로망으로 연결한다.
 *  - 구역은 순수 평행이동(+ 지하 구역은 수직 이동)만 적용. 좌표 변환이 바닥/지형/충돌체/도색/주차칸/미션 스폰에 동일하다.
 *  - 도로망(v0.5.4): 서쪽/동쪽 간선도로(남북) + 구역 사이 연결도로(동서) 10개 → 격자형 순환 도로. 모든 도로는 양방향 2차로(중앙선/가장자리선).
 *  - **지하주차장은 실제 지하층(B1, y=-3.2m)**: 동쪽 간선도로에서 진입로 → 완화 구간이 있는 경사로(길이 32m, 최대 경사 12.3%) → B1.
 *    지상 데크와 지면 메시에 같은 트렌치 구멍을 내고, 양옆은 옹벽(실제 충돌체)이다. B1 위 지상은 그대로 지면(지붕 슬래브)이다.
 *  - ※ 도로/경사로 배치는 임시(개발 단계 고정 데이터). 각 구역 내부 치수는 원본 맵 그대로.
 */
const WEST = -36; // 모든 구역의 서쪽 가장자리 x
const AVE_X = -58; // 서쪽 간선도로 중심
const AVE_E = 80; // 동쪽 간선도로 중심 (v0.5.4)
const AVE_W = 10;
const ST_W = 7;
const Z_MIN = -207;
const Z_MAX = 280;
export const B1_Y = -3.2;

const place = (map: MapData, label: string, ns: string, z0: number, fromTop = false, extra: Partial<ZonePlacement> = {}): ZonePlacement => {
  const dz = fromTop ? z0 - map.bounds.maxZ : z0 - map.bounds.minZ;
  return { map, ns, label, dx: WEST - map.bounds.minX, dz, ...extra };
};

const zones: ZonePlacement[] = [
  { map: MAP_MECHPARK, ns: '', label: '12층 기계식 주차타워', dx: 0, dz: 0 },
  // 북쪽(+z) 구역: 아래에서 위로 쌓는다
  place(MAP_LOT, '일반 주차장', 'lot', 28),
  // 지하주차장: 실제 지하 B1. 동쪽 벽의 개구부(로컬 z=0 ± 3.5m)로 경사로가 들어온다
  place(MAP_UNDERGROUND, '지하주차장', 'ug', 98, false, { dy: B1_Y, portal: { z: 0, width: 7 }, levelName: 'B1' }),
  place(MAP_OUTDOOR, '야외 주차장', 'out', 130, false, { entranceZ: 2 }),
  place(MAP_MODLOT, '정밀 연습장', 'ml', 224),
  // 남쪽(-z) 구역: 위에서 아래로 쌓는다 (z0 = 구역의 북쪽 끝)
  place(MAP_TOWER, '다층 주차타워', 'tw', -28, true),
  place(MAP_GARAGE5, '5층 주차타워', 'g5', -66, true),
  place(MAP_CARPARK3, '3층 순환 주차장', 'c3', -106, true),
  place(MAP_SPIRAL, '나선형 램프', 'sp', -152, true),
];

// ---- 도로망 ----
const roads: RoadSeg[] = [
  { id: 'ave-w', name: '서쪽 간선도로', kind: 'avenue', ax: AVE_X, az: Z_MIN, bx: AVE_X, bz: Z_MAX, width: AVE_W, lanes: 2 },
  { id: 'ave-e', name: '동쪽 간선도로', kind: 'avenue', ax: AVE_E, az: Z_MIN, bx: AVE_E, bz: Z_MAX, width: AVE_W, lanes: 2 },
];
/** 구역 사이(및 남북 끝)의 동서 연결도로 z */
export const CROSS_Z = [Z_MIN, -145, -99, -59, -21, 21, 91, 122.6, 217, Z_MAX];
CROSS_Z.forEach((z, i) => roads.push({ id: `st-${i}`, name: `연결도로 ${i + 1}`, kind: 'street', ax: AVE_X, az: z, bx: AVE_E, bz: z, width: ST_W, lanes: 2 }));
// 구역 진입로(서쪽 간선도로 → 구역 서쪽 입구)
for (const z of zones) {
  if (z.dy) continue;
  const ez = (z.entranceZ ?? z.map.spawn.z) + z.dz;
  roads.push({ id: `in-${z.map.id}`, name: `${z.label} 진입로`, kind: 'access', ax: AVE_X, az: ez, bx: WEST + 1, bz: ez, width: 6.5, lanes: 2 });
}
// 지하주차장: 동쪽 간선도로 → 진입로 → 경사로(지상 0 → B1)
const UG = zones.find((z) => z.map.id === 'underground')!;
const UG_Z = UG.dz; // 구역 로컬 z=0 의 월드 z
const UG_EAST = UG.map.bounds.maxX + UG.dx; // B1 동쪽 벽 안쪽 면 x
export const UG_RAMP = { topX: UG_EAST + 32, bottomX: UG_EAST, z: UG_Z, width: 7, length: 32, ease: 6 };
roads.push({ id: 'in-underground', name: '지하주차장 진입로', kind: 'access', ax: AVE_E, az: UG_Z, bx: UG_RAMP.topX, bz: UG_Z, width: 7, lanes: 2 });
roads.push({ id: 'ramp-underground', name: '지하주차장 경사로', kind: 'ramp', ax: UG_RAMP.topX, az: UG_Z, bx: UG_RAMP.bottomX, bz: UG_Z, width: UG_RAMP.width, lanes: 2, y0: 0, y1: B1_Y });

const surfaces: SurfaceRect[] = [];
const paint: PaintRect[] = [];
const YEL = 0xf2c200;
const WHT = 0xf4f4f4;
for (const r of roads) {
  if (r.kind === 'ramp') continue; // 경사로 면은 지형(ramp)이 그린다
  const horiz = Math.abs(r.bz - r.az) < 1e-6;
  const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
  const cx = (r.ax + r.bx) / 2;
  const cz = (r.az + r.bz) / 2;
  const ext = r.kind === 'avenue' ? ST_W : 0; // 간선도로는 끝 교차로까지 덮는다
  surfaces.push(horiz ? { x: cx, z: cz, w: len, d: r.width, kind: 'asphalt' } : { x: cx, z: cz, w: r.width, d: len + ext, kind: 'asphalt' });
  // 중앙선(노란 점선 3m/3m) + 가장자리선(흰 실선)
  const n = Math.floor(len / 6);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = r.ax + (r.bx - r.ax) * t;
    const pz = r.az + (r.bz - r.az) * t;
    paint.push(horiz ? { x: px, z: pz, w: 3, d: 0.14, color: YEL } : { x: px, z: pz, w: 0.14, d: 3, color: YEL });
  }
  if (r.kind !== 'access') {
    for (const sgn of [1, -1]) {
      const o = sgn * (r.width / 2 - 0.25);
      paint.push(horiz ? { x: cx, z: cz + o, w: len, d: 0.12, color: WHT } : { x: cx + o, z: cz, w: 0.12, d: len, color: WHT });
    }
  }
}
// 보행로: 간선도로 바깥쪽
surfaces.push({ x: AVE_X - AVE_W / 2 - 1.2, z: (Z_MIN + Z_MAX) / 2, w: 2.4, d: Z_MAX - Z_MIN + ST_W, kind: 'sidewalk' });
surfaces.push({ x: AVE_E + AVE_W / 2 + 1.2, z: (Z_MIN + Z_MAX) / 2, w: 2.4, d: Z_MAX - Z_MIN + ST_W, kind: 'sidewalk' });
// 기계식 주차장 대기 공간(진입로 옆 정차대): 서쪽 간선도로와 기계식 구역 사이
surfaces.push({ x: -44.5, z: 6.5, w: 14, d: 5, kind: 'asphalt' });
paint.push({ x: -44.5, z: 6.5, w: 12, d: 0.12, color: WHT }, { x: -44.5, z: 8.9, w: 12, d: 0.12, color: WHT });

// ---- 지하 경사로: 옹벽(트렌치 양옆) + 입구 보 + 표지 ----
const extraObstacles: ObstacleDef[] = [];
{
  const R = UG_RAMP;
  const n = 16;
  const seg = R.length / n;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * seg; // 꼭대기에서부터의 수평 거리
    const yMid = B1_Y * rampProfile(u, R.length, R.ease);
    const y0 = Math.min(0, B1_Y * rampProfile(u + seg / 2, R.length, R.ease)) - 0.3;
    for (const sgn of [1, -1]) {
      extraObstacles.push({ id: `ugr-wall-${sgn > 0 ? 'n' : 's'}${i}`, tag: 'wall', shape: 'box', x: R.topX - u, z: R.z + sgn * (R.width / 2 + 0.2), w: seg + 0.02, d: 0.4, h: 1.0 - y0, y0, color: 0x8a8d90 });
    }
    void yMid;
  }
  // 경사로 꼭대기 양옆 볼라드(진입 폭 표시) + 지하 입구 안내 표지 기둥
  for (const sgn of [1, -1]) extraObstacles.push({ id: `ugr-bol-${sgn > 0 ? 'n' : 's'}`, tag: 'bollard', shape: 'cyl', x: R.topX + 1.2, z: R.z + sgn * (R.width / 2 + 0.2), r: 0.1, h: 0.95 });
}

export const MEGA_ZONES = zones;
export const MEGA_ROADS = roads;

export const MAP_MEGAPARK: MapData = composeMap({
  id: 'megapark',
  name: '통합 주차 시뮬레이션 맵 (9개 구역)',
  desc: '기존 9개 맵(일반·지하 B1·야외·다층타워·5층타워·3층 순환·정밀 연습장·나선형 램프·12층 기계식 타워)을 격자형 도로망으로 연결한 대형 맵. 지하주차장은 동쪽 간선도로의 진입 경사로로 실제 지하 B1 까지 내려갑니다. ※ 도로/경사로는 임시 배치(각 구역 치수는 원본 그대로).',
  zones,
  surfaces,
  paint,
  extraObstacles,
  roads,
  spawn: { x: AVE_X, z: 0, heading: Math.PI / 2, y: 0 },
  bounds: { minX: -75, maxX: 95, minZ: -215, maxZ: 290 },
  groundRect: { x: 10, z: 37.5, w: 170, d: 505 },
  groundHoles: [{ x: (UG_RAMP.topX + UG_RAMP.bottomX) / 2, z: UG_RAMP.z, w: UG_RAMP.length, d: UG_RAMP.width }],
  extraTerrain: [{ kind: 'ramp', id: 'ug-ramp', x: UG_RAMP.topX, z: UG_RAMP.z, rot: -Math.PI / 2, length: UG_RAMP.length, width: UG_RAMP.width, y0: 0, y1: B1_Y, ease: UG_RAMP.ease }],
});
