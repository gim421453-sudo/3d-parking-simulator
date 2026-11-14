/**
 * 괴정동 실제 지도 (v0.6.0): 부산 사하구 괴정역 중심 1km × 1km — OpenStreetMap 데이터(ODbL, src/maps/data/LICENSE-OSM.md).
 *  - 도로/건물/주차장/녹지는 OSM 실제 데이터. OSM 에 건물이 없는 블록은 절차 생성 건물(gen)로 채웠다(실제 건물 아님).
 *  - 건물 충돌체: 바닥 다각형을 회전 상자 여러 개로 분해(world/footprint.ts, 1m 격자) — 외형은 geo 레이어가 다각형 그대로 그린다.
 *  - 내비: 실제 도로 중심선 그래프(roadNet, 일방통행 반영).
 *  - 고도(언덕)는 반영하지 않은 평면 지도, 주차칸 배치는 OSM 주차장 면 안에 자동 배치(임시).
 */
import data from './data/goejeong.json';
import { footprintBoxes, mainAxis, pointInPoly, type Pt } from '../world/footprint';
import { obbOverlap } from '../core/geometry';
import { parkedCar, perimeter, slotPaint } from './helpers';
import type { GeoLayer, MapData, MapSlot, ObstacleDef, PaintRect } from './types';
import { makeFacility, toWorldXZ, frameOf } from '../mech/facility';
import { PALLET_SLOT, facilityKit } from './mechKit';

const H = data.half;
const bounds = { minX: -H, maxX: H, minZ: -H, maxZ: H };

// ---------------------------------------------------------------- 건물
const PAL_REAL = [0xe6e0d4, 0xd9d4c8, 0xeae6dc, 0xcfc9bc, 0xe0d8c8];
const PAL_GEN = [0xc9b8a0, 0xb9a891, 0xd6c6ae, 0xa99b88, 0xc7c0b4, 0xb7aa9c, 0xd2c4b6];
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
type RawB = { id: string; pts: number[][]; h: number; name?: string; gen?: number; kind: string };
type RawR = { id: string; pts: number[][]; w: number; hw: string; name?: string; oneway: number };
type RawA = { id: string; kind: string; pts: number[][]; name?: string };
const rawB = data.buildings as RawB[];
const rawR = data.roads as RawR[];
const rawA = data.areas as RawA[];

/** 기계식 주차 시설: 괴정역 앞 낙동대로 남쪽 빈 터(scripts/find-geo-facility.ts 결과 — 실제/생성 건물·도로·면과 겹치지 않음). 위치는 임시 배치 */
export const GJ_FACILITY = makeFacility({ id: 'gj-mech', name: '괴정역 기계식 주차타워 (8층 · 임시 배치)', x: 26, z: 38, rotationY: -Math.PI / 2, floors: 8 });
const gjKit = facilityKit(GJ_FACILITY, { idPrefix: 'gj-mech:', pad: true });

const geoBuildings: GeoLayer['buildings'] = rawB.map((b) => ({
  id: b.id,
  pts: b.pts as [number, number][],
  h: b.h,
  name: b.name,
  gen: !!b.gen,
  color: (b.gen ? PAL_GEN : PAL_REAL)[hash(b.id) % (b.gen ? PAL_GEN.length : PAL_REAL.length)],
}));

const obstacles: ObstacleDef[] = [...perimeter(bounds, 0.6, 1.4, 0x8f8f8a), ...gjKit.obstacles];
for (const b of geoBuildings) {
  footprintBoxes(b.pts as Pt[], 1).forEach((q, k) => obstacles.push({ id: `bld-${b.id}-${k}`, tag: 'building', shape: 'box', x: q.x, z: q.z, w: q.w, d: q.d, rot: q.rot, h: b.h, hidden: true }));
}

