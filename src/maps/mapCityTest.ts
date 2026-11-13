import { buildCity } from '../world/cityKit';
import { perimeter } from './helpers';
import type { MapData } from './types';

/**
 * 도시형 검증 구역 (v0.5.4, **임시** — 실제 도시/도로를 재현한 것이 아니다). `world/cityKit.ts` 의 블록 모듈로 만든 3×2 격자:
 *   북쪽 줄: 기계식 주차타워 · 골목 블록 · 상업 건물      남쪽 줄: 상업 건물 · 평면 주차장 · 주거 건물
 * 도로는 모두 양방향 2차로(폭 8m). 외곽 도로 한 변이 약 210m 라 고속 주행(가속/제동/커브) 시험이 가능하다.
 */
const city = buildCity({
  ns: 'ct',
  blocks: [
    ['commercial', 'parking', 'residential'],
    ['mech', 'alley', 'commercial'],
  ],
});
const firstParking = city.slots.find((s) => !city.obstacles.some((o) => o.tag === 'car' && Math.hypot(o.x - s.x, o.z - s.z) < 1))!;
const south = city.roads.find((r) => r.id === 'ct-h0')!;

export const CITY_TEST = city;
export const MAP_CITYTEST: MapData = {
  id: 'citytest',
  name: '도시형 검증 구역 (임시)',
  desc: '도로·교차로·상업/주거 건물·평면 주차장·골목·기계식 주차타워 모듈로 만든 3×2 블록 시험 구역. 외곽 도로에서 고속 주행을, 주차장/기계식 타워에서 저속 주차를 이어서 시험합니다. ※ 가상의 구역이며 실제 도시를 재현한 것이 아닙니다.',
  bounds: city.bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.6 },
  spawn: { x: south.ax + 20, z: south.az - 2, heading: Math.PI / 2 },
  provisional: true,
  mech: true,
  mechFacilities: city.facilities,
  roads: city.roads,
  surfaces: city.surfaces,
  paint: city.paint,
  obstacles: [...perimeter(city.bounds, 0.6, 1.2, 0x8f8f8a), ...city.obstacles],
  slots: city.slots,
  missions: [
    { id: 'ct-park', name: '도로 주행 → 평면 주차장 주차', kind: 'perpendicular-front', slotId: firstParking.id, desc: '외곽 도로에서 출발해 주차장 입구로 들어가 빈 칸에 주차하세요.', parTimeSec: 120, timeLimitSec: 600 },
  ],
};
