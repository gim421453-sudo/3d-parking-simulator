import type { Terrain } from './terrain';
import { parkedCar, slotPaint, slotRow, wallBox, pillar, WHITE } from './helpers';
import type { MapData, MapSlot, ObstacleDef, PaintRect } from './types';

/**
 * 다층 주차타워 — **검증용 임시 고정 레이아웃 (최종 확정 맵이 아님)**.
 * 층수/통로 폭/주차칸 치수/차량 배치는 사용자가 확정한 뒤 이 파일의 상수만 바꿔 반영한다.
 * 데이터(이 파일: 지형·충돌체·슬롯·미션)와 3D 에셋(`towerBuilder.ts`)은 분리되어 있다.
 *
 *  1F (y=0)    : 진입 직선 경사로(R1, 길이 22m, 경사 14.5%) 시작 + 지상 주차칸 6+6
 *  2F (y=3.2)  : R1 도착, 주차칸 6+6, 나선형 램프(골뱅이) 시작
 *  3F (y=6.4)  : 나선형 램프 도착, 옥상 주차칸 6+6 (지붕 없음)
 */
export const TOWER_LEVEL_Y = [0, 3.2, 6.4] as const;
const FLOOR_H = 3.2;
const SLOT_START_X = -4.2;
const SLOT_PITCH = 2.8;
const SLOT_COUNT = 6;
const ROW_Z = 6.4;
const bounds = { minX: -36, maxX: 34, minZ: -11, maxZ: 13 };

// 직선 경사로 R1 (1F → 2F)
const RAMP = { x: -30, z: 0, rot: Math.PI / 2, length: 22, width: 3.8, y0: 0, y1: FLOOR_H };
// 나선형 램프 S1 (2F → 3F): 중심, 반경, 각도(CCW), 높이
const SP = { cx: 24, cz: 5.2, r0: 3.4, r1: 7.0, th0: -Math.PI / 2, th1: Math.PI, y0: FLOOR_H, y1: 2 * FLOOR_H };
const spiralY = (th: number): number => SP.y0 + ((SP.y1 - SP.y0) * (th - SP.th0)) / (SP.th1 - SP.th0);

const decks = [
  { id: 'deck-1f', rect: { x: -1, z: 1, w: 70, d: 24 }, y: 0 },
  { id: 'deck-2f', rect: { x: 13, z: 1, w: 42, d: 24 }, y: FLOOR_H },
  { id: 'deck-3f', rect: { x: 13, z: 1, w: 42, d: 24 }, y: 2 * FLOOR_H, holes: [{ cx: SP.cx, cz: SP.cz, r: SP.r1 + 0.4 }] },
  // 3F 도착 구간(나선 끝 θ=180° 부근): 구멍 안쪽 남서부를 메우는 착지 덱
  { id: 'landing-3f', rect: { x: 20.4, z: 2.2, w: 7.6, d: 6.2 }, y: 2 * FLOOR_H },
] as const;

export const TOWER_TERRAIN: Terrain = {
  levels: [
    { id: 'L1', name: '1F', y: 0 },
    { id: 'L2', name: '2F', y: FLOOR_H },
    { id: 'L3', name: '3F', y: 2 * FLOOR_H },
  ],
  surfaces: [
    ...decks.map((d) => ({ kind: 'deck' as const, id: d.id, rect: d.rect, y: d.y, holes: 'holes' in d ? [...d.holes] : undefined })),
    { kind: 'ramp', id: 'ramp-r1', ...RAMP },
    { kind: 'spiral', id: 'spiral-s1', ...SP },
  ],
};

const obstacles: ObstacleDef[] = [];
const slots: MapSlot[] = [];
const levelPaint: (PaintRect & { y: number })[] = [];
const paint: PaintRect[] = [];

