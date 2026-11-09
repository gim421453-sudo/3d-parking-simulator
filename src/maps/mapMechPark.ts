import { MECH_LIMITS } from '../mech/limits';
import { STATION } from '../mech/machine';
import { cone, parkedCar, perimeter, wallBox, WHITE, YELLOW } from './helpers';
import type { MapData, MapSlot, ObstacleDef } from './types';

/**
 * 승강기식(팔레트형) 기계식 주차장 (v0.5.0). 한국 일반 기계식 주차장의 구성 요소를 간략 재현한 가상 장치:
 * 대기 공간 → 출입문(2.4m×1.9m) → 승강장(팔레트 + 바퀴 홈 + 사이드 가이드 + 정지턱 + 전방 확인 거울) → 승강/이송 → 저장 베이 4칸(2·3층 높이).
 * 장치 동작/판정은 src/mech/machine.ts (순수 로직), 3D 외형은 src/mech/mechBuilder.ts. 법규 인증 사양이 아니다(limits.ts 참고).
 */
const bounds = { minX: -36, maxX: 9, minZ: -14, maxZ: 14 };
const px = STATION.palletX;
const guideIn = MECH_LIMITS.palletWidth / 2; // 가이드 안쪽 면 ±1.075
const GT = 0.3; // 가이드 두께(얇은 벽 금지 규칙)
const doorHalf = MECH_LIMITS.doorWidth / 2;

export const PALLET_SLOT: MapSlot = { id: 'pallet', x: px, z: 0, w: MECH_LIMITS.palletWidth, l: MECH_LIMITS.palletLength, dir: Math.PI / 2, style: 'box' };
export const EXIT_SLOT: MapSlot = { id: 'exit-zone', x: -25, z: 0, w: 3.2, l: 6.2, dir: -Math.PI / 2, style: 'box' };

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.4, 0x8f8f8a),
  // 승강장 측벽(안쪽 ±1.5) + 문틀 기둥(개구부 2.4m) + 안쪽 벽
  wallBox('ms-wall-n', -2.75, 1.65, 8.5, GT, 2.4, 'wall', 0xb9bcc0),
  wallBox('ms-wall-s', -2.75, -1.65, 8.5, GT, 2.4, 'wall', 0xb9bcc0),
  wallBox('ms-jamb-n', STATION.doorX, doorHalf + 0.15, 0.4, GT, 2.4, 'wall', 0x6d7176),
  wallBox('ms-jamb-s', STATION.doorX, -(doorHalf + 0.15), 0.4, GT, 2.4, 'wall', 0x6d7176),
  wallBox('ms-back', 1.65, 0, 0.9, 3.6, 2.4, 'wall', 0xb9bcc0),
  // 기계실(저장 베이 하부) — 지상에서는 막혀 있다
  { id: 'ms-room-n', tag: 'building', shape: 'box', x: -2.5, z: 3.75, w: 9.0, d: 3.6, h: 2.6, color: 0xc9ccd0 },
  { id: 'ms-room-s', tag: 'building', shape: 'box', x: -2.5, z: -3.75, w: 9.0, d: 3.6, h: 2.6, color: 0xc9ccd0 },
  // 팔레트 사이드 가이드 (낮은 레일 h 0.3 — 센서 높이 0.55 아래라 미감지가 정상, 타이어 침범은 차체 충돌로 판정)
  { id: 'pal-guide-n', tag: 'guide', shape: 'box', x: px, z: guideIn + GT / 2, w: MECH_LIMITS.palletLength, d: GT, h: 0.3, color: YELLOW },
  { id: 'pal-guide-s', tag: 'guide', shape: 'box', x: px, z: -(guideIn + GT / 2), w: MECH_LIMITS.palletLength, d: GT, h: 0.3, color: YELLOW },
  // 대기 공간
  parkedCar('wait-car-a', -22, 9.5, Math.PI / 2, 0),
  parkedCar('wait-car-b', -22, -9.5, Math.PI / 2, 2),
  wallBox('wait-planter-n', -29, 12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
  wallBox('wait-planter-s', -29, -12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
  cone('wait-cone-1', -11.5, 3.0),
  cone('wait-cone-2', -11.5, -3.0),
];

const mk = (id: string, name: string, kind: 'mech-in' | 'mech-out', slotId: string, desc: string, par: number, spawn: NonNullable<MapData['spawn']>) => ({
  id,
  name,
  kind,
  slotId,
  desc,
  parTimeSec: par,
  timeLimitSec: par * 4 + 120,
  spawn,
});

export const MAP_MECHPARK: MapData = {
  id: 'mechpark',
  name: '기계식 주차장 (승강기식 팔레트)',
  desc: '출입문(2.4m)으로 들어가 팔레트의 바퀴 홈에 맞춰 정차 → P·주차브레이크·하차 → 입고. 승강·이송으로 저장했다가 출고합니다. ※ 시뮬레이션용 가상 장치이며 법규 인증 사양이 아닙니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.6 },
  spawn: { x: -30, z: 0, heading: Math.PI / 2 },
  mech: true,
  provisional: true,
  surfaces: [
    { x: -14.5, z: 0, w: 43, d: 28, kind: 'asphalt' },
    { x: 1, z: 0, w: 16, d: 28, kind: 'concrete' },
  ],
  paint: [
    { x: -9.0, z: 0, w: 0.3, d: 2.6, color: WHITE }, // 정지선
    { x: -18, z: 0, w: 24, d: 0.12, color: YELLOW }, // 진입 중앙선
    { x: -25, z: 2.55, w: 6.2, d: 0.1, color: WHITE },
    { x: -25, z: -2.55, w: 6.2, d: 0.1, color: WHITE },
    { x: -28.1, z: 0, w: 0.1, d: 5.2, color: WHITE },
    { x: -21.9, z: 0, w: 0.1, d: 5.2, color: WHITE },
  ],
  obstacles,
  slots: [PALLET_SLOT, EXIT_SLOT],
  missions: [
    mk('mech-in-1', '기계식 입고 (정면 진입)', 'mech-in', 'pallet', '출입문을 지나 팔레트 중앙에 정렬하고 앞바퀴를 정지턱에 맞춘 뒤 P·주차브레이크·하차(G)·입고(J).', 150, { x: -30, z: 0, heading: Math.PI / 2 }),
    mk('mech-in-2', '기계식 입고 (옆에서 접근)', 'mech-in', 'pallet', '대기 공간 옆에서 출발해 출입문 중심선에 맞춰 진입하세요.', 180, { x: -26, z: 5.5, heading: Math.PI / 2 }),
    mk('mech-out-1', '기계식 출고', 'mech-out', 'exit-zone', '저장된 차량을 출고(K)한 뒤 탑승해 출구 구역에 정차하세요. 출고 중에는 이동하지 못합니다.', 120, { x: -3.4, z: 0, heading: Math.PI / 2 }),
  ],
};
