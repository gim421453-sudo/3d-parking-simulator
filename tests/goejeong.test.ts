import { describe, expect, it, vi } from 'vitest';
import { findVehicleCollision } from '../src/core/geometry';
import { getMap, mapColliders } from '../src/maps';
import data from '../src/maps/data/goejeong.json';
import { buildRoadNetGraph, findRoadNetRoute, largestComponent } from '../src/nav/roadNet';
import { drivePath, startState } from '../src/sim/autodrive';
import { obbOf } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';
import { pointInPoly, type Pt } from '../src/world/footprint';

vi.setConfig({ testTimeout: 180000 });

describe('괴정동 실제 지도 (OSM, v0.6.0)', () => {
  const m = getMap('goejeong');
  it('데이터 출처/라이선스가 기록되어 있다 (ODbL)', () => {
    expect(data.license).toBe('ODbL-1.0');
    expect(data.attribution).toMatch(/OpenStreetMap contributors/);
    expect(m.geo!.attribution).toMatch(/OpenStreetMap/);
    expect(m.desc).toMatch(/OpenStreetMap/);
  });
  it('1km × 1km, 실제 OSM 건물/도로가 들어 있고 생성 건물은 gen 으로 구분된다', () => {
    expect(m.bounds.maxX - m.bounds.minX).toBe(1000);
    const real = m.geo!.buildings.filter((b) => !b.gen);
    expect(real.length).toBeGreaterThan(50);
    expect(m.geo!.buildings.some((b) => b.gen)).toBe(true);
    expect(m.geo!.roads.some((r) => r.name === '낙동대로' && r.hw === 'primary')).toBe(true);
    expect(m.geo!.buildings.some((b) => b.name === '부산광역시립 사하도서관')).toBe(true);
  });
  it('건물 충돌 상자가 다각형을 따라간다: 모든 상자 중심이 그 건물 다각형 안', () => {
    const byId = new Map(m.geo!.buildings.map((b) => [b.id, b]));
    for (const o of m.obstacles.filter((q) => q.tag === 'building' && q.id.startsWith('bld-'))) {
      const bid = o.id.replace(/^bld-/, '').replace(/-\d+$/, '');
      const b = byId.get(bid)!;
      expect(b, o.id).toBeTruthy();
      expect(pointInPoly(b.pts as Pt[], o.x, o.z), o.id).toBe(true);
      expect(o.hidden).toBe(true); // 외형은 geo 레이어
    }
  });
  it('도로 중심선 위에 건물 충돌체가 없다(차로가 막히지 않음)', () => {
    const cols = mapColliders(m).filter((c) => c.tag === 'building');
    for (const r of m.geo!.roads) {
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, az] = r.pts[i - 1];
        const [bx, bz] = r.pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let k = 0; k <= n; k++) {
          const x = ax + ((bx - ax) * k) / n;
          const z = az + ((bz - az) * k) / n;
          expect(findVehicleCollision({ x, z, rot: 0, hw: 0.5, hl: 0.5 }, cols)?.id, `${r.id} (${r.name ?? r.hw}) @ ${x.toFixed(0)},${z.toFixed(0)}`).toBeUndefined();
        }
      }
    }
  });
  it('도로망 그래프: 대부분 하나로 연결(≥ 95%)', () => {
    const g = buildRoadNetGraph(m.roadNet!);
    expect(largestComponent(g) / g.nodes.length).toBeGreaterThan(0.95);
  });
  it('내비 경로(실제 도로망): 괴정역 앞 시작 → 사하도서관 주차장 목표 칸, 경로를 따라 헤드리스 실주행 시 충돌 0 으로 주차장 앞까지 간다', () => {
    const ms = m.missions.find((q) => q.id === 'gj-library')!;
    const slot = m.slots.find((s) => s.id === ms.slotId)!;
    const g = buildRoadNetGraph(m.roadNet!);
    const r = findRoadNetRoute(g, m.spawn, slot)!;
    expect(r).not.toBeNull();
    expect(r.length).toBeGreaterThan(300); // 실제로 시가지를 지나간다
    const spec = getVehicle('sedan');
    const car = startState(m, spec, m.spawn.x, m.spawn.z, m.spawn.heading);
    expect(findVehicleCollision(obbOf(car, spec), mapColliders(m))).toBeNull();
    // 도로 구간만(마지막 주차장 진입 직선 제외) 주행
    const path = r.points.slice(1, -1).map((p) => [p.x, p.z] as const);
    const d = drivePath(m, spec, car, path, { speed: 6, lookahead: 7, maxTime: 400, goalRadius: 4 });
    expect(d.blocks, JSON.stringify(d.blocks.slice(0, 2))).toEqual([]);
    expect(d.reached).toBe(true);
  });
});
