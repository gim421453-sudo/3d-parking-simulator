import { describe, expect, it, vi } from 'vitest';
import { getMap, MAPS } from '../src/maps';
import { ALLEY } from '../src/maps/mapAlley';
import { GARAGE_LIFT } from '../src/maps/mapGarage';
import { liftChecklist, liftUp, newLift, stepLift, liftedPose, liftDown } from '../src/service/lift';
import { drivePath, startState } from '../src/sim/autodrive';
import { planPath } from '../src/sim/planner';
import { centerOf } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';

vi.setConfig({ testTimeout: 240000 });

describe('신규 맵 등록 (기존 맵을 대체하지 않고 추가)', () => {
  it('기존 10개 맵 + 정비소 + 골목길 = 12개, 신규 맵은 임시 배치로 표시', () => {
    const ids = MAPS.map((m) => m.id);
    for (const id of ['lot', 'underground', 'outdoor', 'tower', 'garage5', 'carpark3', 'modlot', 'spiral', 'mechpark', 'megapark']) expect(ids).toContain(id);
    expect(ids).toContain('garage');
    expect(ids).toContain('alley');
    expect(getMap('garage').provisional).toBe(true);
    expect(getMap('alley').provisional).toBe(true);
  });
});

describe('좁은 골목길: 차종별 실제 통과 가능 여부 (기구학 경로 탐색 = 게임과 같은 차체 충돌 판정)', () => {
  const m = getMap('alley');
  const legs = {
    in: [{ x: -27, z: -19.6, heading: Math.PI / 2 }, { x: 5.5, z: 10 }] as const, // 도로 → 골목 A → 직각 회전 → 골목 B
    out: [{ x: 2, z: 10, heading: Math.PI / 2 }, { x: 24, z: -17.5 }] as const, // 골목 B → 직각 회전 → 골목 C → 도로
    dead: [{ x: -12, z: 10, heading: Math.PI / 2 }, { x: -1, z: 20 }] as const, // 골목 B → 막다른 골목 → 회차 공간
  };
  it('골목 폭 데이터: A/B/D 3.4m, C 3.6m', () => {
    expect(ALLEY.A.x1 - ALLEY.A.x0).toBeCloseTo(3.4, 9);
    expect(ALLEY.B.z1 - ALLEY.B.z0).toBeCloseTo(3.4, 9);
    expect(ALLEY.C.x1 - ALLEY.C.x0).toBeCloseTo(3.6, 9);
    expect(ALLEY.D.x1 - ALLEY.D.x0).toBeCloseTo(3.4, 9);
  });
  it('소형/세단: 진입·진출·막다른 골목 모두 전진만으로(꺾어 넣기 없이) 통과', () => {
    for (const id of ['compact', 'sedan']) {
      const spec = getVehicle(id);
      for (const [name, [s, g]] of Object.entries(legs)) {
        const r = planPath(m, spec, s, g, { goalRadius: 1.5, allowReverse: false });
        expect(r.found, `${id}/${name}`).toBe(true);
      }
    }
  });
  it('SUV/대형 SUV/쿠페: 모든 구간 통과 가능(큰 차는 전·후진 꺾어 넣기 최대 2회)', () => {
    for (const id of ['suv', 'suv-x6', 'coupe-m4']) {
      const spec = getVehicle(id);
      for (const [name, [s, g]] of Object.entries(legs)) {
        const r = planPath(m, spec, s, g, { goalRadius: 1.5 });
        expect(r.found, `${id}/${name}`).toBe(true);
        expect(r.switches, `${id}/${name}`).toBeLessThanOrEqual(2);
      }
    }
  });
  it('차폭 2.34m 컨셉 쿠페는 3.4m 골목의 직각 회전을 통과하지 못한다(통과 불가 차량으로 판정)', () => {
    const r = planPath(m, getVehicle('concept-coupe'), legs.in[0], legs.in[1], { goalRadius: 1.5, maxExpand: 120000 });
    expect(r.found).toBe(false);
  });
  it('막다른 골목: 회차 공간에서 방향을 돌려(전·후진) 다시 골목 B 로 나올 수 있다 — 소형/세단', () => {
    for (const id of ['compact', 'sedan']) {
      const spec = getVehicle(id);
      const r = planPath(m, spec, { x: -3.5, z: 20, heading: Math.PI / 2 }, { x: -10, z: 10 }, { goalRadius: 1.5 });
      expect(r.found, id).toBe(true);
      expect(r.switches).toBeGreaterThanOrEqual(1); // 막다른 곳이라 전진만으로는 못 나온다
      expect(planPath(m, spec, { x: -3.5, z: 20, heading: Math.PI / 2 }, { x: -10, z: 10 }, { goalRadius: 1.5, allowReverse: false, maxExpand: 60000 }).found).toBe(false);
    }
  });
  it('후진 통과: 세단이 골목 A 를 후진으로만 빠져나올 수 있다', () => {
    const spec = getVehicle('sedan');
    // 골목 A 안에서 북쪽을 보고 서 있다가 도로로 후진
    const r = planPath(m, spec, { x: -18, z: -2, heading: 0 }, { x: -18, z: -17 }, { goalRadius: 2 });
    expect(r.found).toBe(true);
    expect(r.poses.some((p) => p.dir === -1)).toBe(true);
  });
  it('헤드리스 실주행: 소형차가 골목 A→B→C 를 자동 조종으로 한 바퀴 통과(충돌 0)', () => {
    const spec = getVehicle('compact');
    const loop: [number, number][] = [[-24, -19.6], [-21.5, -19.4], [-19.2, -18.2], [-18.1, -15.5], [-18, -12], [-18, 3], [-17.7, 7], [-16.2, 9.4], [-13, 10], [0, 10], [8.5, 10], [12, 9.6], [13.7, 7.6], [14, 4], [14, -11], [14.3, -15], [16.5, -17.6], [20, -17.4], [26, -17.4]];
    const d = drivePath(m, spec, startState(m, spec, -27, -19.6, Math.PI / 2), loop, { speed: 1.2, lookahead: 2.2, maxTime: 300, goalRadius: 2.5 });
    expect(d.blocks).toEqual([]);
    expect(d.reached).toBe(true);
  });
});

