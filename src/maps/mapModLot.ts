import { cone, parkedCar, perimeter, pillar, wallBox } from './helpers';
import { addRampWalls, addRow, addSlot, addWall, newKit } from './levelKit';
import type { RampSurface, Terrain } from './terrain';
import type { MapData, MapSlot, ObstacleDef } from './types';

/**
 * 모듈형 연습 주차장 + 경사 데크 (v0.4.9, **임시 고정 레이아웃**). 직접 제작한 절차적 지형/충돌/미션 — 외부 GLB 미사용(경량).
 * 한 맵에서 직각(8칸)·평행(4칸)·45° 사선(5칸) 주차, 기둥 사이 통과(폭 2.9m), 좁은 통로(폭 3.0m), 곡선 진입로(콘),
 * 12.5% 경사로로 오르는 1.5m 높이의 데크(주차 4칸)를 연습한다.
 */
const bounds = { minX: -35, maxX: 34, minZ: -24, maxZ: 24 };
const PODIUM_Y = 1.5;
const PODIUM = { x0: 18, x1: 30, z0: -18, z1: -6 };
const RAMP: RampSurface = { kind: 'ramp', id: 'ml-ramp', x: 6, z: -12, rot: Math.PI / 2, length: 12, width: 3.8, y0: 0, y1: PODIUM_Y };

export const ML_TERRAIN: Terrain = {
  levels: [
    { id: 'GL', name: '지상', y: 0 },
    { id: 'DK', name: '데크', y: PODIUM_Y },
  ],
  surfaces: [
    { kind: 'deck', id: 'ml-ground', rect: { x: 0, z: 0, w: 76, d: 52 }, y: 0 },
    { kind: 'deck', id: 'ml-podium', rect: { x: (PODIUM.x0 + PODIUM.x1) / 2, z: (PODIUM.z0 + PODIUM.z1) / 2, w: PODIUM.x1 - PODIUM.x0, d: PODIUM.z1 - PODIUM.z0 }, y: PODIUM_Y, thickness: 0.2 },
    RAMP,
  ],
};

const k = newKit();
const extra: ObstacleDef[] = [];

// ① 직각 줄 (북쪽, 8칸)
addRow(k, 0, { prefix: 'mn', startX: -22, z: 17.5, count: 8, pitch: 2.7, w: 2.7, l: 5.4, dir: 0, empty: [2, 5] });
extra.push(wallBox('mn-back', -12.5, 21.0, 22.5, 0.6, 1.4, 'wall', 0x9c9c98));
for (const px of [-23.35, -17.95, -12.55, -7.15]) extra.push(pillar(`mn-pil${px}`, px, 15.2, 0.4, 3));

// ② 평행주차 줄 (남쪽 가장자리, 4칸: 차량 진행 방향 = 동쪽)
addRow(k, 0, { prefix: 'mp', startX: -24, z: -19.2, count: 4, pitch: 6.6, w: 2.6, l: 6.4, dir: Math.PI / 2, style: 'box', empty: [1, 3] });
extra.push({ id: 'mp-curb', tag: 'curb', shape: 'box', x: -14, z: -20.9, w: 27, d: 0.4, h: 0.15, color: 0xb0b0aa });
extra.push(wallBox('mp-back', -14, -22.0, 27.4, 0.6, 1.1, 'wall', 0x8c8c88));

// ③ 45° 사선 줄 (동쪽, 5칸)
const ang: MapSlot[] = [];
for (let i = 0; i < 5; i++) ang.push({ id: `ma-${i}`, x: 20.5, z: -2 + 3.82 * i, w: 2.7, l: 5.6, dir: Math.PI / 4, style: 'u' });
ang.forEach((s, i) => addSlot(k, 0, s, [1, 3].includes(i) ? undefined : parkedCar(`ma-car${i}`, s.x, s.z, s.dir, i + 2)));
extra.push(wallBox('ma-back', 27.4, 7.0, 0.6, 24, 1.2, 'wall', 0x9c9c98));

// ④ 기둥 사이 통과 (폭 2.9m 게이트 3개) + ⑤ 좁은 통로 (폭 3.0m, 길이 8m)
for (const gz of [-7.5, -3.6]) {
  extra.push(pillar(`gate-a${gz}`, -6, gz - 1.7, 0.5, 3));
  extra.push(pillar(`gate-b${gz}`, -6, gz + 1.7, 0.5, 3));
}
extra.push(pillar('gate-c', -6, 0.3, 0.5, 3), pillar('gate-d', -6, 3.7, 0.5, 3));
extra.push(wallBox('narrow-n', 4, 6.9, 8, 0.4, 1.2, 'wall', 0xb0b0aa), wallBox('narrow-s', 4, 3.9, 8, 0.4, 1.2, 'wall', 0xb0b0aa));

// ⑥ 곡선 진입로 (콘 두 줄, 폭 약 4.4m 의 S 커브)
for (let i = 0; i < 12; i++) {
  const x = -29 + i * 1.7;
  const zc = -11 + 2.4 * Math.sin((x + 29) / 3.2);
  extra.push(cone(`curve-a${i}`, x, zc + 2.2), cone(`curve-b${i}`, x, zc - 2.2));
}

