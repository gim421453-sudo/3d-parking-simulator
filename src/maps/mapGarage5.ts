import type { Terrain, RampSurface } from './terrain';
import { addHoleGuards, addPerimeter, addPillar, addRampWalls, addRow, newKit } from './levelKit';
import type { MapData } from './types';

/**
 * 5층 지그재그 주차타워 (v0.4.9, **임시 고정 레이아웃**). 직접 제작한 절차적 지형/충돌/미션 — 외부 GLB 를 사용하지 않는다.
 *  - 층고 3.0m, 직선 경사로 22m(13.6%) 4개가 동쪽(진행 방향 +x)/서쪽(-x)으로 번갈아 층을 잇는다.
 *  - 경사로 아래로는 위층 바닥에 개구부(hole)를 내고 난간을 둔다. 각 층 서쪽 구역에 양쪽 주차 줄 + 기둥, 가운데 U턴 공간.
 */
export const G5_LEVEL_Y = [0, 3, 6, 9, 12] as const;
const FH = 3;
const RAMP_L = 22;
const RAMP_W = 3.8;
const LANE = 4.6; // 경사로 차선 z = ∓LANE
const X0 = -32;
const X1 = 34;
const Z = 11;
const bounds = { minX: -39, maxX: 36, minZ: -13, maxZ: 13 };

/** 경사로 k(1~4): 홀수는 동쪽(+x)으로 남쪽 차선, 짝수는 서쪽(-x)으로 북쪽 차선 */
const ramps: RampSurface[] = [1, 2, 3, 4].map((k) =>
  k % 2 === 1
    ? { kind: 'ramp', id: `g5-ramp${k}`, x: 0, z: -LANE, rot: Math.PI / 2, length: RAMP_L, width: RAMP_W, y0: G5_LEVEL_Y[k - 1], y1: G5_LEVEL_Y[k] }
    : { kind: 'ramp', id: `g5-ramp${k}`, x: RAMP_L, z: LANE, rot: -Math.PI / 2, length: RAMP_L, width: RAMP_W, y0: G5_LEVEL_Y[k - 1], y1: G5_LEVEL_Y[k] },
);

export const G5_TERRAIN: Terrain = {
  levels: G5_LEVEL_Y.map((y, i) => ({ id: `L${i + 1}`, name: `${i + 1}F`, y })),
  surfaces: [
    ...G5_LEVEL_Y.map((y, i) => ({
      kind: 'deck' as const,
      id: `g5-deck${i + 1}`,
      rect: i === 0 ? { x: (-40 + X1) / 2, z: 0, w: X1 + 40, d: 2 * Z } : { x: (X0 + X1) / 2, z: 0, w: X1 - X0, d: 2 * Z }, // 1F 는 입구 앞(x=-36)까지 지면
      y,
      // 아래층에서 올라오는 경사로 위의 개구부
      holes:
        i === 0
          ? undefined
          : [ramps[i - 1].rot > 0 ? { x: 10.9, z: -LANE, w: RAMP_L + 0.2, d: RAMP_W + 0.4 } : { x: 11.1, z: LANE, w: RAMP_L + 0.2, d: RAMP_W + 0.4 }],
    })),
    ...ramps,
  ],
};

