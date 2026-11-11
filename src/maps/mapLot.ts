import { cone, drum, parkedCar, perimeter, pillar, slotPaint, slotRow, wallBox } from './helpers';
import type { MapData, MapSlot, ObstacleDef } from './types';

const bounds = { minX: -36, maxX: 36, minZ: -28, maxZ: 28 };

const north = slotRow({ prefix: 'n', startX: -9.1, z: 20, count: 8, pitch: 2.6, w: 2.6, l: 5.2, dir: 0, empty: [2, 5] });
const south = slotRow({ prefix: 's', startX: -6.5, z: -20, count: 6, pitch: 2.6, w: 2.6, l: 5.2, dir: Math.PI, empty: [0, 2, 3, 5] });

const parallelSlot: MapSlot = { id: 'p-0', x: 24.4, z: 0, w: 2.5, l: 6.0, dir: 0, style: 'box' };

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.2, 0x8f8f8a),
  wallBox('n-back', 0, 23.5, 27, 0.6, 1.4, 'wall', 0x9c9c98),
  wallBox('s-back', 0, -23.5, 18, 0.6, 1.4, 'wall', 0x9c9c98),
  // 평행주차 구간: 연석(낮아서 센서 미감지) + 뒤쪽 벽
  { id: 'curb-e', tag: 'curb', shape: 'box', x: 26.0, z: 0, w: 0.4, d: 36, h: 0.15, color: 0xb0b0aa },
  wallBox('e-wall', 27.6, 0, 0.6, 36, 1.1, 'wall', 0x8c8c88),
  ...north.cars,
  ...south.cars,
  parkedCar('par-car-a', 24.4, -5.6, 0, 1),
  parkedCar('par-car-b', 24.4, 5.6, 0, 0),
  parkedCar('par-car-c', 24.4, -11.9, 0, 2),
  parkedCar('par-car-d', 24.4, 11.9, 0, 1),
  pillar('pil-1', -11.2, 17.2, 0.55, 3),
  pillar('pil-2', 11.2, 17.2, 0.55, 3),
  pillar('pil-3', -9.0, -17.0, 0.55, 3),
  pillar('pil-4', 9.0, -17.0, 0.55, 3),
  drum('drum-1', 14, 4),
  drum('drum-2', 14.9, 4.4),
  wallBox('barrier-1', -16, 6, 3.0, 0.4, 0.9, 'barrier', 0xd9dde0, 0.2),
  wallBox('barrier-2', -16, 10, 3.0, 0.4, 0.9, 'barrier', 0xd9dde0, -0.1),
];
// 슬라럼 콘
for (let k = 0; k < 6; k++) obstacles.push(cone(`slalom-${k}`, -26 + (k % 2 === 0 ? 0 : 1.6), -14 + k * 4.2));

const slots = [...north.slots, ...south.slots, parallelSlot];

export const MAP_LOT: MapData = {
  id: 'lot',
  mechUnavailable: '72×56m 소형 연습장: 시설(진입로 포함 22×16m)을 놓으면 모든 미션 동선(스폰→목표칸)과 겹친다',
  name: '기본 주차 연습장',
  desc: '넓은 평지. 직각·후진·평행주차를 연습하는 기본 맵.',
  bounds,
  env: { indoor: false, sky: 0x9ec9ee, ambient: 0.55 },
  spawn: { x: 0, z: -6, heading: 0 },
  surfaces: [
    { x: 0, z: 0, w: 72, d: 56, kind: 'asphalt' },
    { x: 26.9, z: 0, w: 0.8, d: 36, kind: 'sidewalk' },
  ],
  paint: slots.flatMap((s) => slotPaint(s)),
  obstacles,
  slots,
  missions: [
    {
      id: 'lot-front',
      name: '전면 직각주차',
      kind: 'perpendicular-front',
      slotId: 'n-2',
      desc: '북쪽 줄의 빈 칸(왼쪽)에 앞으로 들어가 주차하세요.',
      parTimeSec: 45,
      timeLimitSec: 300,
    },
    {
      id: 'lot-reverse',
      name: '후진 직각주차',
      kind: 'perpendicular-reverse',
      slotId: 'n-5',
      desc: '북쪽 줄의 빈 칸(오른쪽)에 후진으로 들어가 주차하세요.',
      parTimeSec: 60,
      timeLimitSec: 300,
    },
    {
      id: 'lot-parallel',
      name: '평행주차',
      kind: 'parallel',
      slotId: 'p-0',
      desc: '동쪽 도로변의 두 차량 사이 공간에 평행주차하세요.',
      parTimeSec: 75,
      timeLimitSec: 360,
      spawn: { x: 20.8, z: -19.5, heading: 0 },
    },
  ],
};
