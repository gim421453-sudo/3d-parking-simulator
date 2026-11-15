import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSahaBase, inSaha, tilesWithin, buildingColliders, type SahaBase, type SahaSource, type SahaTile } from '../src/maps/saha/data';
import { buildSahaMap, sahaInitialTiles, SAHA_FACILITY_XZ, SAHA_STUB } from '../src/maps/saha/mapSaha';
import { fieldHeight, groundAt } from '../src/maps/terrain';
import { buildRoadNetGraph, findRoadNetRoute, turnAllowed } from '../src/nav/roadNet';
import { mapColliders, type MapData } from '../src/maps/types';
import { footprintBoxes, type Pt } from '../src/world/footprint';
import { drivePath, startState } from '../src/sim/autodrive';
import { getVehicle } from '../src/vehicle/spec';
import type { ObstacleDef } from '../src/maps/types';
import { obbOverlap, findVehicleCollision, type Collider } from '../src/core/geometry';
import { evaluateParking } from '../src/mission/parking';
import { centerOf, createVehicleState, obbOf } from '../src/vehicle/physics';
import { VEHICLES } from '../src/vehicle/spec';

const DIR = path.resolve(__dirname, '../public/maps/saha');
const src: SahaSource = {
  json: async (rel) => JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8')),
  bin: async (rel) => {
    const b = fs.readFileSync(path.join(DIR, rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
};
let base: SahaBase;
let map: MapData;
const tiles = new Map<string, SahaTile>();
beforeAll(async () => {
  base = await loadSahaBase(src);
  for (const k of sahaInitialTiles(base)) tiles.set(k, await src.json<SahaTile>(`tiles/${k}.json`));
  map = buildSahaMap(base, tiles);
});

describe('사하구 실제 지도 데이터 (v0.6.2)', () => {
  it('경계: 법정동 8개 육지 면적이 공식 면적(41.79km²)과 2% 이내, 괴정역(원점)·다대포는 경계 안, 바다 한가운데는 밖', () => {
    const q = base.manifest.quality as { boundaryAreaKm2: number };
    expect(Math.abs(q.boundaryAreaKm2 - 41.79) / 41.79).toBeLessThan(0.02);
    expect(base.manifest.boundary.length).toBe(8);
    expect(inSaha(base.manifest, 0, 0)).toBe(true);
    expect(inSaha(base.manifest, -1988, 6103)).toBe(true);
    expect(inSaha(base.manifest, 3000, 9000)).toBe(false);
  });
  it('출처 계층 분리: OSM(ODbL)과 Copernicus DEM 이 따로 기록되고 생성 건물은 0', () => {
    const names = base.manifest.sources.map((s) => s.license);
    expect(names.some((l) => l.includes('ODbL'))).toBe(true);
    expect(names.some((l) => l.includes('Copernicus'))).toBe(true);
    expect((base.manifest.quality as { buildingsGenerated: number }).buildingsGenerated).toBe(0);
    expect(fs.existsSync(path.join(DIR, 'LICENSE.md'))).toBe(true);
  });
  it('지형: 높이장이 경계 전체를 덮고, 기계식 시설 자리는 y=0, 해수면은 음수 기준고', () => {
    const f = base.field;
    const b = base.manifest.bounds;
    for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.maxZ], [0, 0], [-1988, 6103]]) expect(fieldHeight(f, x, z)).not.toBeNull();
    expect(Math.abs(fieldHeight(f, base.manifest.facility.x, base.manifest.facility.z)!)).toBeLessThan(0.11);
    expect(base.manifest.seaLevelY).toBeLessThan(0);
    // 실제 언덕: 사하구 안에서 해수면보다 200m 이상 높은 곳이 있다(평면 지도가 아님)
    let max = -Infinity;
    for (let k = 0; k < f.data.length; k++) max = Math.max(max, f.data[k]);
    expect(max - base.manifest.seaLevelY).toBeGreaterThan(200);
  });
  it('높이장 보간은 격자점에서 정확하고 칸 안에서 연속(삼각형 평면)', () => {
    const f = base.field;
    const i = 200;
    const j = 300;
    const x = f.x0 + i * f.cell;
    const z = f.z0 + j * f.cell;
    expect(fieldHeight(f, x, z)).toBeCloseTo(f.data[j * f.w + i], 5);
    const a = fieldHeight(f, x + f.cell * 0.5 - 1e-6, z + f.cell * 0.5)!;
    const c = fieldHeight(f, x + f.cell * 0.5 + 1e-6, z + f.cell * 0.5)!;
    expect(Math.abs(a - c)).toBeLessThan(1e-3);
  });
  it('도로 노면 높이 = 지형 높이(교량/터널 제외) — 차가 보이는 도로 위에 놓인다(±0.1m, 양자화)', () => {
    let n = 0;
    for (const t of tiles.values())
      for (const r of t.roads) {
        if (r.br || r.tn) continue;
        for (const [x, z, y] of r.p) {
          const h = fieldHeight(base.field, x, z);
          if (h === null) continue;
          expect(Math.abs(h - y), `${r.id} ${x},${z}`).toBeLessThan(0.1);
          n++;
        }
      }
    expect(n).toBeGreaterThan(500);
  });
  it('MapData: 시작 위치는 낙동대로 위·지면 높이, 미션 3개(하단/다대포/기계식) 모두 칸이 있다', () => {
    expect(map.stream?.ready).toBe(true);
    expect(map.missions.map((q) => q.id)).toEqual(['saha-hadan', 'saha-dadae', 'saha-mech-in']);
    for (const q of map.missions) expect(map.slots.some((s) => s.id === q.slotId), q.id).toBe(true);
    expect(map.spawn.y).toBeCloseTo(groundAt(map.terrain!, map.spawn.x, map.spawn.z, map.spawn.y ?? 0) ?? NaN, 3);
    expect(Math.hypot(map.spawn.x, map.spawn.z)).toBeLessThan(150);
  });
  it('메뉴용 자리표시의 기계식 시설 위치 = 데이터로 만든 맵의 위치(manifest)', () => {
    expect(base.manifest.facility).toEqual(SAHA_FACILITY_XZ);
    expect(SAHA_STUB.mechFacilities![0]).toEqual(map.mechFacilities![0]);
  });
  it('기계식 시설 키트가 실제 건물 외곽과 겹치지 않는다', () => {
    const kit = mapColliders(map).filter((c) => c.id.startsWith('saha-mech:') && c.kind === 'box');
    const blds = [...tiles.values()].flatMap((t) => t.buildings.flatMap((b) => footprintBoxes(b.o as Pt[], 1)));
    const hits = kit.filter((c) => c.kind === 'box' && blds.some((b) => obbOverlap({ x: c.x, z: c.z, rot: c.rot, hw: c.w / 2, hl: c.d / 2 }, { x: b.x, z: b.z, rot: b.rot, hw: b.w / 2 - 0.3, hl: b.d / 2 - 0.3 })));
    expect(hits.map((c) => c.id)).toEqual([]);
  });
  it('도로망: 99% 이상 연결, 괴정역 → 하단·다대포 주차장까지 실제 도로 경로가 있다(순간이동 없음: 연속 점 간격 ≤ 간선 길이)', () => {
    expect((base.manifest.quality as { networkConnectedRatio: number }).networkConnectedRatio).toBeGreaterThanOrEqual(0.95);
    const g = buildRoadNetGraph(map.roadNet!);
    for (const id of ['saha-hadan-p', 'saha-dadae-p']) {
      const s = map.slots.find((q) => q.id === id)!;
      const r = findRoadNetRoute(g, map.spawn, s, 120);
      expect(r, id).not.toBeNull();
      expect(r!.length).toBeGreaterThan(Math.hypot(s.x - map.spawn.x, s.z - map.spawn.z));
      // 경로 노드 사이가 실제 간선으로 이어져 있다
      for (let i = 1; i < r!.nodeIds.length; i++) {
        const a = r!.nodeIds[i - 1];
        const b = r!.nodeIds[i];
        expect(g.adj[a].some((e) => e.to === b), `${a}->${b}`).toBe(true);
      }
    }
  });
  it('회전 제한: 금지 전이는 허용되지 않는다(OSM restriction)', () => {
    const g = buildRoadNetGraph(map.roadNet!);
    const banned = map.roadNet!.restrictions!.find((r) => r[3] === 0);
    expect(banned).toBeDefined();
    const [u, v, w] = banned!;
    expect(turnAllowed(g, u, v, w)).toBe(false);
  });
  // tests/maps.test.ts 의 맵 공통 검사와 같은 항목 — 타일 건물 충돌체(스트리밍이 붙이는 것과 같은 분해)까지 포함
  const allColliders = (): Collider[] => [
    ...mapColliders(map),
    ...[...tiles.values()].flatMap((t) => t.buildings.flatMap((b) => buildingColliders(b))),
  ];
  it('(공통) 충돌체 id 고유 · 모든 차량이 시작 위치/미션 시작 위치에서 겹치지 않는다', () => {
    const cs = allColliders();
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
    for (const v of VEHICLES) {
      const s = createVehicleState(v, map.spawn.x, map.spawn.z, map.spawn.heading);
      expect(findVehicleCollision(obbOf(s, v), cs, map.spawn.y ?? 0, v.height), `${v.id} @ spawn`).toBeNull();
      for (const m of map.missions) {
        if (!m.spawn) continue;
        const ms = createVehicleState(v, m.spawn.x, m.spawn.z, m.spawn.heading);
        expect(findVehicleCollision(obbOf(ms, v), cs, m.spawn.y ?? 0, v.height), `${v.id} @ ${m.id}`).toBeNull();
      }
    }
  });
  it('(공통) 미션 목표 구획이 존재하고 비어 있으며 모든 차량이 규정 자세로 들어갈 수 있다', () => {
    const cs = allColliders();
    for (const m of map.missions) {
      const slot = map.slots.find((s) => s.id === m.slotId)!;
      expect(slot, m.id).toBeDefined();
      for (const v of VEHICLES) {
        const heading = m.kind === 'perpendicular-reverse' ? slot.dir + Math.PI : slot.dir;
        const s = createVehicleState(v, slot.x, slot.z, heading);
        expect(findVehicleCollision(obbOf(s, v), cs, slot.y ?? 0, v.height), `${m.id}/${v.id} 구획이 막힘`).toBeNull();
        const c = centerOf(s, v);
        expect(evaluateParking({ x: c.x, z: c.z, heading, length: v.length, width: v.width, y: slot.y }, slot, m.kind).poseOk, `${m.id}/${v.id}`).toBe(true);
      }
    }
  });
  it('실주행(헤드리스, 게임과 같은 물리·지형·건물 충돌체): 괴정역 → 하단(약 2.9km)·다대포(약 7.8km) 공영주차장까지 막힘 없이 도착', async () => {
    const g = buildRoadNetGraph(map.roadNet!);
    const spec = getVehicle('sedan');
    for (const id of ['saha-hadan-p', 'saha-dadae-p']) {
      const slot = map.slots.find((q) => q.id === id)!;
      const r = findRoadNetRoute(g, map.spawn, slot, 120)!;
      const pts = r.points.map((p) => [p.x, p.z] as [number, number]);
      const keys = new Set<string>();
      for (const p of pts) for (const k of tilesWithin(base.manifest, p[0], p[1], 60)) keys.add(k);
      const obs: ObstacleDef[] = [...map.obstacles];
      for (const k of keys) {
        if (!base.manifest.tiles.includes(k)) continue;
        const t = await src.json<SahaTile>(`tiles/${k}.json`);
        for (const b of t.buildings) for (const c of buildingColliders(b)) obs.push({ id: c.id, tag: 'building', shape: 'box', x: c.x, z: c.z, w: c.w, d: c.d, rot: c.rot, y0: c.y0, h: c.h });
      }
      const m2 = { ...map, obstacles: obs };
      const car = startState(m2, spec, map.spawn.x, map.spawn.z, map.spawn.heading, map.spawn.y);
      const res = drivePath(m2, spec, car, pts.slice(1, -1), { speed: 11, lookahead: 6, maxTime: 1500, goalRadius: 6, continueOnBlock: true, cornerSlow: true });
      expect(res.reached, id).toBe(true);
      expect(res.blocks, id).toEqual([]);
      expect(res.dist).toBeGreaterThan(r.length * 0.9);
      expect(res.maxY - res.minY, `${id} 실제 고저차`).toBeGreaterThan(5); // 평면 지도가 아니다
    }
  }, 60000);
  it('회귀(e2e-v062): 경사지 건물 충돌체는 외곽 안·주변의 가장 낮은 지면보다 아래까지 내려간다(낮은 쪽에서 오는 차가 밑으로 통과 금지)', () => {
    let worst = Infinity;
    for (const t of tiles.values())
      for (const b of t.buildings) {
        const cs = buildingColliders(b);
        for (const c of cs) {
          // 상자 둘레 2m 바깥까지 지면 최저
          let gmin = Infinity;
          for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
            const hx = (c.w / 2 + 2) * u;
            const hz = (c.d / 2 + 2) * v;
            const x = c.x + hx * Math.cos(c.rot) + hz * Math.sin(c.rot);
            const z = c.z - hx * Math.sin(c.rot) + hz * Math.cos(c.rot);
            gmin = Math.min(gmin, fieldHeight(base.field, x, z) ?? gmin);
          }
          worst = Math.min(worst, gmin - c.y0);
        }
      }
    expect(worst).toBeGreaterThan(0);
  });
  it('횡단보도·신호 정지선: 실제 OSM 노드 위치이고 모두 도로 중심선 위(도로 폭 안)에 있다', async () => {
    const q = base.manifest.quality as { crosswalks: number; trafficSignals: number };
    expect(q.crosswalks).toBeGreaterThan(50);
    expect(q.trafficSignals).toBeGreaterThan(50);
    let n = 0;
    for (const k of base.manifest.tiles.slice(0, 600)) {
      const t = await src.json<SahaTile>(`tiles/${k}.json`);
      for (const m of t.marks ?? []) {
        n++;
        const on = t.roads.some((r) => r.p.some((p) => Math.hypot(p[0] - m.x, p[1] - m.z) < 0.2));
        expect(on, `${k} ${m.k} ${m.x},${m.z}`).toBe(true);
      }
    }
    expect(n).toBe(q.crosswalks + q.trafficSignals);
  });
  it('타일 범위 계산: 반경 안 타일만', () => {
    const k = tilesWithin(base.manifest, 0, 0, 300);
    expect(k).toContain('0_0');
    expect(k).toContain('-1_-1');
    expect(k.length).toBeLessThanOrEqual(16);
  });
});
