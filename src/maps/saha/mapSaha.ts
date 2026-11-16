/**
 * v0.6.2 부산 사하구 전체 실제 지도 — MapData 구성(순수 로직).
 *  - 메뉴에는 자리표시(SAHA_STUB, stream.ready=false)가 보이고, 시작할 때 Game 이 데이터를 받아 buildSahaMap 결과로 바꾼다.
 *  - 지면 = 실제 지형 높이장(terrain.field) + 교량/터널 상판(ramp). 기준고 y=0 = 괴정역 기계식 시설 자리(해수면 = manifest.seaLevelY).
 *  - 건물 충돌체/외형·도로·차선은 타일 스트리밍(world/sahaStream.ts)이 붙였다 뗀다 — 이 MapData 의 obstacles 에는 시설 키트만.
 *  - 미션 주차칸은 OSM 주차장 면 안에 자동 배치(임시 — 실제 칸 배치 아님).
 */
import { footprintBoxes, mainAxis, pointInPoly, type Pt } from '../../world/footprint';
import { obbOverlap } from '../../core/geometry';
import { fieldHeight } from '../terrain';
import { makeFacility, toWorldXZ, frameOf } from '../../mech/facility';
import { PALLET_SLOT, facilityKit } from '../mechKit';
import type { MapData, MapMission, MapSlot } from '../types';
import { deckSurfaces, tileKeyOf, type SahaBase, type SahaLot, type SahaTile } from './data';

export const SAHA_ATTRIBUTION = '© OpenStreetMap contributors (ODbL) · 지형 Copernicus DEM GLO-30 (추정 지표면)';
const DESC =
  '부산광역시 사하구 법정동 8개 전역(41.4km²) — 실제 도로망·건물(OpenStreetMap)·지형 고도(Copernicus DEM). 차로 수는 OSM 태그가 있는 구간만 실제이고 나머지는 도로 등급으로 추정, 건물 높이는 층수 태그가 없으면 추정. OSM 에 건물이 없는 블록의 회청색 무늬 없는 건물은 생성 건물(실제 아님 — 설정에서 끌 수 있음). ' +
  SAHA_ATTRIBUTION;

/** 미션 주차장(OSM 면 id) — 중심 좌표는 타일을 미리 받기 위한 값(build 결과) */
export const SAHA_LOTS = {
  hadan: { id: 'w552582893', x: -2517, z: -488, name: '하단 공영주차장' },
  dadae: { id: 'w471357925', x: -1988, z: 6103, name: '다대포 인근 공영주차장' },
} as const;

const MISSIONS: MapMission[] = [
  { id: 'saha-hadan', name: '괴정역 → 하단 공영주차장', kind: 'perpendicular-front', slotId: 'saha-hadan-p', desc: '괴정역 앞 낙동대로에서 출발해 실제 도로망 내비를 따라 하단 공영주차장(OSM)의 빈 칸에 전면 주차하세요. 주차칸 배치는 임시.', parTimeSec: 420, timeLimitSec: 1500 },
  { id: 'saha-dadae', name: '괴정역 → 다대포 공영주차장 (약 7km)', kind: 'perpendicular-front', slotId: 'saha-dadae-p', desc: '사하구를 남북으로 가로질러 다대포 인근 공영주차장(OSM 이름 "공영주차장")까지. 언덕길·교차로·일방통행이 실제 데이터대로입니다. 주차칸 배치는 임시.', parTimeSec: 900, timeLimitSec: 2700 },
  { id: 'saha-mech-in', name: '괴정역 기계식 주차타워 입고', kind: 'mech-in', slotId: 'saha-mech:pallet', desc: '괴정역 남쪽 기계식 주차타워(임시 배치)로 들어가 팔레트에 정렬 → P·주차브레이크·시동 OFF·하차(G)·입고(J). 3F A 슬롯.', parTimeSec: 150, timeLimitSec: 600, mech: { slot: '03A', mode: 'fwd', facility: 'saha-mech' } },
];

/** 기계식 시설 자리(build 결과 manifest.facility — 메뉴/검사용 자리표시에도 같은 값. tests/saha.test.ts 가 일치 확인) */
export const SAHA_FACILITY_XZ = { x: 27, z: 37.8 } as const;
const facilityAt = (x: number, z: number) => makeFacility({ id: 'saha-mech', name: '괴정역 기계식 주차타워 (8층 · 임시 배치)', x, z, rotationY: -Math.PI / 2, floors: 8 });