const k = newKit();
// 층별로 비워 두는 칸 (미션 목표 + 여분)
const emptyN = [[3, 6], [1, 6], [4, 0], [2, 5], [6, 1]];
const emptyS = [[2, 5], [5, 2], [7, 3], [1, 6], [4, 0]];
G5_LEVEL_Y.forEach((y, li) => {
  const f = li + 1;
  addRow(k, y, { prefix: `g${f}-n`, startX: -29.4, z: 7.5, count: 8, pitch: 2.8, w: 2.8, l: 5.4, dir: 0, empty: emptyN[li] });
  addRow(k, y, { prefix: `g${f}-s`, startX: -29.4, z: -7.5, count: 8, pitch: 2.8, w: 2.8, l: 5.4, dir: Math.PI, empty: emptyS[li] });
  for (const px of [-30.8, -19.6]) {
    addPillar(k, y, `g${f}-pn${px}`, px, 5.0, 0.4, FH - 0.4);
    addPillar(k, y, `g${f}-ps${px}`, px, -5.0, 0.4, FH - 0.4);
  }
  const rect = { x0: X0, x1: X1, z0: -Z, z1: Z };
  if (f === 1) addPerimeter(k, y, 'g1', rect, 3.0, { w: [[-5.5, 5.5]] });
  else addPerimeter(k, y, `g${f}`, rect, 1.1);
  if (f >= 2) {
    const r = ramps[f - 2]; // 이 층으로 올라오는 경사로
    if (r.rot > 0) addHoleGuards(k, y, `g${f}-h`, { x0: -0.2, x1: 22.0, zc: -LANE, hw: RAMP_W / 2 + 0.2 }, 'x1');
    else addHoleGuards(k, y, `g${f}-h`, { x0: 0.0, x1: 22.2, zc: LANE, hw: RAMP_W / 2 + 0.2 }, 'x0');
  }
});
ramps.forEach((r) => addRampWalls(k, r));

const mk = (id: string, name: string, kind: 'perpendicular-front' | 'perpendicular-reverse', slotId: string, desc: string, par: number, spawn?: MapData['spawn']) => ({
  id,
  name,
  kind,
  slotId,
  desc,
  parTimeSec: par,
  timeLimitSec: par * 4 + 120,
  spawn,
});

export const MAP_GARAGE5: MapData = {
  id: 'garage5',
  name: '5층 지그재그 주차타워 (임시 배치)',
  desc: '22m 직선 경사로 4개가 동·서로 번갈아 5층까지 이어지는 다층 주차타워. 층별 기둥·좁은 U턴·양쪽 주차 줄. ※ 외부 모델 없이 직접 제작한 절차적 지형이며 층수·치수는 사용자 확정 전의 임시 배치입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.55 },
  spawn: { x: -35, z: 0, heading: Math.PI / 2, y: 0 },
  terrain: G5_TERRAIN,
  levelPaint: k.levelPaint,
  provisional: true,
  surfaces: [{ x: (X0 + X1) / 2 - 2, z: 0, w: X1 - X0 + 4, d: 2 * Z + 2, kind: 'concrete' }],
  paint: k.paint,
  obstacles: k.obstacles,
  slots: k.slots,
  missions: [
    mk('g5-1', '1층 후진 주차 (임시)', 'perpendicular-reverse', 'g1-n-3', '입구로 들어가 1층 북쪽 줄 빈 칸에 후진 주차하세요.', 70),
    mk('g5-2', '2층 전면 주차 (임시)', 'perpendicular-front', 'g2-s-5', '경사로 1을 올라 2층 남쪽 줄 빈 칸에 전면 주차하세요.', 110, { x: -9, z: -3, heading: Math.PI / 2, y: 0 }),
    mk('g5-3', '3층 후진 주차 (임시)', 'perpendicular-reverse', 'g3-n-4', '경사로 2를 올라 3층 북쪽 줄 빈 칸에 후진 주차하세요.', 130, { x: 29, z: LANE, heading: -Math.PI / 2, y: 3 }),
    mk('g5-4', '4층 전면 주차 (임시)', 'perpendicular-front', 'g4-s-1', '경사로 3을 올라 4층 남쪽 줄 빈 칸에 전면 주차하세요.', 130, { x: -9, z: -3, heading: Math.PI / 2, y: 6 }),
    mk('g5-5', '5층 후진 주차 (임시)', 'perpendicular-reverse', 'g5-n-6', '경사로 4를 올라 5층(옥상) 북쪽 줄 빈 칸에 후진 주차하세요.', 150, { x: 29, z: LANE, heading: -Math.PI / 2, y: 9 }),
  ],
};
