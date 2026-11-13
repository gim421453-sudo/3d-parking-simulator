import { describe, expect, it, vi } from 'vitest';

// 헤드리스 실주행(게임과 같은 물리)을 여러 조합으로 돌리므로 시간이 걸린다 — CPU 가 바쁠 때도 시간 초과가 나지 않게 넉넉히 둔다
vi.setConfig({ testTimeout: 180000 });
import { colliderIsSolidForCar } from '../src/core/geometry';
import { MAPS, getMap, mapColliders } from '../src/maps';
import { B1_Y, MEGA_ZONES, UG_RAMP } from '../src/maps/mapMegaPark';
import { groundAt } from '../src/maps/terrain';
import type { MapData } from '../src/maps/types';
import { buildLevelGraph, findLevelRoute, graphClass, levelGraphFor, type LevelRoute } from '../src/nav/levelGraph';
import { Navigator } from '../src/nav/navigator';
import { distToCollider } from '../src/nav/roadGraph';
import { drivePath, startState } from '../src/sim/autodrive';
import { getVehicle } from '../src/vehicle/spec';

const TERRAIN_MAPS = MAPS.filter((m) => m.terrain);
const VEH = ['sedan', 'suv-x6', 'coupe-m4'];

/** 경로 유효성: 실제 지면 위(그 높이), 그 높이 구간의 충돌체와 차폭만큼 떨어져 있고, 높이가 갑자기 바뀌지 않는다 */
function validateRoute(map: MapData, r: LevelRoute, halfWidth: number): string | null {
  const solids = mapColliders(map).filter(colliderIsSolidForCar);
  const pts = r.points.slice(1, -1); // 그래프 노드만 (출발점/목적지 점 제외)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.abs(b.y - a.y) > 0.9) return `높이 점프 ${a.y}→${b.y} @${i}`;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > 9) return `간선 길이 ${len.toFixed(1)}m @${i}`;
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const yl = a.y + (b.y - a.y) * t;
      const g = groundAt(map.terrain!, x, z, yl, 0.6);
      if (g === null) return `지면 없음 (${x.toFixed(1)},${z.toFixed(1)},${yl.toFixed(1)})`;
      for (const c of solids) {
        if (c.y0 + c.h <= g + 0.2 || c.y0 >= g + 1.4) continue;
        if (distToCollider(x, z, c) < halfWidth * 0.8) return `충돌체 ${c.id} 관통 (${x.toFixed(1)},${z.toFixed(1)},${g.toFixed(1)})`;
      }
    }
  }
  return null;
}

describe('다층 도로 그래프: 모든 다층 맵 × 차종 × 미션', () => {
  for (const m of TERRAIN_MAPS) {
    it(`${m.id}: 모든 미션 목적지까지 경로가 있고, 경로는 실제 지면/층을 따라가며 벽을 관통하지 않는다`, () => {
      for (const id of VEH) {
        const spec = getVehicle(id);
        const g = levelGraphFor(m, spec);
        expect(g.nodes.length).toBeGreaterThan(50);
        for (const ms of m.missions) {
          const sp = ms.spawn ?? m.spawn;
          const sl = m.slots.find((s) => s.id === ms.slotId)!;
          const r = findLevelRoute(g, { x: sp.x, z: sp.z, y: sp.y ?? 0 }, { x: sl.x, z: sl.z, y: sl.y ?? 0 });
          expect(r, `${m.id}/${id}/${ms.id}`).not.toBeNull();
          expect(validateRoute(m, r!, spec.width / 2), `${m.id}/${id}/${ms.id}`).toBeNull();
          // 목적지 층에 도착한다
          const last = r!.points[r!.points.length - 2];
          expect(Math.abs(last.y - (sl.y ?? 0))).toBeLessThan(0.6);
        }
      }
    });
  }
  it('층이 바뀌는 구간은 경사로/나선 노드를 지난다 (tower 3F 미션: 직선 경사로 + 나선)', () => {
    const m = getMap('tower');
    const spec = getVehicle('suv-x6');
    const g = levelGraphFor(m, spec);
    const ms = m.missions.find((q) => q.id === 'tw-3')!;
    const sl = m.slots.find((s) => s.id === ms.slotId)!;
    // 지상 입구에서 출발
    const r = findLevelRoute(g, { x: -33, z: 0, y: 0 }, { x: sl.x, z: sl.z, y: sl.y ?? 0 })!;
    const kinds = new Set(r.nodeIds.map((i) => g.nodes[i].kind));
    expect(kinds.has('ramp')).toBe(true);
    expect(kinds.has('spiral')).toBe(true);
    const ys = r.points.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(6.4, 1);
    // 높이는 단조 증가(되돌아 내려가지 않음)
    for (let i = 1; i < ys.length - 1; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 0.05);
  });
});

