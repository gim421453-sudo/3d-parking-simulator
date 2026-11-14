import { describe, expect, it, vi } from 'vitest';
import { findVehicleCollision } from '../src/core/geometry';
import { BASE_MAPS, MAPS, MECH_ANNEX, getMap, mapColliders } from '../src/maps';
import { ANNEX_DEPTH, ANNEX_HALF, annexGeom, cutGate, withMechAnnex } from '../src/maps/mechAnnex';
import { groundAt } from '../src/maps/terrain';
import { STATION } from '../src/mech/machine';
import { frameOf, toLocalXZ } from '../src/mech/facility';
import { drivePath, startState } from '../src/sim/autodrive';
import { planPath } from '../src/sim/planner';
import { centerOf } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';

vi.setConfig({ testTimeout: 120000 });

describe('기계식 부속 구역 기하 (v0.5.5)', () => {
  const b = { minX: -10, maxX: 10, minZ: -5, maxZ: 5 };
  it('네 방향 모두: 마당은 경계 바로 밖에 붙고, 시설 진입 방향(로컬 +x)이 바깥을 향한다', () => {
    for (const side of ['east', 'west', 'north', 'south'] as const) {
      const g = annexGeom(b, { id: 'a', name: 'a', side, at: 1 });
      const y = g.yard;
      expect((y.maxX - y.minX) * (y.maxZ - y.minZ)).toBeCloseTo(ANNEX_DEPTH * ANNEX_HALF * 2, 6);
      // 접근 자세에서 바깥쪽으로 직진하면 시설 로컬 z=0(팔레트 중심선) 위를 로컬 +x 로 지난다
      const f = frameOf(g.facility);
      const p0 = toLocalXZ(f, g.approach.x, g.approach.z);
      const p1 = toLocalXZ(f, g.approach.x + g.out.x * 5, g.approach.z + g.out.z * 5);
      expect(p0.z).toBeCloseTo(0, 9);
      expect(p1.x - p0.x).toBeCloseTo(5, 9);
      expect(Math.sin(g.approach.heading)).toBeCloseTo(g.out.x, 9);
      expect(Math.cos(g.approach.heading)).toBeCloseTo(g.out.z, 9);
    }
  });
  it('문 내기: 벽만 두 조각으로 자르고, 벽이 아닌 물체가 문 자리에 있으면 거부한다', () => {
    const wall = { id: 'edge-e', tag: 'wall' as const, shape: 'box' as const, x: 10.3, z: 0, w: 0.6, d: 10, h: 1.2 };
    const g = annexGeom(b, { id: 'a', name: 'a', side: 'east', at: 1 });
    const cut = cutGate([wall], g.gate, true);
    expect(cut.map((o) => o.id)).toEqual(['edge-e~a', 'edge-e~b']);
    expect(cut[0].z + cut[0].d! / 2).toBeCloseTo(-2, 9);
    expect(cut[1].z - cut[1].d! / 2).toBeCloseTo(4, 9);
    expect(cut[0].d! + cut[1].d!).toBeCloseTo(10 - 6, 9);
    expect(() => cutGate([{ ...wall, id: 'car', tag: 'car' as const }], g.gate, true)).toThrow(/벽이 아닌/);
    // 위층 벽(y0 > 0.5)은 건드리지 않는다
    expect(cutGate([{ ...wall, y0: 3 }], g.gate, true).map((o) => o.id)).toEqual(['edge-e']);
  });
  it('원본 맵 데이터를 바꾸지 않는다', () => {
    const base = BASE_MAPS.find((m) => m.id === 'lot')!;
    const n = base.obstacles.length;
    const bb = { ...base.bounds };
    withMechAnnex(base, MECH_ANNEX.lot);
    expect(base.obstacles.length).toBe(n);
    expect(base.bounds).toEqual(bb);
  });
});

