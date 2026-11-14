import { describe, expect, it } from 'vitest';
import { colliderIsSolidForCar } from '../src/core/geometry';
import { MAPS } from '../src/maps';
import { mapColliders } from '../src/maps/types';
import { Navigator, nextManeuver, projectOnRoute, ARRIVE_DIST } from '../src/nav/navigator';
import { buildBestRoadGraph, distToCollider, isClear } from '../src/nav/roadGraph';
import { dijkstra, findRoute, simplify } from '../src/nav/router';

describe('도로 그래프 (맵의 실제 충돌체에서 계산)', () => {
  for (const map of MAPS.filter((m) => !m.terrain && (!m.mech || m.annex))) {
    describe(map.name, () => {
      const g = buildBestRoadGraph(map);
      const solids = mapColliders(map).filter(colliderIsSolidForCar);
      it('모든 노드가 충돌체/경계에서 충분히 떨어져 있다', () => {
        expect(g.nodes.length).toBeGreaterThan(20);
        for (const n of g.nodes) expect(isClear(map, solids, n.x, n.z, g.clearance - 1e-6)).toBe(true);
      });
      it('시작 위치에서 모든 미션 슬롯까지 경로가 있다', () => {
        for (const m of map.missions) {
          const slot = map.slots.find((s) => s.id === m.slotId)!;
          const from = m.spawn ?? map.spawn;
          const r = findRoute(g, map, from, slot);
          expect(r, `${map.id}/${m.id}`).not.toBeNull();
          expect(r!.points.length).toBeGreaterThanOrEqual(2);
        }
      });
      it('경로의 모든 점이 장애물 위를 지나지 않는다 (경로 샘플링)', () => {
        for (const m of map.missions) {
          const slot = map.slots.find((s) => s.id === m.slotId)!;
          const r = findRoute(g, map, m.spawn ?? map.spawn, slot)!;
          // 마지막 구간(슬롯 안쪽)은 제외하고 도로 구간만 검사
          for (let i = 1; i < r.points.length - 2; i++) {
            const a = r.points[i];
            const b = r.points[i + 1];
            for (let t = 0; t <= 1; t += 0.1) {
              const x = a.x + (b.x - a.x) * t;
              const z = a.z + (b.z - a.z) * t;
              for (const c of solids) expect(distToCollider(x, z, c), `${m.id} (${x.toFixed(1)},${z.toFixed(1)}) vs ${c.id}`).toBeGreaterThan(0.4);
            }
          }
        }
      });
    });
  }
});

describe('경로 계산/안내', () => {
  it('dijkstra: 직선 격자에서 최단거리', () => {
    const map = MAPS[0];
    const g = buildBestRoadGraph(map);
    const { dist } = dijkstra(g, 0);
    expect(dist[0]).toBe(0);
    expect(dist.some((d) => d > 0 && isFinite(d))).toBe(true);
  });
  it('simplify: 일직선 점들은 양 끝만 남는다', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: 0, z: i }));
    expect(simplify(pts, 0.1).length).toBe(2);
  });
  it('nextManeuver: ㄱ자 경로에서 좌/우회전을 올바르게 구분 (heading: 0=+z, 증가=왼쪽)', () => {
    // +z 로 10m 가다 +x 방향(오른쪽)으로 꺾는다: heading 0 → +π/2 : 왼쪽(heading 증가)
    const left = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }];
    expect(nextManeuver(left, 0, 2)).toMatchObject({ type: 'left' });
    expect(nextManeuver(left, 0, 2).distM).toBeCloseTo(8, 6);
    const right = [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: -10, z: 10 }];
    expect(nextManeuver(right, 0, 0).type).toBe('right');
    const straight = [{ x: 0, z: 0 }, { x: 0, z: 10 }];
    expect(nextManeuver(straight, 0, 3)).toMatchObject({ type: 'arrive' });
  });
  it('projectOnRoute: 경로 위/옆 점의 진행거리와 횡거리', () => {
    const pts = [{ x: 0, z: 0 }, { x: 0, z: 10 }];
    const p = projectOnRoute(pts, { x: 2, z: 4 });
    expect(p.along).toBeCloseTo(4, 6);
    expect(p.lateral).toBeCloseTo(2, 6);
  });
});

describe('Navigator', () => {
  const map = MAPS[0];
  const slot = map.slots.find((s) => s.id === 'n-2')!;
  const make = () => {
    const nav = new Navigator();
    nav.setMap(map);
    return nav;
  };
  it('목적지를 정하면 경로와 안내가 생긴다', () => {
    const nav = make();
    nav.setDestination(slot, map.spawn);
    const st = nav.update(0.1, map.spawn);
    expect(st.status).toBe('guiding');
    expect(st.route).not.toBeNull();
    expect(st.remainingM).toBeGreaterThan(5);
    expect(['straight', 'left', 'right', 'arrive', 'uturn']).toContain(st.next.type);
  });
  it('경로를 따라가면 남은 거리가 줄어든다', () => {
    const nav = make();
    nav.setDestination(slot, map.spawn);
    const r0 = nav.update(0.1, map.spawn).remainingM;
    const mid = nav.state.route!.points[Math.min(2, nav.state.route!.points.length - 1)];
    expect(nav.update(0.1, mid).remainingM).toBeLessThan(r0);
  });
  it('슬롯 근처에 도착하면 arrived', () => {
    const nav = make();
    nav.setDestination(slot, map.spawn);
    const st = nav.update(0.1, { x: slot.x, z: slot.z - (ARRIVE_DIST - 0.5) });
    expect(st.status).toBe('arrived');
  });
  it('경로를 이탈하면(>6m, 1초 이상) 재탐색한다', () => {
    const nav = make();
    nav.setDestination(slot, map.spawn);
    nav.update(0.1, map.spawn);
    const far = { x: map.spawn.x - 16, z: map.spawn.z + 2 };
    let st = nav.update(0.5, far);
    expect(st.offRoute).toBe(true);
    st = nav.update(0.6, far);
    expect(st.rerouteCount).toBe(1);
    expect(st.route).not.toBeNull();
    // 재탐색된 경로의 시작점은 새 위치
    expect(Math.hypot(st.route!.points[0].x - far.x, st.route!.points[0].z - far.z)).toBeLessThan(0.01);
  });
  it('목적지 해제 시 idle', () => {
    const nav = make();
    nav.setDestination(slot, map.spawn);
    nav.setDestination(null, map.spawn);
    expect(nav.update(0.1, map.spawn).status).toBe('idle');
  });
});

import { MAP_TOWER } from '../src/maps/mapTower';
describe('다층 맵 내비게이션', () => {
  it('주차타워는 층 이동 경로 계산을 지원하지 않음을 명시적으로 알린다(noRoute, 가짜 경로 없음)', () => {
    const nav = new Navigator();
    nav.setMap(MAP_TOWER);
    nav.setDestination(MAP_TOWER.slots[0], { x: -33, z: 0 });
    expect(nav.state.status).toBe('noRoute');
    expect(nav.state.route).toBeNull();
  });
});
