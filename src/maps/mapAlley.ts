import { drum, parkedCar, perimeter, slotPaint, wallBox, YELLOW } from './helpers';
import type { MapData, MapSlot, ObstacleDef, PaintRect } from './types';

/**
 * 좁은 골목길 (v0.5.4, **임시 검증 맵** — 골목 폭/길이/건물 배치는 사용자 확정 전의 값).
 *
 *   남쪽 도로(폭 7m) ─ 골목 A(북쪽으로, 폭 3.4m) ─ 직각 회전 ─ 골목 B(동쪽으로, 폭 3.4m, 평행주차 홈) ─ 직각 회전 ─ 골목 C(남쪽으로, 폭 3.6m) ─ 도로
 *   골목 B 중간에서 북쪽으로 막다른 골목 D(폭 3.4m) + 끝의 회차 공간(10×6m).
 *   안쪽 모서리는 2m 모따기(실제 골목의 가각)로 직각 회전이 가능하다. 입구 볼라드/드럼통/주차 차량으로 폭이 더 좁아지는 곳이 있다.
 */
const bounds = { minX: -30, maxX: 30, minZ: -24, maxZ: 24 };
export const ALLEY = {
  street: { z0: -21.5, z1: -14.5 },
  A: { x0: -19.7, x1: -16.3 },
  B: { z0: 8.3, z1: 11.7 },
  C: { x0: 12.2, x1: 15.8 },
  D: { x0: -3.7, x1: -0.3, z1: 17 },
  pocket: { x0: -6, x1: 4, z0: 17, z1: 23 },
  chamfer: 2.5,
  /** 골목 입구 가각(도로 쪽 모서리를 2.5m 물린다): 7m 도로에서 3.4m 골목으로 직각 진입이 가능하도록 */
  flare: 2.5,
} as const;
const A = ALLEY;
const H = [7, 9, 6, 8, 10, 7, 9];
let bi = 0;
const bld = (id: string, x0: number, x1: number, z0: number, z1: number, color: number): ObstacleDef => ({ id, tag: 'building', shape: 'box', x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h: H[bi++ % H.length], color });

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.4, 0x8f8f8a),
  // 서쪽 블록
  bld('al-b-w', bounds.minX, A.A.x0, A.street.z1 + A.flare, bounds.maxZ, 0xc8c0b0),
  bld('al-b-w-s', bounds.minX, A.A.x0 - A.flare, A.street.z1, A.street.z1 + A.flare, 0xc8c0b0),
  // 가운데 블록 (본체 + 북쪽 띠 2조각: 안쪽 모서리 2m 모따기 + 평행주차 홈(x 2~9, 깊이 2m))
  bld('al-b-c', A.A.x1, A.C.x0, A.street.z1 + A.flare, A.B.z0 - 2, 0xa8b4c4),
  bld('al-b-c-s', A.A.x1 + A.flare, A.C.x0 - A.flare, A.street.z1, A.street.z1 + A.flare, 0xa8b4c4),
  bld('al-b-c-n1', A.A.x1 + A.chamfer, 2, A.B.z0 - 2, A.B.z0, 0xa8b4c4),
  bld('al-b-c-n2', 9, A.C.x0 - A.chamfer, A.B.z0 - 2, A.B.z0, 0xa8b4c4),
  // 북쪽 블록들 (막다른 골목 D 와 회차 공간을 남긴다)
  // 막다른 골목 D 입구도 양쪽 모서리를 2.5m 물린다(T자 진입)
  bld('al-b-nw1', A.A.x0, A.D.x0 - A.chamfer, A.B.z1, A.B.z1 + A.chamfer, 0xd4c4a8),
  bld('al-b-nw1b', A.A.x0, A.D.x0, A.B.z1 + A.chamfer, A.D.z1, 0xd4c4a8),
  bld('al-b-nw2', A.A.x0, A.pocket.x0, A.D.z1, bounds.maxZ, 0xd4c4a8),
  bld('al-b-ne1', A.D.x1 + A.chamfer, bounds.maxX, A.B.z1, A.B.z1 + A.chamfer, 0xbfc7b4),
  bld('al-b-ne1b', A.D.x1, bounds.maxX, A.B.z1 + A.chamfer, A.D.z1, 0xbfc7b4),
  bld('al-b-ne2', A.pocket.x1, bounds.maxX, A.D.z1, bounds.maxZ, 0xbfc7b4),
  bld('al-b-n', A.pocket.x0, A.pocket.x1, A.pocket.z1, bounds.maxZ, 0xb9b3a6),
  // 동쪽 블록
  bld('al-b-e', A.C.x1, bounds.maxX, A.street.z1 + A.flare, A.B.z1, 0xc4b8c8),
  bld('al-b-e-s', A.C.x1 + A.flare, bounds.maxX, A.street.z1, A.street.z1 + A.flare, 0xc4b8c8),
  // 골목 입구 볼라드(폭 표시, 실제 충돌체)
  { id: 'al-bol-a1', tag: 'bollard', shape: 'cyl', x: A.A.x0 + 0.2, z: A.street.z1 + A.flare + 0.4, r: 0.1, h: 0.95 },
  { id: 'al-bol-a2', tag: 'bollard', shape: 'cyl', x: A.A.x1 - 0.2, z: A.street.z1 + A.flare + 0.4, r: 0.1, h: 0.95 },
  { id: 'al-bol-c1', tag: 'bollard', shape: 'cyl', x: A.C.x0 + 0.2, z: A.street.z1 + A.flare + 0.4, r: 0.1, h: 0.95 },
  { id: 'al-bol-c2', tag: 'bollard', shape: 'cyl', x: A.C.x1 - 0.2, z: A.street.z1 + A.flare + 0.4, r: 0.1, h: 0.95 },
  // 골목 안 장애물: 드럼통(벽 쪽), 내놓은 상자 — 폭이 3.0m 안팎으로 좁아진다
  drum('al-drum-1', A.A.x0 + 0.3, -4),
  { id: 'al-box-1', tag: 'planter', shape: 'box', x: -9, z: A.B.z1 - 0.3, w: 1.0, d: 0.5, h: 0.8, color: 0x7a6a4a },
  { id: 'al-box-2', tag: 'planter', shape: 'box', x: A.C.x1 - 0.3, z: 2, w: 0.5, d: 1.0, h: 0.9, color: 0x54606a },
  // 도로변 주차 차량(불규칙) + 회차 공간 안 주차 차량
  parkedCar('al-st-car1', -8, A.street.z0 + 1.2, Math.PI / 2, 1),
  parkedCar('al-st-car2', 2.5, A.street.z0 + 1.3, Math.PI / 2 + 0.04, 0),
  parkedCar('al-st-car3', 24.5, A.street.z0 + 1.2, -Math.PI / 2, 2),
  parkedCar('al-pk-car', A.pocket.x1 - 1.4, 20.2, 0.06, 1),
  wallBox('al-st-plant', 12, A.street.z0 + 0.5, 6, 0.6, 0.7, 'planter', 0x6b7a5a),
];

