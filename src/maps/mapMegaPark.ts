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
import type { MapData, PaintRect, SurfaceRect } from './types';

/**
 * 통합 주차 시뮬레이션 맵 `megapark` (v0.5.2): 기존 9개 맵의 구조/미션을 **하나의 장면**에 배치하고 도로로 연결한다.
 * 모든 구역은 순수 평행이동만 적용(좌표 변환이 바닥/지형/충돌체/도색/주차칸/미션 스폰에 동일), 서쪽 외벽을 열어 서쪽 간선도로(x=-58)와
 * 구역별 진입 도로로 연결한다. 기계식 타워는 장치 좌표가 절대값(`mech/machine.ts STATION`)이라 원점에 둔다.
 * 구역 입구는 각 맵의 시작 위치 높이(z)에 맞춘다.
 */
const WEST = -36; // 모든 구역의 서쪽 가장자리 x
const AVE_X = -58;

const place = (map: MapData, label: string, ns: string, z0: number, fromTop = false, extra: Partial<ZonePlacement> = {}): ZonePlacement => {
  const depth = map.bounds.maxZ - map.bounds.minZ;
  const dz = fromTop ? z0 - map.bounds.maxZ : z0 - map.bounds.minZ;
  void depth;
  return { map, ns, label, dx: WEST - map.bounds.minX, dz, ...extra };
};

const zones: ZonePlacement[] = [
  { map: MAP_MECHPARK, ns: '', label: '12층 기계식 주차타워', dx: 0, dz: 0 },
  // 북쪽(+z) 구역: 아래에서 위로 쌓는다
  place(MAP_LOT, '일반 주차장', 'lot', 28),
  // 지하주차장: 입구(통로 끝)는 동쪽 — 구역 북쪽 우회 도로로 진입. 야외: 서쪽 건물(bld-3)을 피해 로컬 z=2 에서 진입
  place(MAP_UNDERGROUND, '지하주차장', 'ug', 98, false, { side: 'east', entranceZ: 0 }),
  place(MAP_OUTDOOR, '야외 주차장', 'out', 130, false, { entranceZ: 2 }),
  place(MAP_MODLOT, '정밀 연습장', 'ml', 224),
  // 남쪽(-z) 구역: 위에서 아래로 쌓는다 (z0 = 구역의 북쪽 끝)
  place(MAP_TOWER, '다층 주차타워', 'tw', -28, true),
  place(MAP_GARAGE5, '5층 주차타워', 'g5', -66, true),
  place(MAP_CARPARK3, '3층 순환 주차장', 'c3', -106, true),
  place(MAP_SPIRAL, '나선형 램프', 'sp', -152, true),
];

const surfaces: SurfaceRect[] = [{ x: AVE_X, z: 37.5, w: 10, d: 505, kind: 'asphalt' }];
const paint: PaintRect[] = [{ x: AVE_X, z: 37.5, w: 0.15, d: 500, color: 0xf2c200 }];
for (const z of zones) {
  const ez = (z.entranceZ ?? z.map.spawn.z) + z.dz;
  if (z.side === 'east') {
    // 동쪽 입구: 구역 북쪽의 우회 도로(구역 사이 간격)로 돌아 동쪽에서 진입
    const top = z.map.bounds.maxZ + z.dz + 7;
    const ex = z.map.bounds.maxX + z.dx + 4;
    surfaces.push({ x: (AVE_X + ex) / 2, z: top, w: ex - AVE_X + 4, d: 6.5, kind: 'asphalt' }, { x: ex, z: (top + ez) / 2, w: 6.5, d: top - ez + 3, kind: 'asphalt' }, { x: ex - 3, z: ez, w: 10, d: 6.5, kind: 'asphalt' });
    paint.push({ x: (AVE_X + ex) / 2, z: top, w: ex - AVE_X, d: 0.12, color: 0xf2c200 });
    continue;
  }
  surfaces.push({ x: (AVE_X + 5 + WEST) / 2, z: ez, w: WEST - (AVE_X + 5) + 1, d: 6.5, kind: 'asphalt' });
  paint.push({ x: (AVE_X + WEST) / 2, z: ez, w: WEST - AVE_X - 6, d: 0.12, color: 0xf2c200 });
}

export const MEGA_ZONES = zones;

export const MAP_MEGAPARK: MapData = composeMap({
  id: 'megapark',
  name: '통합 주차 시뮬레이션 맵 (9개 구역)',
  desc: '기존 9개 맵(일반·지하·야외·다층타워·5층타워·3층 순환·정밀 연습장·나선형 램프·12층 기계식 타워)을 도로로 연결한 대형 맵. 서쪽 간선도로에서 각 구역 진입로로 이동하세요. ※ 임시 배치(치수는 각 원본 맵 그대로).',
  zones,
  surfaces,
  paint,
  spawn: { x: AVE_X, z: 0, heading: Math.PI / 2, y: 0 },
  bounds: { minX: -75, maxX: 70, minZ: -215, maxZ: 290 },
  groundRect: { x: -2.5, z: 37.5, w: 145, d: 505 },
  extraTerrain: [{ kind: 'deck', id: 'ug-ceiling', rect: { x: -12, z: 106.8, w: 48, d: 17.6 }, y: 3.0, thickness: 0.3 }],
});