// ---- 층별 주차칸 / 주차 차량 / 기둥 / 난간 ----
const mission: Record<number, string[]> = { 0: ['tw1-n-3', 'tw1-s-2'], 1: ['tw2-n-2', 'tw2-s-4'], 2: ['tw3-n-4', 'tw3-s-1'] }; // 비워 두는 칸 (미션 목표)
TOWER_LEVEL_Y.forEach((y, li) => {
  const f = li + 1;
  const emptyN = [Number(mission[li][0].split('-')[2])];
  const emptyS = [Number(mission[li][1].split('-')[2])];
  const north = slotRow({ prefix: `tw${f}-n`, startX: SLOT_START_X, z: ROW_Z, count: SLOT_COUNT, pitch: SLOT_PITCH, w: SLOT_PITCH, l: 5.4, dir: 0, empty: emptyN });
  const south = slotRow({ prefix: `tw${f}-s`, startX: SLOT_START_X, z: -ROW_Z, count: SLOT_COUNT, pitch: SLOT_PITCH, w: SLOT_PITCH, l: 5.4, dir: Math.PI, empty: emptyS });
  for (const s of [...north.slots, ...south.slots]) {
    slots.push({ ...s, y });
    for (const p of slotPaint(s)) {
      if (y === 0) paint.push(p);
      else levelPaint.push({ ...p, y });
    }
  }
  for (const c of [...north.cars, ...south.cars]) obstacles.push({ ...c, id: c.id, y0: y });
  // 기둥 (통로 가장자리)
  for (const x of [5.6, 12.6]) {
    obstacles.push({ ...pillar(`tw${f}-pil-n${x}`, x, 3.85, 0.5, FLOOR_H - 0.4), y0: y });
    obstacles.push({ ...pillar(`tw${f}-pil-s${x}`, x, -3.85, 0.5, FLOOR_H - 0.4), y0: y });
  }
  // 난간/외벽 (높이 1.1m, 1F 는 전체 3m 벽)
  const wallH = y === 0 ? 3.0 : 1.1;
  const x0 = y === 0 ? -8 : -8;
  const x1 = 34;
  if (f === 3) {
    // 3F 북쪽 난간은 나선 램프가 통과하는 구멍(원) 구간을 비운다
    const hx = Math.sqrt((SP.r1 + 0.4) ** 2 - (12.15 - SP.cz) ** 2);
    const a1 = SP.cx - hx - 0.1;
    const a2 = SP.cx + hx + 0.1;
    obstacles.push({ ...wallBox('tw3-wall-n1', (x0 - 0.3 + a1) / 2, 12.15, a1 - (x0 - 0.3), 0.3, wallH, 'wall', 0x8e8e8a), y0: y });
    obstacles.push({ ...wallBox('tw3-wall-n2', (a2 + x1 + 0.3) / 2, 12.15, x1 + 0.3 - a2, 0.3, wallH, 'wall', 0x8e8e8a), y0: y });
  } else obstacles.push({ ...wallBox(`tw${f}-wall-n`, (x0 + x1) / 2, 12.15, x1 - x0 + 0.6, 0.3, wallH, 'wall', 0x8e8e8a), y0: y });
  obstacles.push({ ...wallBox(`tw${f}-wall-s`, (x0 + x1) / 2, -10.15, x1 - x0 + 0.6, 0.3, wallH, 'wall', 0x8e8e8a), y0: y });
  obstacles.push({ ...wallBox(`tw${f}-wall-e`, x1 + 0.15, 1, 0.3, 22.6, wallH, 'wall', 0x8e8e8a), y0: y });
  // 서쪽 난간: 2F 는 경사로 도착 개구부(z ±2.2)를 비운다. 3F 는 서쪽 전체 난간.
  if (f === 2) {
    obstacles.push({ ...wallBox('tw2-wall-w1', x0 - 0.15, 6.5, 0.3, 8.6, wallH, 'wall', 0x8e8e8a), y0: y });
    obstacles.push({ ...wallBox('tw2-wall-w2', x0 - 0.15, -6.5, 0.3, 7.6, wallH, 'wall', 0x8e8e8a), y0: y });
  } else if (f === 3) obstacles.push({ ...wallBox('tw3-wall-w', x0 - 0.15, 1, 0.3, 22.6, wallH, 'wall', 0x8e8e8a), y0: y });
  else {
    // 1F: 진입 램프 쪽(서쪽)은 열려 있고, 램프 구간 밖 남북 외벽만 둔다 (아래 램프 측벽 참조)
  }
});

