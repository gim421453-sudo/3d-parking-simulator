import { cone, drum, lamp, parkedCar, perimeter, slotPaint, slotRow, tree, wallBox } from './helpers';
import type { MapData, MapSlot, ObstacleDef, PaintRect } from './types';

const bounds = { minX: -50, maxX: 50, minZ: -40, maxZ: 40 };

const rowN = slotRow({ prefix: 'on', startX: -26.25, z: -4.25, count: 10, pitch: 2.5, w: 2.5, l: 5.0, dir: 0, empty: [4, 8] });
const rowS = slotRow({ prefix: 'os', startX: -26.25, z: -15.75, count: 10, pitch: 2.5, w: 2.5, l: 5.0, dir: Math.PI, empty: [2, 6] });

// 도로변 평행주차 (도로는 z -38 ~ -26, 동쪽(+x)으로 진행하면 연석이 오른쪽)
const par: MapSlot = { id: 'op-0', x: -20, z: -24.7, w: 2.4, l: 6.4, dir: Math.PI / 2, style: 'box' };

const obstacles: ObstacleDef[] = [
  ...perimeter(bounds, 0.6, 1.3, 0x7e8a78),
  ...rowN.cars,
  ...rowS.cars,
  wallBox('plant-n', -15, -0.9, 28, 0.8, 0.8, 'planter', 0x6b7a5a),
  wallBox('plant-s', -15, -19.1, 28, 0.8, 0.8, 'planter', 0x6b7a5a),
  // 평행주차 줄
  parkedCar('opar-a', -13.8, -24.7, Math.PI / 2, 1),
  parkedCar('opar-b', -26.2, -24.7, Math.PI / 2, 0),
  parkedCar('opar-c', -7.5, -24.7, Math.PI / 2, 2),
  parkedCar('opar-d', -33.0, -24.7, Math.PI / 2, 1),
  { id: 'curb-s', tag: 'curb', shape: 'box', x: 0, z: -23.1, w: 100, d: 0.3, h: 0.15, color: 0xb4b4ae },
  // 건물
  { id: 'bld-1', tag: 'building', shape: 'box', x: -24, z: 16, w: 32, d: 14, h: 14, color: 0xc8c0b0 },
  { id: 'bld-2', tag: 'building', shape: 'box', x: 25, z: 29, w: 22, d: 14, h: 10, color: 0xa8b4c4 },
  { id: 'bld-3', tag: 'building', shape: 'box', x: -42, z: -8, w: 8, d: 12, h: 8, color: 0xd4c4a8 },
  // 자유주행 구역
  wallBox('bar-a', 22, 6, 3.2, 0.4, 0.9, 'barrier', 0xe8e8e8, 0.3),
  wallBox('bar-b', 30, 12, 3.2, 0.4, 0.9, 'barrier', 0xe8e8e8, -0.4),
  drum('odrum-1', 36, 2),
  drum('odrum-2', 36.8, 2.6),
];
// 콘 슬라럼 (자유주행 구역)
for (let k = 0; k < 7; k++) obstacles.push(cone(`ocone-${k}`, 16 + k * 3.8, -1 + (k % 2 === 0 ? 0 : 2.2)));
// 가로등
for (const [i, p] of ([[-24, -0.9], [-6, -0.9], [-24, -19.1], [-6, -19.1], [-40, -21.6], [-10, -21.6], [20, -21.6], [14, 8], [40, 8], [30, -2]] as [number, number][]).entries()) {
  obstacles.push(lamp(`olamp-${i}`, p[0], p[1]));
}
// 나무
for (const [i, p] of ([[-46, 30], [-46, 12], [-46, -18], [46, -4], [46, 20], [8, 36], [-6, 34], [46, -30]] as [number, number][]).entries()) {
  obstacles.push(tree(`otree-${i}`, p[0], p[1]));
}

const slots = [...rowN.slots, ...rowS.slots, par];

const paint: PaintRect[] = slots.flatMap((s) => slotPaint(s));
// 도로 중앙선 (노란 점선) + 도로 가장자리선
for (let i = 0; i < 25; i++) paint.push({ x: -48 + i * 4, z: -32, w: 2.4, d: 0.15, color: 0xf2c200 });
paint.push({ x: 0, z: -26.2, w: 100, d: 0.12, color: 0xf4f4f4 });
paint.push({ x: 0, z: -37.8, w: 100, d: 0.12, color: 0xf4f4f4 });

export const MAP_OUTDOOR: MapData = {
  id: 'outdoor',
  name: '야외 주차장',
  desc: '도로, 건물, 가로등이 있는 야외 맵. 주차 미션과 자유주행 구역.',
  bounds,
  env: { indoor: false, sky: 0x8fc4ee, ambient: 0.6 },
  spawn: { x: 6, z: -10, heading: -Math.PI / 2 },
  surfaces: [
    { x: 0, z: 0, w: 100, d: 80, kind: 'grass' },
    { x: -14, z: -10, w: 32, d: 20, kind: 'asphalt' }, // 주차장
    { x: 26, z: -10, w: 48, d: 6.5, kind: 'asphalt' }, // 진입로
    { x: 29, z: 6, w: 38, d: 24, kind: 'asphalt' }, // 자유주행 광장
    { x: 0, z: -32, w: 100, d: 12, kind: 'asphalt' }, // 도로
    { x: 0, z: -21.8, w: 100, d: 2.6, kind: 'sidewalk' },
  ],
  paint,
  obstacles,
  slots,
  missions: [
    {
      id: 'out-reverse',
      name: '후진 직각주차',
      kind: 'perpendicular-reverse',
      slotId: 'on-4',
      desc: '북쪽 줄의 빈 칸에 후진으로 주차하세요.',
      parTimeSec: 60,
      timeLimitSec: 300,
    },
    {
      id: 'out-front',
      name: '전면 직각주차',
      kind: 'perpendicular-front',
      slotId: 'os-6',
      desc: '남쪽 줄의 빈 칸에 앞으로 주차하세요.',
      parTimeSec: 50,
      timeLimitSec: 300,
    },
    {
      id: 'out-parallel',
      name: '도로변 평행주차',
      kind: 'parallel',
      slotId: 'op-0',
      desc: '도로변 두 차량 사이에 평행주차하세요. (연석은 센서에 감지되지 않습니다)',
      parTimeSec: 80,
      timeLimitSec: 360,
      spawn: { x: -44, z: -29.6, heading: Math.PI / 2 },
    },
  ],
};