// ---------------------------------------------------------------- 도로 도색 (중앙선/차선)
const YELLOW = 0xf2c200;
const WHITE = 0xf4f4f4;
const paint: PaintRect[] = [];
for (const r of rawR) {
  const twoWay = !r.oneway;
  const wide = r.w >= 10;
  for (let i = 1; i < r.pts.length; i++) {
    const [ax, az] = r.pts[i - 1];
    const [bx, bz] = r.pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1) continue;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    // 직사각형 rot 규칙: 로컬 z(길이) = (sin rot, cos rot) → rot = atan2(dx, dz)
    const rot = Math.atan2(dx, dz);
    const nx = dz; // 진행 방향 오른쪽(+x 동, +z 남 좌표계에서 (dz, −dx) 가 왼쪽이 아님에 유의 — 대칭으로 ± 둘 다 쓴다)
    const nz = -dx;
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (wide && twoWay) {
      // 황색 복선 중앙선
      for (const o of [-0.18, 0.18]) paint.push({ x: mx + nx * o, z: mz + nz * o, w: 0.15, d: len, rot, color: YELLOW });
      // 차선(백색 점선): 왕복 4차로 이상
      if (r.w >= 14)
        for (const o of [-r.w / 4, r.w / 4])
          for (let t = 1.5; t < len - 1.5; t += 9) paint.push({ x: ax + dx * (t + 1.5) + nx * o, z: az + dz * (t + 1.5) + nz * o, w: 0.15, d: 3, rot, color: WHITE });
    } else if (r.w >= 6 && twoWay && r.hw !== 'service') {
      // 이면도로: 황색 점선 중앙선
      for (let t = 1; t < len - 1; t += 6) paint.push({ x: ax + dx * (t + 1) + nx * 0, z: az + dz * (t + 1), w: 0.12, d: 2, rot, color: YELLOW });
    }
  }
}

// ---------------------------------------------------------------- 주차장: OSM 주차장 면 안에 칸 자동 배치
const slots: MapSlot[] = [];
const buildingBoxes = obstacles.filter((o) => o.tag === 'building');
const clearOf = (o: { x: number; z: number; rot: number; hw: number; hl: number }): boolean => !buildingBoxes.some((b) => obbOverlap(o, { x: b.x, z: b.z, rot: b.rot ?? 0, hw: (b.w ?? 1) / 2, hl: (b.d ?? 1) / 2 }));
const lots = rawA.filter((a) => a.kind === 'parking');
lots.forEach((lot, li) => {
  const poly = lot.pts as Pt[];
  const ang = mainAxis(poly); // u 축(월드 각도)
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const loc = poly.map(([x, z]) => [x * c + z * s, -x * s + z * c] as Pt);
  const us = loc.map((p) => p[0]);
  const vs = loc.map((p) => p[1]);
  const u0 = Math.min(...us);
  const u1 = Math.max(...us);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  const SW = 2.5;
  const SL = 5.0;
  const AISLE = 6.0;
  // 행: 칸(5m) – 통로(6m) – 칸(5m) 반복 (v 방향), 칸은 u 방향으로 나란히
  let row = 0;
  for (let v = v0 + 0.6; v + SL <= v1 - 0.3; v += row % 2 === 0 ? SL + 0.4 : SL + AISLE) {
    const facing = row % 2 === 0 ? 1 : -1; // 통로 쪽을 바라보게
    let k = 0;
    for (let u = u0 + 0.6; u + SW <= u1 - 0.3; u += SW) {
      const uc = u + SW / 2;
      const vc = v + SL / 2;
      const corners: Pt[] = [
        [uc - SW / 2, vc - SL / 2],
        [uc + SW / 2, vc - SL / 2],
        [uc + SW / 2, vc + SL / 2],
        [uc - SW / 2, vc + SL / 2],
      ];
      if (!corners.every(([pu, pv]) => pointInPoly(loc, pu, pv))) continue;
      const x = uc * c - vc * s;
      const z = uc * s + vc * c;
      // 칸 방향: 길이(l) 축 = v 축 = 월드 (−s, c). slot.dir 은 heading 규칙(앞 = (sin dir, cos dir)) → dir = atan2(−s, c) (+π 면 반대)
      const dir = Math.atan2(-s * facing, c * facing);
      if (!clearOf({ x, z, rot: dir, hw: SW / 2, hl: SL / 2 })) continue;
      // 겹치는 OSM 주차장 면(같은 주차장이 두 번 그려진 경우)에서 칸이 중복되지 않게
      if (slots.some((q) => obbOverlap({ x, z, rot: dir, hw: SW / 2 - 0.05, hl: SL / 2 - 0.05 }, { x: q.x, z: q.z, rot: q.dir, hw: q.w / 2 - 0.05, hl: q.l / 2 - 0.05 }))) continue;
      slots.push({ id: `gj-p${li}-${row}-${k}`, x, z, w: SW, l: SL, dir, style: 'u' });
      k++;
    }
    row++;
  }
});
// 일부 칸은 주차된 차량으로 (결정적): 3칸 중 2칸
const occupied = new Set<string>();
slots.forEach((sl, i) => {
  if (i % 3 !== 1) {
    occupied.add(sl.id);
    obstacles.push(parkedCar(`gj-car${i}`, sl.x, sl.z, sl.dir, i % 6));
  }
});
const freeSlots = slots.filter((s) => !occupied.has(s.id));