const par: MapSlot = { id: 'al-par', x: 5.5, z: A.B.z0 - 1.0, w: 2.0, l: 6.4, dir: Math.PI / 2, style: 'box' };
const end: MapSlot = { id: 'al-end', x: -3.2, z: 20, w: 2.8, l: 5.4, dir: Math.PI / 2, style: 'box' };
const slots: MapSlot[] = [par, end];

const paint: PaintRect[] = [
  ...slots.flatMap((s) => slotPaint(s)),
  ...Array.from({ length: 13 }, (_, i) => ({ x: -26 + i * 4.3, z: -18, w: 2.2, d: 0.12, color: YELLOW })),
];

export const MAP_ALLEY: MapData = {
  id: 'alley',
  name: '좁은 골목길 (임시 배치)',
  desc: '폭 3.4~3.6m 골목을 직각으로 두 번 돌아 통과합니다. 골목 안 평행주차 홈, 막다른 골목과 회차 공간이 있습니다. ※ 골목 폭/길이/배치는 사용자 확정 전의 임시 값입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.55 },
  spawn: { x: -26, z: -18, heading: Math.PI / 2 },
  provisional: true,
  mechUnavailable: '골목 검증용 맵',
  surfaces: [{ x: 0, z: 0, w: 60, d: 48, kind: 'asphalt' }],
  paint,
  obstacles,
  slots,
  missions: [
    { id: 'al-1', name: '골목 통과 → 평행주차', kind: 'parallel', slotId: 'al-par', desc: '골목 A 로 들어가 직각으로 돌아 골목 B 의 평행주차 홈에 주차하세요.', parTimeSec: 120, timeLimitSec: 600 },
    { id: 'al-2', name: '막다른 골목 → 회차 공간 주차', kind: 'perpendicular-front', slotId: 'al-end', desc: '골목 B 에서 막다른 골목으로 들어가 끝의 회차 공간에 주차하세요. 나올 때는 회차하거나 후진으로 나옵니다.', parTimeSec: 140, timeLimitSec: 600 },
  ],
};