describe('부속 구역이 붙은 9개 맵: 실제로 이어져 있고 차가 들어갈 수 있다', () => {
  for (const id of Object.keys(MECH_ANNEX)) {
    const m = getMap(id);
    const a = m.annex![0];
    const fac = m.mechFacilities![0];
    const out = { x: Math.sin(a.approach.heading), z: Math.cos(a.approach.heading) };
    it(`${id}: 마당이 맵 경계에 포함되고, 실내 맵은 천장이 마당을 덮지 않는다`, () => {
      expect(m.bounds.minX).toBeLessThanOrEqual(a.yard.minX);
      expect(m.bounds.maxX).toBeGreaterThanOrEqual(a.yard.maxX);
      expect(m.bounds.minZ).toBeLessThanOrEqual(a.yard.minZ);
      expect(m.bounds.maxZ).toBeGreaterThanOrEqual(a.yard.maxZ);
      if (m.env.indoor) {
        const r = m.env.ceilingRect!;
        expect(fac.x < r.minX || fac.x > r.maxX || fac.z < r.minZ || fac.z > r.maxZ, id).toBe(true);
      }
      expect(m.missions.some((q) => q.kind === 'mech-in' && q.mech?.facility === fac.id)).toBe(true);
    });
    it(`${id}: 접근 자세 → 문 → 승강장 문 앞까지 3차종 직선 통로가 비어 있고 지면이 이어진다`, () => {
      const cols = mapColliders(m);
      for (const vid of ['sedan', 'suv-x6', 'coupe-m4']) {
        const spec = getVehicle(vid);
        for (let s = 0; s <= 24; s += 0.25) {
          const x = a.approach.x + out.x * s;
          const z = a.approach.z + out.z * s;
          expect(findVehicleCollision({ x, z, rot: a.approach.heading, hw: spec.width / 2 + 0.05, hl: spec.length / 2 }, cols, 0, spec.height), `${id}/${vid} s=${s}`).toBeNull();
          if (m.terrain) expect(groundAt(m.terrain, x, z, 0), `${id} s=${s}`).not.toBeNull();
        }
      }
    });
    it(`${id}: 헤드리스 실주행 — 접근 자세에서 문을 지나 팔레트 위까지 (충돌 0)`, () => {
      const spec = getVehicle('sedan');
      const car = startState(m, spec, a.approach.x, a.approach.z, a.approach.heading);
      const f = frameOf(fac);
      const stop = { x: fac.x + out.x * (STATION.palletX + 0.3), z: fac.z + out.z * (STATION.palletX + 0.3) };
      const mid = { x: a.approach.x + out.x * 12, z: a.approach.z + out.z * 12 };
      const d = drivePath(m, spec, car, [[mid.x, mid.z], [stop.x, stop.z]], { speed: 1.2, lookahead: 2.5, maxTime: 120, goalRadius: 0.6 });
      expect(d.blocks, id).toEqual([]);
      expect(d.reached, id).toBe(true);
      const c = toLocalXZ(f, centerOf(car, spec).x, centerOf(car, spec).z);
      expect(Math.abs(c.z)).toBeLessThan(0.25);
      expect(c.x).toBeGreaterThan(STATION.doorX); // 문 안쪽(승강장)까지 들어왔다
    });
    it(`${id}: 맵 시작 위치에서 문 앞까지 기구학 경로가 있다 (SUV)`, () => {
      const spec = getVehicle('suv-x6');
      const goal = { x: a.approach.x - out.x * 2, z: a.approach.z - out.z * 2 };
      const p = planPath(m, spec, { x: m.spawn.x, z: m.spawn.z, heading: m.spawn.heading }, goal, { maxExpand: 120000 });
      // 시작 자세가 좁은 곳(콘 사이)이면 반대 방향으로 찾는다 — 기구학 경로는 뒤집어도 성립
      const q = p.found ? p : planPath(m, spec, { x: goal.x, z: goal.z, heading: a.approach.heading + Math.PI }, { x: m.spawn.x, z: m.spawn.z }, { maxExpand: 120000, goalRadius: 3 });
      expect(q.found, id).toBe(true);
    });
  }
  it('MAPS 13개 전부에 기계식 시설이 있다', () => {
    expect(MAPS.every((m) => (m.mechFacilities?.length ?? 0) > 0)).toBe(true);
  });
});