describe('megapark: 구역 간 실제 도로 경로 (지상·지하·고층)', () => {
  const M = getMap('megapark');
  const ent = (id: string): { x: number; z: number; y: number } => {
    const z = MEGA_ZONES.find((q) => q.map.id === id)!;
    return { x: -46, z: (z.entranceZ ?? z.map.spawn.z) + z.dz, y: 0 };
  };
  const P: Record<string, { x: number; z: number; y: number }> = {
    lot: ent('lot'),
    outdoor: ent('outdoor'),
    c3: ent('carpark3'),
    g5: ent('garage5'),
    sp: ent('spiral'),
    mech: ent('mechpark'),
    b1: { x: 0, z: UG_RAMP.z, y: B1_Y },
    aveE: { x: 80, z: 60, y: 0 },
    aveW: { x: -58, z: -120, y: 0 },
  };
  const pairs: [string, string][] = [
    ['lot', 'outdoor'],
    ['outdoor', 'b1'],
    ['b1', 'aveE'],
    ['aveW', 'c3'],
    ['aveW', 'g5'],
    ['aveW', 'sp'],
    ['aveW', 'mech'],
  ];
  it('필수 연결 7개: 세 차종 모두 경로가 있고 유효하다', () => {
    for (const id of VEH) {
      const spec = getVehicle(id);
      const g = levelGraphFor(M, spec);
      for (const [a, b] of pairs) {
        const r = findLevelRoute(g, P[a], P[b], 6);
        expect(r, `${id} ${a}→${b}`).not.toBeNull();
        expect(validateRoute(M, r!, spec.width / 2), `${id} ${a}→${b}`).toBeNull();
      }
    }
  });
  it('실제 주행(헤드리스): 필수 연결 7개를 세단/SUV 가 경로대로 달려 도착한다 — 충돌 0, 순간이동 없음', () => {
    for (const id of ['sedan', 'suv-x6']) {
      const spec = getVehicle(id);
      const g = levelGraphFor(M, spec);
      for (const [a, b] of pairs) {
        const r = findLevelRoute(g, P[a], P[b], 6)!;
        const pts = r.points.slice(1, -1).map((p) => [p.x, p.z] as [number, number]);
        const q = pts[Math.min(2, pts.length - 1)];
        const car = startState(M, spec, P[a].x, P[a].z, Math.atan2(q[0] - P[a].x, q[1] - P[a].z), P[a].y);
        const d = drivePath(M, spec, car, pts, { speed: 5, lookahead: 4, maxTime: 900, goalRadius: 3, goalY: P[b].y });
        expect(d.blocks, `${id} ${a}→${b}`).toEqual([]);
        expect(d.reached, `${id} ${a}→${b}`).toBe(true);
        expect(d.maxStepDy).toBeLessThan(0.03);
      }
    }
  }, 240000);
  it('가짜 직선 경로 금지: 지하 칸 바로 위 지상에서 그 칸으로 가는 경로는 진입로와 경사로를 거친다', () => {
    const spec = getVehicle('sedan');
    const g = levelGraphFor(M, spec);
    const slot = M.slots.find((s) => s.id === 'ug:un-5')!;
    const r = findLevelRoute(g, { x: slot.x, z: slot.z, y: 0 }, { x: slot.x, z: slot.z, y: slot.y ?? 0 })!;
    expect(r).not.toBeNull();
    expect(r.length).toBeGreaterThan(100); // 직선거리는 0m(수직 3.2m)
    const passRamp = r.points.some((p) => p.y < -0.5 && p.y > B1_Y + 0.5 && p.x > UG_RAMP.bottomX && p.x < UG_RAMP.topX && Math.abs(p.z - UG_RAMP.z) < 3);
    expect(passRamp).toBe(true);
    expect(validateRoute(M, r, spec.width / 2)).toBeNull();
  });
  it('도로 우선: 야외 주차장 → 지하 경로가 잔디를 가로지르지 않고 동쪽 간선도로와 진입로를 지난다', () => {
    const spec = getVehicle('sedan');
    const r = findLevelRoute(levelGraphFor(M, spec), P.outdoor, P.b1, 6)!;
    expect(r.points.some((p) => Math.abs(p.x - 80) < 8 && Math.abs(p.y) < 0.01 && Math.abs(p.z - UG_RAMP.z) < 12)).toBe(true);
    // 진입로 축(z = 경사로 축) 위에서 경사로로 들어간다
    expect(r.points.some((p) => p.x > UG_RAMP.topX + 2 && p.x < 70 && Math.abs(p.z - UG_RAMP.z) < 2.5)).toBe(true);
  });
  it('차종별 통행 제한: 차고 3.0m 는 B1 경로 없음(천장 2.9m), 차폭 4.2m 는 지하 경사로(폭 7m)는 가능하지만 타워 경사로(폭 3.8m)는 불가', () => {
    const tall = { ...getVehicle('suv-x6'), id: 'tall', height: 3.0 };
    const c = graphClass(tall);
    const gt = buildLevelGraph(M, { clearance: c.clearance, height: c.height, spec: tall });
    expect(findLevelRoute(gt, P.aveE, P.b1, 6)).toBeNull();
    expect(findLevelRoute(gt, P.aveW, P.lot, 6)).not.toBeNull(); // 지상 도로는 가능
    const tower = getMap('tower');
    const wide = { ...getVehicle('suv-x6'), id: 'wide', width: 4.2 };
    const cw = graphClass(wide);
    const gw = buildLevelGraph(tower, { clearance: cw.clearance, height: cw.height, spec: wide });
    const s2 = tower.slots.find((s) => s.id === 'tw2-s-4')!;
    expect(findLevelRoute(gw, { x: -33, z: 0, y: 0 }, { x: s2.x, z: s2.z, y: s2.y ?? 0 })).toBeNull();
    const gn = levelGraphFor(tower, getVehicle('suv-x6'));
    expect(findLevelRoute(gn, { x: -33, z: 0, y: 0 }, { x: s2.x, z: s2.z, y: s2.y ?? 0 })).not.toBeNull();
  });
  it('기계식 시설 입구 3곳 모두 도로 경로가 있다', () => {
    const spec = getVehicle('sedan');
    const g = levelGraphFor(M, spec);
    for (const f of M.mechFacilities!) {
      const c = Math.cos(f.rotationY);
      const s = Math.sin(f.rotationY);
      const e = { x: f.x + -13 * c, z: f.z - -13 * s, y: 0 };
      expect(findLevelRoute(g, P.aveW, e, 8), f.id).not.toBeNull();
    }
  });
});

