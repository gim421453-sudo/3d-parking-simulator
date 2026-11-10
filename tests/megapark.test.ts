import { describe, expect, it } from 'vitest';
import { MAPS, getMap } from '../src/maps';
import { MAP_MEGAPARK, MEGA_ZONES } from '../src/maps/mapMegaPark';
import { groundAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { arc, line, makeSim } from './helpers/driveSim';

const M = MAP_MEGAPARK;
const colliders = mapColliders(M);
const zones = (M as unknown as { zones: { id: string; label: string; bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; entrance: { x: number; z: number; side: 'west' | 'east' } }[] }).zones;

describe('통합 맵 megapark — 구성', () => {
  it('10번째 맵으로 등록, 기존 9개 맵도 개별 선택 가능', () => {
    expect(getMap('megapark').id).toBe('megapark');
    for (const id of ['lot', 'underground', 'outdoor', 'tower', 'garage5', 'carpark3', 'modlot', 'spiral', 'mechpark']) expect(MAPS.some((m) => m.id === id), id).toBe(true);
    expect(MAPS.length).toBeGreaterThanOrEqual(10);
  });
  it('9개 구역이 모두 존재하고 서로 겹치지 않는다', () => {
    expect(zones.map((z) => z.id).sort()).toEqual(['carpark3', 'garage5', 'lot', 'mechpark', 'modlot', 'outdoor', 'spiral', 'tower', 'underground']);
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i].bounds;
        const b = zones[j].bounds;
        const ov = a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
        expect(ov, `${zones[i].id} ↔ ${zones[j].id}`).toBe(false);
      }
      const z = zones[i].bounds;
      expect(z.minX).toBeGreaterThan(M.bounds.minX);
      expect(z.maxX).toBeLessThan(M.bounds.maxX);
      expect(z.minZ).toBeGreaterThan(M.bounds.minZ);
      expect(z.maxZ).toBeLessThan(M.bounds.maxZ);
    }
  });
  it('각 구역의 원본 장애물/주차칸/미션/지형 면이 빠짐없이 들어 있다 (입구 쪽 외벽만 개방)', () => {
    for (const z of MEGA_ZONES) {
      const src = z.map;
      const ns = z.ns ? `${z.ns}:` : '';
      const own = (id: string) => (ns ? id.startsWith(ns) : !/^(lot|ug|out|ml|tw|g5|c3|sp):/.test(id));
      const wallsOpened = src.obstacles.filter((o) => /^edge-w/.test(o.id) || (z.side === 'east' && /^edge-e/.test(o.id))).length; // 입구 쪽 외벽만 개방
      expect(M.obstacles.filter((o) => own(o.id) && !(z.ns === '' && false)).length, `${src.id} 장애물`).toBeGreaterThanOrEqual(src.obstacles.length - wallsOpened);
      expect(M.slots.filter((s) => own(s.id)).length, `${src.id} 주차칸`).toBe(src.slots.length);
      expect(M.missions.filter((m) => own(m.id)).length, `${src.id} 미션`).toBe(src.missions.length);
      if (src.terrain) {
        const tsurf = M.terrain!.surfaces.filter((s) => (ns ? s.id.startsWith(ns) : false));
        if (ns) expect(tsurf.length, `${src.id} 지형`).toBe(src.terrain.surfaces.length);
      }
    }
  });
  it('객체 ID 중복/누락 없음 (충돌체/주차칸/미션)', () => {
    expect(new Set(colliders.map((c) => c.id)).size).toBe(colliders.length);
    expect(new Set(M.slots.map((s) => s.id)).size).toBe(M.slots.length);
    expect(new Set(M.missions.map((m) => m.id)).size).toBe(M.missions.length);
  });
  it('좌표 변환 일관성: 대표 객체(주차칸/미션 스폰/지형 deck)가 같은 평행이동을 받는다', () => {
    for (const z of MEGA_ZONES) {
      if (!z.ns) continue;
      const s0 = z.map.slots[0];
      const t = M.slots.find((s) => s.id === `${z.ns}:${s0.id}`)!;
      expect(t.x - s0.x).toBeCloseTo(z.dx, 9);
      expect(t.z - s0.z).toBeCloseTo(z.dz, 9);
      const m0 = z.map.missions[0];
      const tm = M.missions.find((m) => m.id === `${z.ns}:${m0.id}`)!;
      const sp = m0.spawn ?? z.map.spawn;
      expect(tm.spawn!.x - sp.x).toBeCloseTo(z.dx, 9);
      expect(tm.spawn!.z - sp.z).toBeCloseTo(z.dz, 9);
      if (z.map.terrain) {
        const d0 = z.map.terrain.surfaces.find((s) => s.kind === 'deck')!;
        const td = M.terrain!.surfaces.find((s) => s.id === `${z.ns}:${d0.id}`)!;
        if (d0.kind === 'deck' && td.kind === 'deck') {
          expect(td.rect.x - d0.rect.x).toBeCloseTo(z.dx, 9);
          expect(td.y).toBe(d0.y);
        }
      }
    }
  });
  it('기계식 구역은 장치 좌표(절대값)를 유지한다: 이동 0, 슬롯/미션 원본 그대로', () => {
    const z = MEGA_ZONES.find((q) => q.map.id === 'mechpark')!;
    expect(z.dx).toBe(0);
    expect(z.dz).toBe(0);
    expect(M.missions.filter((m) => m.mech).length).toBe(z.map.missions.length);
    expect(M.mech).toBe(true);
  });
  it('미션 수: 통합 맵에 일반/지하/3층/5층/나선/기계식 8F·12F 입고·출고 미션이 모두 있다', () => {
    const ids = M.missions.map((m) => m.id);
    for (const key of ['lot:lot-front', 'lot:lot-reverse', 'ug:', 'c3:', 'g5:g5-5', 'sp:', 'ml:', 'mech-in-1', 'mech-in-rev', 'mech-in-12f', 'mech-out-1']) expect(ids.some((i) => i.startsWith(key) || i === key), key).toBe(true);
    expect(M.missions.some((m) => m.mech?.slot === '08A')).toBe(true);
    expect(M.missions.some((m) => m.mech?.slot === '12A')).toBe(true);
  });
});