describe('정비소: 리프트 베이 진입과 승강 (헤드리스 실주행 + 리프트 상태기계)', () => {
  const m = getMap('garage');
  it('맵에 리프트 1기, 기둥 2개가 실제 충돌체, 기둥 안쪽 간격이 차폭 한계(2.1m)보다 넓다', () => {
    expect(m.lifts!.length).toBe(1);
    const posts = m.obstacles.filter((o) => o.id.startsWith('lift-a-post'));
    expect(posts.length).toBe(2);
    const gap = Math.abs(posts[0].x - posts[1].x) - (posts[0].w ?? 0);
    expect(gap).toBeGreaterThan(2.1 + 0.6);
  });
  for (const id of ['sedan', 'suv-x6', 'coupe-m4']) {
    it(`${id}: 앞마당에서 문을 지나 두 기둥 사이 정위치까지 주행 → 조건 충족 → 상승 1.8m → 하강 → 출차`, () => {
      const spec = getVehicle(id);
      const L = GARAGE_LIFT;
      const car = startState(m, spec, L.x, -14, 0);
      // 차체 중심이 리프트 중심에 오도록: 경로의 마지막 점 = 리프트 중심 조금 앞(자동 조종 기준점 = 차체 중심)
      const d = drivePath(m, spec, car, [[L.x, -8], [L.x, 0], [L.x, L.z]], { speed: 1.2, lookahead: 2.5, maxTime: 120, goalRadius: 0.2 });
      expect(d.blocks, id).toEqual([]);
      expect(d.reached, id).toBe(true);
      car.v = 0;
      car.gear = 'P';
      car.handbrake = true;
      const c = centerOf(car, spec);
      const inp = { cx: c.x, cz: c.z, heading: car.heading, v: 0, gear: 'P' as const, handbrake: true, engineOn: false };
      const checks = liftChecklist(L, spec, inp);
      expect(checks.filter((q) => !q.ok).map((q) => q.key), id).toEqual([]);
      const st = newLift();
      expect(liftUp(L, spec, { ...inp, engineOn: true }, st)).toBe(false); // 시동 ON 이면 거부
      expect(liftUp(L, spec, inp, st)).toBe(true);
      for (let i = 0; i < 20 * 60; i++) stepLift(L, st, 1 / 60);
      expect(st.phase).toBe('holding');
      expect(liftedPose(L, st)!.y).toBeCloseTo(L.maxHeight, 6);
      liftDown(st);
      for (let i = 0; i < 20 * 60; i++) stepLift(L, st, 1 / 60);
      expect(st.phase).toBe('idle');
      expect(st.locked).toBe(false);
      // 출차: 후진으로 문 밖까지
      const out = drivePath(m, spec, car, [[L.x, 0], [L.x, -8]], { speed: 1.2, lookahead: 3.5, maxTime: 120, reverse: true, goalRadius: 2.5 });
      expect(out.blocks, id).toEqual([]);
    });
  }
  it('기둥은 실제로 막는다: 20cm 이상 치우쳐 들어가면 조건 불충족, 0.9m 치우치면 기둥에 충돌', () => {
    const spec = getVehicle('suv-x6');
    const L = GARAGE_LIFT;
    const car = startState(m, spec, L.x + 0.9, 1.5, 0);
    const d = drivePath(m, spec, car, [[L.x + 0.9, L.z + 2]], { speed: 1.2, maxTime: 60, goalRadius: 0.3 });
    expect(d.reached).toBe(false);
    expect(d.blocks[0].id).toMatch(/lift-a-post/);
  });
});
