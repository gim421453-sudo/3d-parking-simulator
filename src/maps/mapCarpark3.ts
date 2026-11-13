import type { RampSurface, Terrain } from './terrain';
import { addHoleGuards, addPerimeter, addPillar, addRampWalls, addRow, newKit } from './levelKit';
import type { MapData } from './types';

/**
 * 3층 순환형 주차장 (v0.4.9, **임시 고정 레이아웃**). 직접 제작한 절차적 지형/충돌/미션 — 외부 GLB 미사용.
 *  - 바깥 순환 도로(폭 5.5m, 모서리는 넓게 열림) + 가운데 이중 주차 블록(양쪽 10칸, 중앙 통로 6.2m, 기둥).
 *  - 경사로 2개: 1F→2F 는 남쪽 차선(동쪽으로), 2F→3F 는 북쪽 차선(서쪽으로). 순환 도로의 직각 회전 구간을 지나야 상층에 닿는다.
 */
export const C3_LEVEL_Y = [0, 3, 6] as const;
const FH = 3;
const LANE_Z = 11.25;
const X0 = -23;
const X1 = 23;
const Z = 14;
const bounds = { minX: -31, maxX: 25, minZ: -16, maxZ: 16 };

const ramps: RampSurface[] = [
  { kind: 'ramp', id: 'c3-ramp1', x: -14, z: -LANE_Z, rot: Math.PI / 2, length: 22, width: 3.8, y0: 0, y1: FH },
  { kind: 'ramp', id: 'c3-ramp2', x: 14, z: LANE_Z, rot: -Math.PI / 2, length: 22, width: 3.8, y0: FH, y1: 2 * FH },
];

export const C3_TERRAIN: Terrain = {
  levels: C3_LEVEL_Y.map((y, i) => ({ id: `L${i + 1}`, name: `${i + 1}F`, y })),
  surfaces: [
    ...C3_LEVEL_Y.map((y, i) => ({
      kind: 'deck' as const,
      id: `c3-deck${i + 1}`,
      rect: i === 0 ? { x: (-34 + X1) / 2, z: 0, w: X1 + 34, d: 2 * Z } : { x: 0, z: 0, w: X1 - X0, d: 2 * Z },
      y,
      holes: i === 1 ? [{ x: -3.1, z: -LANE_Z, w: 22.2, d: 4.2 }] : i === 2 ? [{ x: 3.1, z: LANE_Z, w: 22.2, d: 4.2 }] : undefined,
    })),
    ...ramps,
  ],
};

const k = newKit();
const emptyN = [[4, 8], [1, 5], [7, 2]];
const emptyS = [[2, 7], [6, 3], [0, 5]];
C3_LEVEL_Y.forEach((y, li) => {
  const f = li + 1;
  addRow(k, y, { prefix: `c${f}-n`, startX: -12.6, z: 5.8, count: 10, pitch: 2.8, w: 2.8, l: 5.4, dir: 0, empty: emptyN[li] });
  addRow(k, y, { prefix: `c${f}-s`, startX: -12.6, z: -5.8, count: 10, pitch: 2.8, w: 2.8, l: 5.4, dir: Math.PI, empty: emptyS[li] });
  for (const px of [-14, -2.8, 8.4]) {
    addPillar(k, y, `c${f}-pn${px}`, px, 3.3, 0.4, FH - 0.4);
    addPillar(k, y, `c${f}-ps${px}`, px, -3.3, 0.4, FH - 0.4);
  }
  const rect = { x0: X0, x1: X1, z0: -Z, z1: Z };
  if (f === 1) addPerimeter(k, y, 'c1', rect, 3.0, { w: [[-Z, -8.5]] });
  else addPerimeter(k, y, `c${f}`, rect, 1.1);
});
addHoleGuards(k, 3, 'c2-h', { x0: -14.2, x1: 8.0, zc: -LANE_Z, hw: 1.9 + 0.2 }, 'x1');
addHoleGuards(k, 6, 'c3-h', { x0: -8.0, x1: 14.2, zc: LANE_Z, hw: 1.9 + 0.2 }, 'x0');
ramps.forEach((r) => addRampWalls(k, r));

export const MAP_CARPARK3: MapData = {
  id: 'carpark3',
  mechUnavailable: '지상층 전체를 데크/경사로가 덮어 시설을 놓을 지상 공간이 없다',
  name: '3층 순환형 주차장 (임시 배치)',
  desc: '바깥 순환 도로를 돌아 경사로 2개로 3층까지 오르는 주차장. 중앙의 이중 주차 블록, 기둥, 좁은 직각 회전 구간. ※ 외부 모델 없이 직접 제작한 절차적 지형이며 배치는 사용자 확정 전의 임시안입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.55 },
  spawn: { x: -28, z: -LANE_Z, heading: Math.PI / 2, y: 0 },
  terrain: C3_TERRAIN,
  levelPaint: k.levelPaint,
  provisional: true,
  surfaces: [{ x: -5.5, z: 0, w: 57, d: 30, kind: 'concrete' }],
  paint: k.paint,
  obstacles: k.obstacles,
  slots: k.slots,
  missions: [
    { id: 'c3-1', name: '1층 후진 주차 (임시)', kind: 'perpendicular-reverse', slotId: 'c1-n-4', desc: '입구에서 들어가 1층 중앙 블록 북쪽 줄 빈 칸에 후진 주차하세요.', parTimeSec: 90, timeLimitSec: 420 },
    { id: 'c3-2', name: '경사로 → 2층 전면 주차 (임시)', kind: 'perpendicular-front', slotId: 'c2-s-6', desc: '남쪽 차선 경사로를 올라 2층 남쪽 줄 빈 칸에 전면 주차하세요.', parTimeSec: 120, timeLimitSec: 480, spawn: { x: -20, z: -LANE_Z, heading: Math.PI / 2, y: 0 } },
    { id: 'c3-3', name: '순환 도로 → 3층 후진 주차 (임시)', kind: 'perpendicular-reverse', slotId: 'c3-n-7', desc: '2층 순환 도로를 한 바퀴 돌아 북쪽 경사로로 3층에 올라 북쪽 줄 빈 칸에 후진 주차하세요.', parTimeSec: 150, timeLimitSec: 540, spawn: { x: 12, z: -LANE_Z, heading: Math.PI / 2, y: FH } }, // v0.5.4 맵 자동 검사로 발견: 이전 x=0 은 경사로 개구부(2F 바닥 구멍) 위라 차량이 공중에 떠서 움직이지 못했다 → 경사로 꼭대기(x=8) 지난 2F 바닥 위로 옮김
  ],
};
