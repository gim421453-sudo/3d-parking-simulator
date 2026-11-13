import { LIFT_DEFAULT, makeLift } from '../service/lift';
import { parkedCar, perimeter, slotPaint, slotRow, wallBox, WHITE, YELLOW } from './helpers';
import type { MapData, MapSlot, ObstacleDef, PaintRect } from './types';

/**
 * 정비소 (v0.5.4, **임시 검증 맵** — 건물 치수/리프트 규격/배치는 사용자 확정 전의 값).
 *  - 건물(24×14m, 벽 높이 4.2m, 지붕 생략): 남쪽 벽에 출입문 2개(폭 4m). 베이 A = 2주식 리프트, 베이 B = 평지 점검 베이.
 *  - 2주식 리프트(`service/lift.ts`): 기둥 2개(실제 충돌체) 사이로 진입 → 정위치 → P·주차 브레이크·시동 OFF → 상승(PageUp) / 하강(PageDown).
 *  - 앞마당: 진입 통로 + 대기 주차 4칸. 실제 정비 장비의 인증 사양을 재현한 것이 아니다.
 */
const bounds = { minX: -24, maxX: 24, minZ: -22, maxZ: 16 };
const B = { x0: -12, x1: 12, z0: 0, z1: 14, h: 4.2, t: 0.4 };
const DOOR_W = 4;
const BAY_A_X = -5;
const BAY_B_X = 5;
export const GARAGE_LIFT = makeLift({ id: 'lift-a', name: '베이 A 2주식 리프트', x: BAY_A_X, z: 7, heading: 0 });

const obstacles: ObstacleDef[] = [...perimeter(bounds, 0.6, 1.2, 0x8f8f8a)];
const WALL = 0xb7bcc2;
// 건물 외벽: 북/동/서 + 남쪽(문 2개 개구부)
obstacles.push(wallBox('gar-wall-n', 0, B.z1 + B.t / 2, B.x1 - B.x0 + 2 * B.t, B.t, B.h, 'wall', WALL));
obstacles.push(wallBox('gar-wall-w', B.x0 - B.t / 2, (B.z0 + B.z1) / 2, B.t, B.z1 - B.z0, B.h, 'wall', WALL));
obstacles.push(wallBox('gar-wall-e', B.x1 + B.t / 2, (B.z0 + B.z1) / 2, B.t, B.z1 - B.z0, B.h, 'wall', WALL));
{
  // 남쪽 벽 조각: [x0, A-2], [A+2, B-2], [B+2, x1]
  const cuts: [number, number][] = [
    [B.x0 - B.t, BAY_A_X - DOOR_W / 2],
    [BAY_A_X + DOOR_W / 2, BAY_B_X - DOOR_W / 2],
    [BAY_B_X + DOOR_W / 2, B.x1 + B.t],
  ];
  cuts.forEach(([a, b], i) => obstacles.push(wallBox(`gar-wall-s${i}`, (a + b) / 2, B.z0 - B.t / 2, b - a, B.t, B.h, 'wall', WALL)));
}
// 베이 사이 칸막이(낮은 벽)와 정렬 가이드 볼라드(문 양옆)
obstacles.push(wallBox('gar-divider', 0, 8.5, 0.3, 9, 1.1, 'barrier', 0xe0d040));
for (const bx of [BAY_A_X, BAY_B_X]) for (const s of [-1, 1]) obstacles.push({ id: `gar-bol-${bx}-${s}`, tag: 'bollard', shape: 'cyl', x: bx + s * (DOOR_W / 2 + 0.25), z: B.z0 - 1.0, r: 0.1, h: 0.95 });
// 리프트 기둥 2개 (실제 충돌체)
for (const s of [-1, 1]) obstacles.push({ id: `lift-a-post${s > 0 ? 'R' : 'L'}`, tag: 'pillar', shape: 'box', x: GARAGE_LIFT.x + s * GARAGE_LIFT.postHalf, z: GARAGE_LIFT.z, w: LIFT_DEFAULT.postSize, d: LIFT_DEFAULT.postSize + 0.1, h: LIFT_DEFAULT.postHeight, color: 0x2f5fb8 });
// 공구함/작업대/타이어 랙 (북쪽 벽 앞)
obstacles.push({ id: 'gar-toolbox-a', tag: 'planter', shape: 'box', x: -9.5, z: 13.2, w: 2.2, d: 0.8, h: 1.1, color: 0xb02a2a });
obstacles.push({ id: 'gar-bench', tag: 'planter', shape: 'box', x: -5, z: 13.3, w: 3.2, d: 0.7, h: 0.9, color: 0x6f5a43 });
obstacles.push({ id: 'gar-toolbox-b', tag: 'planter', shape: 'box', x: 2.2, z: 13.2, w: 1.6, d: 0.8, h: 1.5, color: 0x2a6bd0 });
obstacles.push({ id: 'gar-rack', tag: 'planter', shape: 'box', x: 9.5, z: 13.2, w: 3.0, d: 0.8, h: 2.0, color: 0x3a3f45 });
obstacles.push({ id: 'gar-comp', tag: 'drum', shape: 'cyl', x: 10.8, z: 1.4, r: 0.45, h: 1.3 });
// 앞마당: 대기 주차 줄(남쪽) + 주차된 차량
const row = slotRow({ prefix: 'gar-p', startX: 6, z: -17, count: 4, pitch: 2.7, w: 2.7, l: 5.2, dir: Math.PI, empty: [1, 3] });
obstacles.push(...row.cars);
obstacles.push(parkedCar('gar-wait-car', -17, -6, 0, 2));