// ---- 직선 경사로 R1 측벽 (경사를 따라 올라가는 계단식 난간, 높이 1.3m) ----
{
  const n = 11;
  const seg = RAMP.length / n;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * seg;
    const y = RAMP.y0 + ((RAMP.y1 - RAMP.y0) * u) / RAMP.length;
    for (const side of [1, -1]) {
      obstacles.push({ ...wallBox(`ramp-wall-${side > 0 ? 'l' : 'r'}${i}`, RAMP.x + u, side * (RAMP.width / 2 + 0.15), seg + 0.02, 0.3, 1.5, 'wall', 0x9a9a96), y0: y - 0.25 });
    }
  }
}

// ---- 나선 램프 S1 난간 (경사를 따라 단계적으로 올라가는 벽 조각) ----
{
  const steps = 30;
  const dth = (SP.th1 - SP.th0) / steps;
  for (let i = 0; i < steps; i++) {
    const th = SP.th0 + (i + 0.5) * dth;
    const y = spiralY(th) - 0.25;
    for (const [tag, r, thick] of [['o', SP.r1 + 0.15, 0.3], ['i', SP.r0 - 0.15, 0.3]] as const) {
      const chord = 2 * r * Math.sin(dth / 2) + 0.05;
      obstacles.push({ ...wallBox(`spw-${tag}${i}`, SP.cx + r * Math.cos(th), SP.cz + r * Math.sin(th), thick, chord, 1.5, 'wall', 0x9a9a96, -th), y0: y });
    }
  }
}

// 통로 중앙 노란 점선 (1F)
for (let i = 0; i < 8; i++) paint.push({ x: -4 + i * 3.6, z: 0, w: 1.6, d: 0.12, color: 0xf2c200 });
for (const f of [2, 3]) for (let i = 0; i < 4; i++) levelPaint.push({ x: -4 + i * 3.6, z: 0, w: 1.6, d: 0.12, color: 0xf2c200, y: (f - 1) * FLOOR_H });
void WHITE;
void parkedCar;

export const MAP_TOWER: MapData = {
  id: 'tower',
  mechUnavailable: '지상층 전체를 데크/경사로가 덮어 시설을 놓을 지상 공간이 없다',
  name: '다층 주차타워 (검증용 임시 배치)',
  desc: '3층 구조: 직선 경사로로 2층, 나선형 램프로 3층(옥상)까지 올라가 주차합니다. ※ 층수·치수·배치는 사용자 확정 전의 임시 고정 레이아웃입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ab4cc, ambient: 0.55 },
  spawn: { x: -33, z: 0, heading: Math.PI / 2, y: 0 },
  terrain: TOWER_TERRAIN,
  levelPaint,
  provisional: true,
  surfaces: [{ x: -1, z: 1, w: 70, d: 24, kind: 'concrete' }],
  paint,
  obstacles,
  slots,
  missions: [
    { id: 'tw-1', name: '1층 후진 주차 (임시)', kind: 'perpendicular-reverse', slotId: 'tw1-n-3', desc: '1층 북쪽 줄 빈 칸에 후진 주차하세요. (층 이동 없음)', parTimeSec: 70, timeLimitSec: 360, spawn: { x: 12, z: 0, heading: Math.PI / 2, y: 0 } },
    { id: 'tw-2', name: '경사로 상승 → 2층 주차 (임시)', kind: 'perpendicular-front', slotId: 'tw2-s-4', desc: '입구에서 직선 경사로를 올라 2층 남쪽 줄 빈 칸에 전면 주차하세요.', parTimeSec: 110, timeLimitSec: 480 },
    { id: 'tw-3', name: '나선 램프 상승 → 3층 주차 (임시)', kind: 'perpendicular-reverse', slotId: 'tw3-n-4', desc: '2층에서 나선형 램프를 올라 3층(옥상) 북쪽 줄 빈 칸에 후진 주차하세요.', parTimeSec: 120, timeLimitSec: 480, spawn: { x: 14, z: 0, heading: Math.PI / 2, y: FLOOR_H } },
  ],
};