describe('통합 맵 — 지형/층 계산', () => {
  it('모든 구역 위 지면(y=0)과 층별 바닥이 올바르게 계산된다', () => {
    const T = M.terrain!;
    expect(groundAt(T, -58, 0, 0)).toBe(0); // 간선도로
    for (const z of zones) expect(groundAt(T, z.entrance.x - 2, z.entrance.z, 0), `${z.id} 입구 도로`).toBe(0);
    const g5 = MEGA_ZONES.find((q) => q.map.id === 'garage5')!;
    // 5층 타워 5F(y=12) 바닥은 같은 평면 좌표에서 층 구분
    expect(groundAt(T, -20 + g5.dx, 0 + g5.dz, 12)).toBe(12);
    expect(groundAt(T, -20 + g5.dx, 0 + g5.dz, 0)).toBe(0);
    // 지하주차장 천장은 지면에서 선택되지 않는다
    const ug = zones.find((z) => z.id === 'underground')!;
    expect(groundAt(T, (ug.bounds.minX + ug.bounds.maxX) / 2, (ug.bounds.minZ + ug.bounds.maxZ) / 2, 0)).toBe(0);
  });
});

describe('통합 맵 — 구역 연결(도로): 간선도로 → 진입로 → 구역 입구, 실제 주행 시뮬레이션', () => {
  const sim = makeSim(M.terrain!, colliders);
  for (const specId of ['sedan', 'suv-x6']) {
    for (const z of zones) {
      it(`${specId} → ${z.label}: 간선도로에서 구역 입구까지 충돌/지면 이탈 0`, () => {
        const ez = z.entrance.z;
        const north = ez > 1 && z.entrance.side === 'west';
        const south = ez < -1;
        const east = z.entrance.side === 'east';
        const top = z.bounds.maxZ + 7;
        const ex = z.bounds.maxX + 4;
        const path: [number, number][] = east
          ? [...line(-58, 0, -58, top - 6, 1), ...arc(-52, top - 6, 6, Math.PI, Math.PI / 2, 0.5), ...line(-52, top, ex - 6, top, 1), ...arc(ex - 6, top - 6, 6, Math.PI / 2, 0, 0.5), ...line(ex, top - 6, ex, ez + 6, 1), ...arc(ex - 6, ez + 6, 6, 0, -Math.PI / 2, 0.5), ...line(ex - 6, ez, z.entrance.x - 3, ez, 1)]
          : north
          ? [...line(-58, 0, -58, ez - 6, 1), ...arc(-52, ez - 6, 6, Math.PI, Math.PI / 2, 0.5), ...line(-52, ez, z.entrance.x + 3, ez, 1)]
          : south
            ? [...line(-58, 0, -58, ez + 6, 1), ...arc(-52, ez + 6, 6, Math.PI, (3 * Math.PI) / 2, 0.5), ...line(-52, ez, z.entrance.x + 3, ez, 1)]
            : line(-58, 0, z.entrance.x + 3, 0, 1);
        const h0 = north || east ? 0 : south ? Math.PI : Math.PI / 2;
        const r = sim.drive(specId, { x: -58, z: 0, h: h0, y: 0 }, path, (car) => (east ? car.x < z.entrance.x - 2 : car.x > z.entrance.x + 2) && Math.abs(car.z - ez) < 3, 3.0, 240);
        expect(r.reached, `${z.id} 도달 (last hit ${r.lastHit})`).toBe(true);
        expect(r.collisions).toBe(0);
        expect(r.offGround).toBe(0);
      });
    }
  }
});
