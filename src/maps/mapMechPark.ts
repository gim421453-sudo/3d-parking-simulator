import type { MissionDef } from '../mission/parking';
import { STATION } from '../mech/machine';
import { makeFacility } from '../mech/facility';
import { BOLLARDS, BOLLARD_H, BOLLARD_R, BOLLARD_Z, EXIT_SLOT, GUIDE_H, LANE_W, LANE_Z, PALLET_SLOT, ROOM_HW, facilityKit } from './mechKit';
import { parkedCar, perimeter, wallBox, WHITE } from './helpers';
import type { MapData, ObstacleDef } from './types';

/**
 * 승강기식(팔레트형) 기계식 주차장 (v0.5.0). 한국 일반 기계식 주차장의 구성 요소를 간략 재현한 가상 장치:
 * 대기 공간 → 출입문(2.4m×1.9m) → 승강장(팔레트 + 바퀴 홈 + 사이드 가이드 + 정지턱 + 전방 확인 거울) → 승강/이송 → 저장 베이 4칸(2·3층 높이).
 * 장치 동작/판정은 src/mech/machine.ts (순수 로직), 3D 외형은 src/mech/mechBuilder.ts. 법규 인증 사양이 아니다(limits.ts 참고).
 */
const bounds = { minX: -36, maxX: 9, minZ: -14, maxZ: 14 };
const px = STATION.palletX;
// 시설 데이터(벽/기계실/가이드/볼라드/도색)는 mechKit 이 만든다. 이 맵은 시설을 원점에 항등 변환으로 설치한다.
export { BOLLARDS, BOLLARD_R, BOLLARD_H, BOLLARD_Z, EXIT_SLOT, GUIDE_H, LANE_W, LANE_Z, PALLET_SLOT, ROOM_HW };
export const MECHPARK_FACILITY = makeFacility({ id: 'mech-tower', name: '12층 기계식 주차타워', x: 0, z: 0, rotationY: 0, floors: 12 });
const kit = facilityKit(MECHPARK_FACILITY);
void px;

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.4, 0x8f8f8a),
  ...kit.obstacles,
  // 대기 공간
  parkedCar('wait-car-a', -22, 9.5, Math.PI / 2, 0),
  parkedCar('wait-car-b', -22, -9.5, Math.PI / 2, 2),
  wallBox('wait-planter-n', -29, 12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
  wallBox('wait-planter-s', -29, -12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
];

const mk = (id: string, name: string, kind: 'mech-in' | 'mech-out', slotId: string, desc: string, par: number, spawn: NonNullable<MapData['spawn']>, mech: MissionDef['mech']) => ({
  id,
  name,
  kind,
  slotId,
  desc,
  parTimeSec: par,
  timeLimitSec: par * 4 + 120,
  spawn,
  mech,
});

export const MAP_MECHPARK: MapData = {
  id: 'mechpark',
  name: '기계식 주차타워 (12층 승강기식)',
  desc: '출입문(2.4m)으로 전진 또는 후진해 들어가 팔레트의 바퀴 홈에 맞춰 정차 → P·주차브레이크·하차 → 입고. 4개 기둥을 따라 2~12층 22개 슬롯으로 승강·이송해 보관하고 출고합니다. ※ 시뮬레이션용 가상 장치이며 법규 인증 사양이 아닙니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.6 },
  spawn: { x: -30, z: 0, heading: Math.PI / 2 },
  mech: true,
  mechFacilities: [MECHPARK_FACILITY],
  provisional: true,
  surfaces: [
    { x: -14.5, z: 0, w: 43, d: 28, kind: 'asphalt' },
    { x: 1, z: 0, w: 16, d: 28, kind: 'concrete' },
  ],
  paint: [
    ...kit.paint,
    { x: -25, z: 2.55, w: 6.2, d: 0.1, color: WHITE }, // 출구 구역
    { x: -25, z: -2.55, w: 6.2, d: 0.1, color: WHITE },
    { x: -28.1, z: 0, w: 0.1, d: 5.2, color: WHITE },
    { x: -21.9, z: 0, w: 0.1, d: 5.2, color: WHITE },
  ],
  obstacles,
  slots: [PALLET_SLOT, EXIT_SLOT],
  missions: [
    mk('mech-in-1', '기계식 전진 입고 (2F A)', 'mech-in', 'pallet', '출입문을 지나 팔레트 중앙에 정렬하고 앞바퀴를 정지 홈에 맞춘 뒤 P·주차브레이크·하차(G)·입고(J). 2F A 슬롯.', 150, { x: -30, z: 0, heading: Math.PI / 2 }, { slot: '02A', mode: 'fwd' }),
    mk('mech-in-2', '기계식 측면 접근 전진 입고 (5F B)', 'mech-in', 'pallet', '대기 공간 옆에서 출발해 출입문 중심선에 맞춰 진입하세요. 5F B 슬롯.', 180, { x: -26, z: 5.5, heading: Math.PI / 2 }, { slot: '05B', mode: 'fwd' }),
    mk('mech-in-rev', '기계식 후진 입고 (8F A)', 'mech-in', 'pallet', 'R 기어로 후진해 들어가 뒷바퀴를 정지 홈에 맞추세요(후방카메라/PDC). 8F A 슬롯.', 180, { x: -20, z: 0, heading: -Math.PI / 2 }, { slot: '08A', mode: 'rev' }),
    mk('mech-in-rev-side', '기계식 측면 접근 후진 입고 (10F B)', 'mech-in', 'pallet', '옆에서 접근해 정렬한 뒤 후진 입고하세요. 10F B 슬롯.', 220, { x: -24, z: -5.5, heading: -Math.PI / 2 }, { slot: '10B', mode: 'rev' }),
    mk('mech-in-12f', '기계식 12층 입고 (12F A)', 'mech-in', 'pallet', '최상층 12F A 슬롯까지 실제로 승강해 보관합니다.', 180, { x: -30, z: 0, heading: Math.PI / 2 }, { slot: '12A', mode: 'fwd' }),
    mk('mech-out-1', '기계식 출고 (8F A, 전진 입고 차량)', 'mech-out', 'exit-zone', '8F A 에 보관된 차량을 출고(K)하세요. 전진 입고 차량은 턴테이블로 180° 회전해 나옵니다. 탑승(G) 후 출구 구역에 정차.', 150, { x: -30, z: 0, heading: Math.PI / 2 }, { slot: '08A', seed: [{ slot: '08A', specId: 'sedan', mode: 'fwd' }] }),
    mk('mech-out-rev', '기계식 출고 (12F B, 후진 입고 차량)', 'mech-out', 'exit-zone', '12F B 에 후진 입고된 차량을 출고하세요. 회전 없이 문을 향해 나옵니다.', 150, { x: -30, z: 0, heading: Math.PI / 2 }, { slot: '12B', seed: [{ slot: '12B', specId: 'sedan', mode: 'rev' }] }),
  ],
};