const STUB_KIT = facilityKit(facilityAt(SAHA_FACILITY_XZ.x, SAHA_FACILITY_XZ.z), { idPrefix: 'saha-mech:', pad: true });
export const SAHA_STUB: MapData = {
  id: 'saha',
  name: '부산 사하구 전체 (실제 지도 · 41km²)',
  desc: DESC,
  bounds: { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 12000 },
  env: { indoor: false, sky: 0x9ec9ee, ambient: 0.55 },
  spawn: { x: 0, z: 0, heading: 0 },
  surfaces: [...STUB_KIT.surfaces],
  paint: [...STUB_KIT.paint],
  obstacles: [...STUB_KIT.obstacles],
  slots: [],
  missions: MISSIONS,
  mech: true,
  mechFacilities: [facilityAt(SAHA_FACILITY_XZ.x, SAHA_FACILITY_XZ.z)],
  stream: { kind: 'saha', ready: false },
};

/** 시작 시점에 미리 받아야 할 타일(출발지·미션 주차장·기계식 시설 주변) */
export function sahaInitialTiles(base: SahaBase): string[] {
  const m = base.manifest;
  const keys = new Set<string>();
  const add = (x: number, z: number, r: number): void => {
    for (let dx = -r; dx <= r; dx += m.tileSize) for (let dz = -r; dz <= r; dz += m.tileSize) keys.add(tileKeyOf(m, x + dx, z + dz));
  };
  add(0, 0, 240);
  add(m.facility.x, m.facility.z, 240);
  for (const l of Object.values(SAHA_LOTS)) add(l.x, l.z, 240);
  return [...keys].filter((k) => m.tiles.includes(k));
}

/** 시작 위치: 원점(괴정역) 가까운 낙동대로 위, 진행 방향 오른쪽 바깥 차로 */
function roadStart(tiles: SahaTile[], name: string, near: [number, number]): { x: number; z: number; heading: number } | null {
  let best: { d: number; x: number; z: number; heading: number } | null = null;
  for (const t of tiles)
    for (const r of t.roads) {
      if (r.n !== name) continue;
      for (let i = 1; i < r.p.length; i++) {
        const [ax, az] = r.p[i - 1];
        const [bx, bz] = r.p[i];
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 4) continue;
        const t2 = Math.max(0.2, Math.min(0.8, ((near[0] - ax) * dx + (near[1] - az) * dz) / l2));
        const px = ax + dx * t2;
        const pz = az + dz * t2;
        const d = Math.hypot(px - near[0], pz - near[1]);
        if (best && d >= best.d) continue;
        const len = Math.sqrt(l2);
        // 우측 통행: 진행 방향 오른쪽 = (−cos h, sin h). 정방향 차로 수가 n 이면 바깥 차로 중심은 (n − 0.5)·3.2m
        const h = Math.atan2(dx / len, dz / len);
        const n = Math.max(1, r.l[1]);
        const off = r.o ? (n - 1) * 1.6 + 0 : Math.min(r.w / 2 - 1.8, (n - 0.5) * 3.2);
        best = { d, x: px - Math.cos(h) * off, z: pz + Math.sin(h) * off, heading: h };
      }
    }
  return best;
}

/** OSM 주차장 면 안에 주차칸(2.5×5.0m)을 자동 배치 — goejeong 과 같은 방식, 건물·경사 큰 곳 제외 */
function lotSlots(base: SahaBase, lot: SahaLot, prefix: string, buildings: { x: number; z: number; w: number; d: number; rot: number }[]): MapSlot[] {
  const poly = lot.p as Pt[];
  const ang = mainAxis(poly);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const loc = poly.map(([x, z]) => [x * c + z * s, -x * s + z * c] as Pt);
  const us = loc.map((p) => p[0]);
  const vs = loc.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const SW = 2.5;
  const SL = 5.0;
  const AISLE = 6.0;
  const out: MapSlot[] = [];
  let row = 0;
  for (let v = v0 + 0.6; v + SL <= v1 - 0.3; v += row % 2 === 0 ? SL + 0.4 : SL + AISLE) {
    const facing = row % 2 === 0 ? 1 : -1;
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
      const dir = Math.atan2(-s * facing, c * facing);
      if (buildings.some((b) => obbOverlap({ x, z, rot: dir, hw: SW / 2, hl: SL / 2 }, { x: b.x, z: b.z, rot: b.rot, hw: b.w / 2, hl: b.d / 2 }))) continue;
      // 칸 안 지면 경사 6% 이하만(경사진 면에 칸을 그리지 않는다)
      const ys = corners.map(([pu, pv]) => fieldHeight(base.field, pu * c - pv * s, pu * s + pv * c) ?? 0);
      if (Math.max(...ys) - Math.min(...ys) > 0.06 * SL) continue;
      const y = fieldHeight(base.field, x, z) ?? lot.y;
      out.push({ id: `${prefix}-${row}-${k}`, x, z, w: SW, l: SL, dir, style: 'u', y: Math.round(y * 100) / 100 });
      k++;
    }
    row++;
  }
  return out;
}

