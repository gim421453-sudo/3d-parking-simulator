import { MECH_LIMITS } from '../mech/limits';
import type { MissionDef } from '../mission/parking';
import { STATION } from '../mech/machine';
import { parkedCar, perimeter, wallBox, WHITE, YELLOW } from './helpers';
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
export const GUIDE_H = 0.12;
const doorHalf = MECH_LIMITS.doorWidth / 2;
export const ROOM_HW = 3.3; // 승강장 안쪽 반폭
export const BOLLARD_R = 0.1;
export const BOLLARD_H = 0.95;
export const BOLLARDS = [
  { id: 'bol-1n', x: -9.0, z: 1.9 },
  { id: 'bol-1s', x: -9.0, z: -1.9 },
  { id: 'bol-2n', x: -11.0, z: 2.5 },
  { id: 'bol-2s', x: -11.0, z: -2.5 },
];

export const PALLET_SLOT: MapSlot = { id: 'pallet', x: px, z: 0, w: MECH_LIMITS.palletWidth, l: MECH_LIMITS.palletLength, dir: Math.PI / 2, style: 'box' };
export const EXIT_SLOT: MapSlot = { id: 'exit-zone', x: -25, z: 0, w: 3.2, l: 6.2, dir: -Math.PI / 2, style: 'box' };

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.4, 0x8f8f8a),
  // 승강장 측벽(안쪽 ±1.5) + 문틀 기둥(개구부 2.4m) + 안쪽 벽
  // 승강장은 턴테이블(길이 5.6m 팔레트가 180° 회전)이 돌 수 있도록 안쪽 폭 6.6m (±3.3)
  wallBox('ms-wall-n', -2.9, ROOM_HW + GT / 2, 8.2, GT, 2.4, 'wall', 0xb9bcc0),
  wallBox('ms-wall-s', -2.9, -(ROOM_HW + GT / 2), 8.2, GT, 2.4, 'wall', 0xb9bcc0),
  // 출입문 정면 벽: 개구부 2.4m (±1.2) 양옆
  wallBox('ms-front-n', STATION.doorX, (doorHalf + ROOM_HW + GT) / 2, 0.4, ROOM_HW + GT - doorHalf, 2.4, 'wall', 0x6d7176),
  wallBox('ms-front-s', STATION.doorX, -(doorHalf + ROOM_HW + GT) / 2, 0.4, ROOM_HW + GT - doorHalf, 2.4, 'wall', 0x6d7176),
  wallBox('ms-back', 1.65, 0, 0.9, 2 * (ROOM_HW + GT), 2.4, 'wall', 0xb9bcc0),
  // 기계실(저장 베이 하부) — 지상에서는 막혀 있다
  { id: 'ms-room-n', tag: 'building', shape: 'box', x: -2.9, z: ROOM_HW + GT + 1.8, w: 8.2, d: 3.6, h: 2.6, color: 0xc9ccd0 },
  { id: 'ms-room-s', tag: 'building', shape: 'box', x: -2.9, z: -(ROOM_HW + GT + 1.8), w: 8.2, d: 3.6, h: 2.6, color: 0xc9ccd0 },
  // 팔레트 사이드 가이드: 낮은 레일(h 0.12 < 지상고 0.2m) — 차체는 위로 지나가고 타이어가 타고 넘으면 mech.guideDrag 가 저항/경고. 센서 높이(0.55m) 아래라 PDC 미감지가 정상
  { id: 'pal-guide-n', tag: 'guide', shape: 'box', x: px, z: guideIn + GT / 2, w: MECH_LIMITS.palletLength, d: GT, h: GUIDE_H, color: YELLOW },
  { id: 'pal-guide-s', tag: 'guide', shape: 'box', x: px, z: -(guideIn + GT / 2), w: MECH_LIMITS.palletLength, d: GT, h: GUIDE_H, color: YELLOW },
  // 대기 공간
  parkedCar('wait-car-a', -22, 9.5, Math.PI / 2, 0),
  parkedCar('wait-car-b', -22, -9.5, Math.PI / 2, 2),
  wallBox('wait-planter-n', -29, 12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
  wallBox('wait-planter-s', -29, -12.2, 14, 0.8, 0.8, 'planter', 0x6b7a5a),
  // 입구 금속 볼라드(강철 원통 기둥, 실제 충돌체 + PDC 감지): 진입로 좌우
  ...BOLLARDS.map((b) => ({ id: b.id, tag: 'bollard' as const, shape: 'cyl' as const, x: b.x, z: b.z, r: BOLLARD_R, h: BOLLARD_H })),
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
  provisional: true,
  surfaces: [
    { x: -14.5, z: 0, w: 43, d: 28, kind: 'asphalt' },
    { x: 1, z: 0, w: 16, d: 28, kind: 'concrete' },
  ],
  paint: [
    { x: -9.0, z: 0, w: 0.3, d: 2.6, color: WHITE }, // 정지선
    { x: -18, z: 0, w: 24, d: 0.12, color: YELLOW }, // 진입 중앙선 (팔레트 중심선과 같은 z=0)
    { x: -11.6, z: 1.15, w: 8.8, d: 0.1, color: WHITE }, // 좌/우 차량 유도선 (차폭 + 여유)
    { x: -11.6, z: -1.15, w: 8.8, d: 0.1, color: WHITE },
    { x: -14.0, z: 0, w: 1.8, d: 0.22, color: WHITE }, // 전진 화살표 (축 + 머리)
    { x: -13.35, z: 0.28, w: 0.9, d: 0.2, rot: 0.75, color: WHITE },
    { x: -13.35, z: -0.28, w: 0.9, d: 0.2, rot: -0.75, color: WHITE },
    { x: -6.3, z: 0, w: 0.5, d: 2.4, color: YELLOW }, // 출입문 앞 노란 선
    { x: -25, z: 2.55, w: 6.2, d: 0.1, color: WHITE },
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