// ---------------------------------------------------------------- 시작 위치: 괴정역 앞 낙동대로(원점 부근), 진행 방향 오른쪽 차로
function roadStart(name: string, near: Pt): { x: number; z: number; heading: number } {
  let best = { d: Infinity, x: 0, z: 0, heading: 0 };
  for (const r of rawR.filter((q) => q.name === name)) {
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1];
      const [bx, bz] = r.pts[i];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = Math.max(0.2, Math.min(0.8, ((near[0] - ax) * dx + (near[1] - az) * dz) / l2));
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = Math.hypot(px - near[0], pz - near[1]);
      if (d < best.d) {
        const len = Math.sqrt(l2);
        // 한국은 우측 통행: 진행 방향 오른쪽. heading 규칙 앞 = (sin h, cos h), 로컬 +x = 왼쪽 → 오른쪽 = (−cos h, sin h)
        const h = Math.atan2(dx / len, dz / len);
        const off = r.w / 4;
        best = { d, x: px - Math.cos(h) * off, z: pz + Math.sin(h) * off, heading: h };
      }
    }
  }
  return best;
}
const start = roadStart('낙동대로', [0, 0]);
// 미션 목표: 사하도서관 주차장(남쪽)의 빈 칸 중 가장 서쪽
const libSlot = [...freeSlots].sort((a, b) => a.x - b.x)[0];

const fr = frameOf(GJ_FACILITY);
const palletC = toWorldXZ(fr, PALLET_SLOT.x, PALLET_SLOT.z);
const pallet: MapSlot = { ...PALLET_SLOT, id: 'gj-mech:pallet', x: palletC.x, z: palletC.z, dir: PALLET_SLOT.dir + GJ_FACILITY.rotationY };
const mechSpawn = toWorldXZ(fr, -31, 0); // 낙동대로 위, 시설 진입로를 바라봄
export const GJ_GEO: GeoLayer = {
  buildings: geoBuildings,
  roads: rawR.map((r) => ({ id: r.id, pts: r.pts as [number, number][], w: r.w, hw: r.hw, name: r.name, oneway: !!r.oneway })),
  areas: rawA.map((a) => ({ id: a.id, kind: a.kind as GeoLayer['areas'][number]['kind'], pts: a.pts as [number, number][], name: a.name })),
  attribution: '© OpenStreetMap contributors (ODbL)',
};

export const MAP_GOEJEONG: MapData = {
  id: 'goejeong',
  name: '괴정동 실제 지도 (부산 사하구 · 1km)',
  desc: '괴정역 중심 1km×1km 실제 도로망·건물(OpenStreetMap). 회색 톤 건물 일부는 OSM 미등록 블록을 채운 생성 건물. 평면(고도 미반영). © OpenStreetMap contributors (ODbL)',
  bounds,
  env: { indoor: false, sky: 0x9ec9ee, ambient: 0.55 },
  spawn: { x: start.x, z: start.z, heading: start.heading },
  surfaces: [{ x: 0, z: 0, w: 2 * H, d: 2 * H, kind: 'concrete' }, ...gjKit.surfaces],
  paint: [...paint, ...slots.flatMap((s) => slotPaint(s)), ...gjKit.paint],
  mech: true,
  mechFacilities: [GJ_FACILITY],
  obstacles,
  slots: [...slots, pallet],
  geo: GJ_GEO,
  roadNet: data.roadNet as MapData['roadNet'],
  missions: libSlot
    ? [
        {
          id: 'gj-library',
          name: '괴정역 → 사하도서관 주차장',
          kind: 'perpendicular-front',
          slotId: libSlot.id,
          desc: '괴정역 앞 낙동대로에서 출발해 내비 안내(실제 도로망)를 따라 사하도서관 주차장의 빈 칸에 전면 주차하세요.',
          parTimeSec: 240,
          timeLimitSec: 900,
        },
        {
          id: 'gj-mech-in',
          name: '괴정역 기계식 주차타워 입고',
          kind: 'mech-in',
          slotId: pallet.id,
          desc: '낙동대로에서 남쪽 기계식 주차타워로 들어가 팔레트에 정렬 → P·주차브레이크·시동 OFF·하차(G)·입고(J). 3F A 슬롯.',
          parTimeSec: 150,
          timeLimitSec: 600,
          spawn: { x: mechSpawn.x, z: mechSpawn.z, heading: GJ_FACILITY.rotationY + Math.PI / 2 },
          mech: { slot: '03A', mode: 'fwd', facility: GJ_FACILITY.id },
        },
      ]
    : [],
};