export function buildSahaMap(base: SahaBase, tiles: Map<string, SahaTile>): MapData {
  const m = base.manifest;
  const tl = [...tiles.values()];
  // 기계식 시설: 기존 괴정동 맵과 같은 자리(좌표계 변환). 지형은 build 단계에서 이 자리 반경 45m 를 y=0 으로 평탄화했다
  const F = facilityAt(m.facility.x, m.facility.z);
  const kit = facilityKit(F, { idPrefix: 'saha-mech:', pad: true });
  const fr = frameOf(F);
  const palletC = toWorldXZ(fr, PALLET_SLOT.x, PALLET_SLOT.z);
  const pallet: MapSlot = { ...PALLET_SLOT, id: 'saha-mech:pallet', x: palletC.x, z: palletC.z, dir: PALLET_SLOT.dir + F.rotationY };
  const mechSpawn = toWorldXZ(fr, -31, 0);

  const bboxOf = (ts: SahaTile[]) => ts.flatMap((t) => t.buildings.flatMap((b) => footprintBoxes(b.o as Pt[], 1)));
  const slots: MapSlot[] = [pallet];
  const lotSlotsFor = (key: keyof typeof SAHA_LOTS, prefix: string): MapSlot[] => {
    const L = SAHA_LOTS[key];
    const lot = tl.flatMap((t) => t.lots).find((l) => l.id === L.id);
    if (!lot) return [];
    const near = tl.filter((t) => t.lots.some((l) => l.id === L.id) || t.buildings.some((b) => Math.hypot(b.o[0][0] - L.x, b.o[0][1] - L.z) < 200));
    return lotSlots(base, lot, prefix, bboxOf(near));
  };
  const hadan = lotSlotsFor('hadan', 'saha-hadan');
  const dadae = lotSlotsFor('dadae', 'saha-dadae');
  slots.push(...hadan, ...dadae);
  const target = (list: MapSlot[], id: string): MapSlot | null => {
    const s = [...list].sort((a, b) => a.x - b.x)[0];
    if (!s) return null;
    const t = { ...s, id };
    slots.push(t);
    return t;
  };
  const hadanT = target(hadan.slice(1), 'saha-hadan-p');
  const dadaeT = target(dadae.slice(1), 'saha-dadae-p');
  // 목표 칸과 겹치는 원래 칸은 뺀다(같은 자리에 칸 두 개 금지)
  for (const t of [hadanT, dadaeT]) {
    if (!t) continue;
    const i = slots.findIndex((s) => s !== t && s.x === t.x && s.z === t.z);
    if (i >= 0) slots.splice(i, 1);
  }

  const st = roadStart(tl, '낙동대로', [0, 0]) ?? { x: 0, z: 0, heading: 0 };
  const yAt = (x: number, z: number): number => fieldHeight(base.field, x, z) ?? 0;
  const f = m.field;
  return {
    id: 'saha',
    name: SAHA_STUB.name,
    desc: DESC,
    bounds: { minX: f.x0 + 10, maxX: f.x0 + (f.w - 1) * f.cell - 10, minZ: f.z0 + 10, maxZ: f.z0 + (f.h - 1) * f.cell - 10 },
    env: { indoor: false, sky: 0x9ec9ee, ambient: 0.55 },
    spawn: { x: st.x, z: st.z, heading: st.heading, y: yAt(st.x, st.z) },
    terrain: { field: base.field, surfaces: deckSurfaces(m), levels: [{ id: 'g', name: '지상', y: 0 }] },
    surfaces: [...kit.surfaces],
    paint: [...kit.paint],
    mech: true,
    mechFacilities: [F],
    obstacles: [...kit.obstacles],
    slots,
    roadNet: { nodes: base.roadNet.nodes.map(([x, z]) => [x, z] as [number, number]), edges: base.roadNet.edges, restrictions: base.roadNet.restrictions },
    missions: MISSIONS.filter((q) => q.kind === 'mech-in' || slots.some((s) => s.id === q.slotId)).map((q) => (q.kind === 'mech-in' ? { ...q, spawn: { x: mechSpawn.x, z: mechSpawn.z, heading: F.rotationY + Math.PI / 2, y: 0 } } : q)),
    stream: { kind: 'saha', ready: true },
    outline: m.boundary.flatMap((d) => d.outer),
    attribution: SAHA_ATTRIBUTION,
  };
}