describe('일방통행 도로', () => {
  it('일방통행 구간은 역방향 간선이 없어 돌아가는 경로가 나온다', () => {
    const base = getMap('megapark');
    // 연결도로 st-5(z=21)를 서→동 일방통행으로 바꾼 사본
    const m: MapData = { ...base, id: 'oneway-test', roads: base.roads!.map((r) => (r.id === 'st-5' ? { ...r, oneway: true } : r)) };
    const spec = getVehicle('sedan');
    const c = graphClass(spec, 0.7);
    const g = buildLevelGraph(m, { clearance: c.clearance, height: c.height, spec });
    const west = { x: -40, z: 21, y: 0 };
    const east = { x: 60, z: 21, y: 0 };
    const fwd = findLevelRoute(g, west, east, 4)!;
    const back = findLevelRoute(g, east, west, 4)!;
    expect(fwd).not.toBeNull();
    expect(back).not.toBeNull();
    expect(fwd.length).toBeLessThan(115);
    expect(back.length).toBeGreaterThan(fwd.length + 40); // 역방향은 다른 도로로 우회
    // 역방향 경로는 st-5 를 서쪽으로 거슬러 가지 않는다
    for (let i = 1; i < back.points.length - 1; i++) {
      const a = back.points[i - 1];
      const b = back.points[i];
      const onSt = Math.abs(a.z - 21) < 2 && Math.abs(b.z - 21) < 2 && a.x > -50 && a.x < 74 && b.x > -50 && b.x < 74;
      if (onSt) expect(b.x).toBeGreaterThanOrEqual(a.x - 1e-6);
    }
  });
});

describe('내비게이션 상태 (다층)', () => {
  it('megapark: 지상에서 B1 칸으로 — 현재 층/목적지 층, 경사로 안내(내려가기), 도착은 같은 층에서만', () => {
    const M = getMap('megapark');
    const nav = new Navigator();
    nav.setVehicle(getVehicle('sedan'));
    nav.setMap(M);
    const slot = M.slots.find((s) => s.id === 'ug:un-5')!;
    // 바로 위 지상에 있어도(수평 거리 0) 도착이 아니다
    nav.setDestination(slot, { x: slot.x, z: slot.z, y: 0 });
    let st = nav.state;
    expect(st.status).toBe('guiding');
    expect(st.level).toBe('지상');
    expect(st.destLevel).toMatch(/B1/);
    // 진입로 위(경사로 20m 앞)
    st = nav.update(0.1, { x: UG_RAMP.topX + 20, z: UG_RAMP.z, y: 0 });
    st = nav.update(2, { x: UG_RAMP.topX + 20, z: UG_RAMP.z, y: 0 });
    expect(st.ramp?.dir).toBe('down');
    expect(st.ramp?.to).toMatch(/B1/);
    expect(st.text).toMatch(/내려가기/);
    // B1 의 그 칸 앞: 도착
    st = nav.update(0.1, { x: slot.x, z: slot.z - 3, y: B1_Y });
    expect(st.status).toBe('arrived');
  });
  it('tower: 1F 에서 3F 목적지 — 올라가기 안내', () => {
    const m = getMap('tower');
    const nav = new Navigator();
    nav.setVehicle(getVehicle('suv-x6'));
    nav.setMap(m);
    const slot = m.slots.find((s) => s.id === 'tw3-n-4')!;
    nav.setDestination(slot, { x: -33, z: 0, y: 0 });
    const st = nav.update(0.1, { x: -33, z: 0, y: 0 });
    expect(st.status).toBe('guiding');
    expect(st.ramp?.dir).toBe('up');
    expect(st.destLevel).toBe('3F');
  });
  it('평면 맵은 기존 격자 그래프를 그대로 쓴다(회귀 없음)', () => {
    const m = getMap('lot');
    const nav = new Navigator();
    nav.setVehicle(getVehicle('sedan'));
    nav.setMap(m);
    expect(nav.multiLevel).toBe(false);
    expect(nav.roadGraph).not.toBeNull();
  });
});