// ⑦ 경사 데크: 지반 고정 블록(아래로 못 들어가게) + 가장자리 난간 + 경사로 측벽 + 주차 4칸
extra.push({ ...wallBox('pod-block', (PODIUM.x0 + PODIUM.x1) / 2, (PODIUM.z0 + PODIUM.z1) / 2, PODIUM.x1 - PODIUM.x0, PODIUM.z1 - PODIUM.z0, 1.15, 'wall', 0x8a8a86) });
addRampWalls(k, RAMP, 6);
const pw = PODIUM;
addWall(k, PODIUM_Y, 'pod-n', (pw.x0 + pw.x1) / 2, pw.z1 + 0.15, pw.x1 - pw.x0 + 0.6, 0.3, 1.1);
addWall(k, PODIUM_Y, 'pod-s', (pw.x0 + pw.x1) / 2, pw.z0 - 0.15, pw.x1 - pw.x0 + 0.6, 0.3, 1.1);
addWall(k, PODIUM_Y, 'pod-e', pw.x1 + 0.15, (pw.z0 + pw.z1) / 2, 0.3, pw.z1 - pw.z0, 1.1);
addWall(k, PODIUM_Y, 'pod-w1', pw.x0 - 0.15, (pw.z0 - 0.15 + -13.9) / 2, 0.3, -13.9 - pw.z0 + 0.15, 1.1);
addWall(k, PODIUM_Y, 'pod-w2', pw.x0 - 0.15, (-10.1 + pw.z1 + 0.15) / 2, 0.3, pw.z1 + 0.15 + 10.1, 1.1);
addRow(k, PODIUM_Y, { prefix: 'mk', startX: 0, z: 0, count: 0, pitch: 1, w: 1, l: 1, dir: 0, empty: [] });
for (let i = 0; i < 4; i++) {
  const s: MapSlot = { id: `mk-${i}`, x: 27.0, z: -16.4 + 2.8 * i, w: 2.8, l: 5.4, dir: Math.PI / 2, style: 'u' };
  addSlot(k, PODIUM_Y, s, [1, 3].includes(i) ? undefined : parkedCar(`mk-car${i}`, s.x, s.z, s.dir, i + 1));
}

export const MAP_MODLOT: MapData = {
  id: 'modlot',
  mechUnavailable: '정밀 연습장: 시설을 놓으면 미션 동선과 겹친다',
  name: '모듈형 연습 주차장 + 경사 데크 (임시 배치)',
  desc: '직각·평행·45° 사선 주차, 기둥 사이 통과, 좁은 통로, 곡선 진입로, 12.5% 경사로로 오르는 데크 주차까지 한 곳에서 연습. 차체가 큰 차량일수록 기둥 게이트/좁은 통로가 어렵습니다. ※ 직접 제작한 절차적 지형이며 배치는 임시안입니다.',
  bounds,
  env: { indoor: false, sky: 0x9ec9ee, ambient: 0.55 },
  spawn: { x: -30.5, z: -11, heading: Math.PI / 2, y: 0 },
  terrain: ML_TERRAIN,
  levelPaint: k.levelPaint,
  provisional: true,
  surfaces: [{ x: 0, z: 0, w: 70, d: 46, kind: 'asphalt' }],
  paint: k.paint,
  obstacles: [...perimeter(bounds, 0.6, 1.2, 0x8f8f8a), ...k.obstacles, ...extra],
  slots: k.slots,
  missions: [
    { id: 'ml-1', name: '전면 직각주차', kind: 'perpendicular-front', slotId: 'mn-2', desc: '북쪽 줄의 빈 칸(왼쪽)에 앞으로 들어가 주차하세요. 기둥 사이를 조심하세요.', parTimeSec: 60, timeLimitSec: 300, spawn: { x: -4, z: 8, heading: 0 } },
    { id: 'ml-2', name: '후진 직각주차', kind: 'perpendicular-reverse', slotId: 'mn-5', desc: '북쪽 줄의 빈 칸(오른쪽)에 후진으로 들어가 주차하세요.', parTimeSec: 60, timeLimitSec: 300, spawn: { x: -4, z: 8, heading: 0 } },
    { id: 'ml-3', name: '평행주차', kind: 'parallel', slotId: 'mp-1', desc: '남쪽 도로변 두 차량 사이 공간에 평행주차하세요.', parTimeSec: 80, timeLimitSec: 360, spawn: { x: -2, z: -14.2, heading: Math.PI / 2 } },
    { id: 'ml-4', name: '45° 사선 주차', kind: 'perpendicular-front', slotId: 'ma-1', desc: '동쪽 사선 줄의 빈 칸에 45° 각도로 앞으로 들어가 주차하세요.', parTimeSec: 70, timeLimitSec: 300, spawn: { x: 13.5, z: 1.5, heading: Math.PI / 2 } },
    { id: 'ml-5', name: '경사로 → 데크 전면 주차', kind: 'perpendicular-front', slotId: 'mk-1', desc: '12.5% 경사로를 올라 데크 동쪽 줄의 빈 칸에 전면 주차하세요.', parTimeSec: 90, timeLimitSec: 420, spawn: { x: -1, z: -12, heading: Math.PI / 2, y: 0 } },
  ],
};