const bayLift: MapSlot = { id: 'bay-lift', x: GARAGE_LIFT.x, z: GARAGE_LIFT.z, w: 2.6, l: 5.4, dir: 0, style: 'box' };
const bayB: MapSlot = { id: 'bay-b', x: BAY_B_X, z: 7, w: 3.0, l: 5.6, dir: 0, style: 'box' };
const slots: MapSlot[] = [bayLift, bayB, ...row.slots];

const paint: PaintRect[] = [
  ...slots.flatMap((s) => slotPaint(s)),
  // 진입 유도선(베이 A/B 중심선) + 문 앞 정지선
  { x: BAY_A_X, z: -6, w: 0.12, d: 11, color: YELLOW },
  { x: BAY_B_X, z: -6, w: 0.12, d: 11, color: YELLOW },
  { x: BAY_A_X, z: -1.6, w: 3.6, d: 0.25, color: WHITE },
  { x: BAY_B_X, z: -1.6, w: 3.6, d: 0.25, color: WHITE },
  // 리프트 정렬 가이드(바퀴 통과선, 기둥 안쪽)
  { x: GARAGE_LIFT.x - 0.95, z: 6, w: 0.1, d: 8, color: YELLOW },
  { x: GARAGE_LIFT.x + 0.95, z: 6, w: 0.1, d: 8, color: YELLOW },
  // 앞마당 중앙선
  ...Array.from({ length: 9 }, (_, i) => ({ x: -18 + i * 4.2, z: -11.5, w: 2, d: 0.12, color: YELLOW })),
];

export const MAP_GARAGE: MapData = {
  id: 'garage',
  name: '정비소 (2주식 리프트 · 임시 배치)',
  desc: '정비소 건물의 베이 A 에 진입해 2주식 리프트 사이에 정위치로 세우고(P·주차 브레이크·시동 OFF) 리프트를 올리고 내립니다. ※ 건물 치수/리프트 규격은 사용자 확정 전의 임시 값입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.6 },
  spawn: { x: BAY_A_X, z: -14, heading: 0 },
  provisional: true,
  mechUnavailable: '정비소 전용 맵(리프트 검증용)',
  lifts: [GARAGE_LIFT],
  surfaces: [
    { x: 0, z: -3, w: 48, d: 38, kind: 'asphalt' },
    { x: 0, z: 7, w: 24.8, d: 14.8, kind: 'concrete' },
  ],
  paint,
  obstacles,
  slots,
  missions: [
    { id: 'gar-lift', name: '리프트 베이 진입 (베이 A)', kind: 'perpendicular-front', slotId: 'bay-lift', desc: '출입문을 지나 두 기둥 사이 중앙에 정위치로 세우세요. 이후 P·주차 브레이크·시동 OFF → 상승(PageUp).', parTimeSec: 60, timeLimitSec: 420 },
    { id: 'gar-bay', name: '점검 베이 후진 진입 (베이 B)', kind: 'perpendicular-reverse', slotId: 'bay-b', desc: '베이 B 에 후진으로 들어가 정차하세요.', parTimeSec: 80, timeLimitSec: 420, spawn: { x: BAY_B_X + 6, z: -10, heading: -Math.PI / 2 } },
  ],
};
