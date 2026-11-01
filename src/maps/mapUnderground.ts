import { drum, parkedCar, perimeter, pillar, slotPaint, slotRow, wallBox } from './helpers';
import type { MapData, ObstacleDef } from './types';

const bounds = { minX: -24, maxX: 24, minZ: -8.8, maxZ: 8.8 };
const PITCH = 2.3;
const START = -17.25;

const north = slotRow({ prefix: 'un', startX: START, z: 6.0, count: 16, pitch: PITCH, w: PITCH, l: 4.8, dir: 0, empty: [5, 11] });
const south = slotRow({ prefix: 'us', startX: START, z: -6.0, count: 16, pitch: PITCH, w: PITCH, l: 4.8, dir: Math.PI, empty: [3, 10] });

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 2.8, 0x6d6d6a),
  ...north.cars,
  ...south.cars,
];
// 구획 경계 기둥 (4칸마다)
for (const k of [4, 8, 12]) {
  const x = START - PITCH / 2 + PITCH * k;
  obstacles.push(pillar(`upil-n${k}`, x, 3.65, 0.5, 2.8, 0x8a8a86));
  obstacles.push(pillar(`upil-s${k}`, x, -3.65, 0.5, 2.8, 0x8a8a86));
}
// 통로 장애물
obstacles.push(drum('udrum-1', -20.5, 1.6), drum('udrum-2', -20.5, 2.3));
obstacles.push(wallBox('ubar-1', 14.5, -1.6, 2.4, 0.35, 0.9, 'barrier', 0xe0d040, 0.25));
obstacles.push(parkedCar('uaisle-car', -21.4, -1.6, Math.PI / 2, 0));

const slots = [...north.slots, ...south.slots];

const lightsX = [-18, -6, 6, 18];

export const MAP_UNDERGROUND: MapData = {
  id: 'underground',
  name: '지하 주차장',
  desc: '기둥과 좁은 구획(폭 2.3m), 어두운 조명. 정밀한 조작이 필요합니다.',
  bounds,
  env: { indoor: true, sky: 0x0d1015, ceilingHeight: 2.9, ambient: 0.28 },
  spawn: { x: 20, z: 0, heading: -Math.PI / 2 },
  surfaces: [{ x: 0, z: 0, w: 48, d: 17.6, kind: 'concrete' }],
  paint: [
    ...slots.flatMap((s) => slotPaint(s)),
    // 통로 중앙 노란 점선
    ...Array.from({ length: 12 }, (_, i) => ({ x: -20 + i * 3.6, z: 0, w: 1.6, d: 0.12, color: 0xf2c200 })),
  ],
  obstacles,
  slots,
  missions: [
    {
      id: 'ug-reverse',
      name: '후진 직각주차 (좁은 구획)',
      kind: 'perpendicular-reverse',
      slotId: 'un-5',
      desc: '북쪽 줄 비어 있는 좁은 칸에 후진 주차하세요. 기둥과 옆 차량에 주의.',
      parTimeSec: 70,
      timeLimitSec: 360,
    },
    {
      id: 'ug-front',
      name: '전면 직각주차 (좁은 구획)',
      kind: 'perpendicular-front',
      slotId: 'us-10',
      desc: '남쪽 줄 비어 있는 칸에 앞으로 주차하세요.',
      parTimeSec: 60,
      timeLimitSec: 360,
    },
  ],
  ceilingLights: lightsX.flatMap((x) => [
    { x, z: 0 },
    { x: x + 3, z: 0 },
    { x, z: 6 },
    { x, z: -6 },
  ]),
};
