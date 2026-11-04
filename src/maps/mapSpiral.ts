import { localToWorld } from '../core/math';
import { cone, parkedCar, perimeter, wallBox } from './helpers';
import { addRow, addSlot, addSpiralWalls, addWall, newKit } from './levelKit';
import type { SpiralSurface, Terrain } from './terrain';
import type { MapData, MapSlot } from './types';

/**
 * 나선형 경사로 테스트 맵 (v0.4.9, **임시 고정 레이아웃**). 직접 제작한 절차적 지형 — SKP/GLB 원본은 사용하지 않는다.
 *  - 폭 5.0m(r 4.2~9.2), 333° 한 바퀴, 높이 3.2m → 평균 경사 약 8.2%. (폭 4m 는 SUV 의 차체 길이 때문에 앞 코너가 바깥 난간에 닿아 5m 로 넓혔다) 안/바깥 난간 + 가운데 기둥.
 *  - 지상 진입로(남쪽)에서 나선을 올라 상층 착지 데크의 주차 3칸에 주차한다. 지상 주차 줄 6칸 포함.
 */
const CX = 0;
const CZ = 0;
const SP: SpiralSurface = { kind: 'spiral', id: 'sp-spiral', cx: CX, cz: CZ, r0: 4.2, r1: 9.2, th0: 0, th1: 1.85 * Math.PI, y0: 0, y1: 3.2 };
const RM = (SP.r0 + SP.r1) / 2;
export const SPIRAL_TOP_Y = SP.y1;
/** 나선 끝(θ1) 지점과 진행 방향 → 착지 데크 */
export const SPIRAL_END = { x: CX + RM * Math.cos(SP.th1), z: CZ + RM * Math.sin(SP.th1), heading: Math.atan2(-Math.sin(SP.th1), Math.cos(SP.th1)) };
const DECK = { len: 14, wid: 9 };
const deckCenter = localToWorld(SPIRAL_END.x, SPIRAL_END.z, SPIRAL_END.heading, 0, DECK.len / 2);
const bounds = { minX: -20, maxX: 26, minZ: -30, maxZ: 18 };

export const SP_TERRAIN: Terrain = {
  levels: [
    { id: 'GL', name: '지상', y: 0 },
    { id: 'TOP', name: '상층', y: SP.y1 },
  ],
  surfaces: [
    { kind: 'deck', id: 'sp-ground', rect: { x: 3, z: -6, w: 48, d: 56 }, y: 0 },
    { kind: 'deck', id: 'sp-landing', rect: { x: deckCenter.x, z: deckCenter.z, w: DECK.wid, d: DECK.len, rot: SPIRAL_END.heading }, y: SP.y1 },
    SP,
  ],
};

const k = newKit();
addSpiralWalls(k, SP, 48);
// 가운데 기둥(코어)
k.obstacles.push({ id: 'sp-core', tag: 'pillar', shape: 'cyl', x: CX, z: CZ, r: 3.2, h: 6, color: 0xb4b2ac });
// 착지 데크 난간 (끝/양옆, 나선이 들어오는 쪽은 열어 둠) — 데크 로컬 좌표(x: 폭, z: 진행)
const wl = (lx: number, lz: number): { x: number; z: number } => localToWorld(deckCenter.x, deckCenter.z, SPIRAL_END.heading, lx, lz);
{
  const hd = DECK.len / 2;
  const hw = DECK.wid / 2;
  const e = wl(0, hd + 0.15);
  addWall(k, SP.y1, 'spl-end', e.x, e.z, DECK.wid + 0.6, 0.3, 1.1, 0x9a9a96, SPIRAL_END.heading);
  for (const s of [1, -1]) {
    const w = wl(s * (hw + 0.15), 1.2);
    addWall(k, SP.y1, `spl-side${s}`, w.x, w.z, 0.3, DECK.len - 2.4, 1.1, 0x9a9a96, SPIRAL_END.heading);
  }
}
// 착지 데크 주차 3칸 (진행 방향 끝쪽)
for (let i = 0; i < 3; i++) {
  const c = wl((i - 1) * 2.8, hdSlot());
  const s: MapSlot = { id: `sp-d-${i}`, x: c.x, z: c.z, w: 2.8, l: 5.4, dir: SPIRAL_END.heading, style: 'u' };
  addSlot(k, SP.y1, s, i === 1 ? undefined : parkedCar(`sp-dcar${i}`, s.x, s.z, s.dir, i + 3));
}
function hdSlot(): number {
  return DECK.len / 2 - 2.9;
}
// 지상 주차 줄 (남쪽, 6칸) + 콘
addRow(k, 0, { prefix: 'sp-g', startX: -4.2, z: -23.5, count: 6, pitch: 2.8, w: 2.8, l: 5.4, dir: 0, empty: [2, 4] });
for (let i = 0; i < 5; i++) k.obstacles.push(cone(`sp-cone${i}`, -3.0, -18 + i * 2.2));
k.obstacles.push(wallBox('sp-back', 1.5, -27.2, 24, 0.6, 1.3, 'wall', 0x9c9c98));

export const MAP_SPIRAL: MapData = {
  id: 'spiral',
  name: '나선형 경사로 테스트 (임시 배치)',
  desc: '폭 5m·333° 한 바퀴(평균 경사 8.2%)의 나선 램프를 올라 상층 데크에 주차하는 경사로 연습 맵. 안/바깥 난간과 가운데 기둥, 급한 회전으로 차량 피치와 시야를 확인합니다. ※ 직접 제작한 절차적 지형(외부 SKP/GLB 미사용)이며 배치는 임시안입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.55 },
  spawn: { x: RM, z: -16, heading: 0, y: 0 },
  terrain: SP_TERRAIN,
  levelPaint: k.levelPaint,
  provisional: true,
  surfaces: [{ x: 3, z: -6, w: 46, d: 54, kind: 'concrete' }],
  paint: k.paint,
  obstacles: [...perimeter(bounds, 0.6, 1.2, 0x8f8f8a), ...k.obstacles],
  slots: k.slots,
  missions: [
    { id: 'sp-1', name: '지상 후진 주차', kind: 'perpendicular-reverse', slotId: 'sp-g-2', desc: '남쪽 줄의 빈 칸에 후진으로 주차하세요. (워밍업)', parTimeSec: 60, timeLimitSec: 300, spawn: { x: 3, z: -12, heading: 0, y: 0 } },
    { id: 'sp-2', name: '나선 상승 → 상층 전면 주차', kind: 'perpendicular-front', slotId: 'sp-d-1', desc: '나선 램프를 한 바퀴 올라 상층 데크 가운데 칸에 전면 주차하세요.', parTimeSec: 110, timeLimitSec: 480 },
    { id: 'sp-3', name: '나선 상승 → 상층 후진 주차', kind: 'perpendicular-reverse', slotId: 'sp-d-1', desc: '나선 램프를 올라 상층 데크 가운데 칸에 후진 주차하세요.', parTimeSec: 130, timeLimitSec: 540 },
  ],
};
