import { describe, expect, it } from 'vitest';
import { getMap } from '../src/maps';
import { DEFAULT_LOW_RATIO, computeAreas, facilityAvail, recommend, regularSlots, slotOccupied, summaryLine, type AreaAvail, type FacilityAvail } from '../src/parking/availability';
import { makeFacility } from '../src/mech/facility';
import { newMachine } from '../src/mech/machine';
import { MechController } from '../src/mech/controller';

const F = (id: string, free: number, total = 22, status: FacilityAvail['status'] = 'available', x = 0, z = 0): FacilityAvail => ({ id, name: id, entrance: { x, z }, total, occupied: total - free, free, status, usable: status === 'available' || status === 'busy' });
const A = (id: string, regFree: number, regTotal: number, mech: FacilityAvail[] = [], x = 0, z = 0): AreaAvail => ({ id, label: id, regularTotal: regTotal, regularOccupied: regTotal - regFree, regularFree: regFree, mech, entrance: { x, z } });

describe('주차칸 점유/잔여 집계 (실제 맵 데이터)', () => {
  it('lot: 일반 칸 수 = 맵 슬롯 수, 빈 칸은 주차된 차가 없는 칸', () => {
    const m = getMap('lot');
    const [a] = computeAreas(m, []);
    expect(a.regularTotal).toBe(regularSlots(m).length);
    expect(a.regularOccupied + a.regularFree).toBe(a.regularTotal);
    // lot 은 n 줄 8칸(빈 2) + s 줄 6칸(빈 4) + 평행 1칸 → 빈 칸이 존재하고 모두 차지는 않았다
    expect(a.regularFree).toBeGreaterThan(0);
    expect(a.regularOccupied).toBeGreaterThan(0);
  });
  it('플레이어 차량이 빈 칸 안에 정차하면 그 칸이 점유로 센다', () => {
    const m = getMap('lot');
    const [a0] = computeAreas(m, []);
    const empty = regularSlots(m).find((s) => !slotOccupied(s, m.obstacles.filter((o) => o.tag === 'car')))!;
    const [a1] = computeAreas(m, [], [{ x: empty.x, z: empty.z }]);
    expect(a1.regularFree).toBe(a0.regularFree - 1);
  });
  it('mechpark: 기계식 팔레트/출구 칸은 일반 칸에서 제외되고 시설 정원 22', () => {
    const m = getMap('mechpark');
    const fac = m.mechFacilities![0];
    const c = new MechController(fac.floors, { x: fac.x, z: fac.z, yaw: fac.rotationY });
    const [a] = computeAreas(m, [{ cfg: fac, m: c.m }]);
    expect(a.regularTotal).toBe(0);
    expect(a.mech[0].total).toBe(22);
    expect(a.mech[0].free).toBe(22);
  });
  it('megapark: 구역별 독립 집계 — 기계식 시설 3기가 각 구역에 배정되고 합이 맞는다', () => {
    const m = getMap('megapark');
    const refs = m.mechFacilities!.map((cfg) => ({ cfg, m: new MechController(cfg.floors).m }));
    const areas = computeAreas(m, refs);
    expect(areas.length).toBe((m as unknown as { zones: unknown[] }).zones.length);
    expect(areas.reduce((s, a) => s + a.mech.length, 0)).toBe(3);
    expect(areas.find((a) => a.id === 'mechpark')!.mech.length).toBe(1);
    expect(areas.find((a) => a.id === 'outdoor')!.mech.length).toBe(2);
    // 구역 일반 칸 합 = 전체 일반 칸 (구역 밖 칸 없음)
    expect(areas.reduce((s, a) => s + a.regularTotal, 0)).toBe(regularSlots(m).length);
  });
});

describe('시설 상태 (이용 가능/작동 중/만차/고장/비상정지)', () => {
  const cfg = makeFacility({ id: 'f', name: 'F', x: 0, z: 0, floors: 3 });
  it('상태 분류', () => {
    const m = newMachine(3);
    expect(facilityAvail(cfg, m).status).toBe('available');
    m.phase = 'lifting';
    expect(facilityAvail(cfg, m).status).toBe('busy');
    expect(facilityAvail(cfg, m).usable).toBe(true);
    m.phase = 'estop';
    expect(facilityAvail(cfg, m).status).toBe('estop');
    expect(facilityAvail(cfg, m).usable).toBe(false);
    m.phase = 'waiting';
    m.fault = 'x';
    expect(facilityAvail(cfg, m).status).toBe('fault');
    m.fault = '';
    for (const k of Object.keys(m.slots)) m.slots[k] = { carId: 1, specId: 'sedan', mode: 'fwd', rel: { x: 0, z: 0, heading: 0 }, since: 0 };
    const full = facilityAvail(cfg, m);
    expect(full.status).toBe('full');
    expect(full.free).toBe(0);
    expect(full.total).toBe(4);
    expect(full.usable).toBe(false);
  });
});

describe('기계식 이용 추천 정책 (잔여율 20% 기준, 설정 가능)', () => {
  const me = { x: 0, z: 0 };
  it('충분(잔여율 > 20%): 둘 다 이용 가능, 기계식도 항상 이용 가능으로 표시', () => {
    const a = A('lot', 10, 20, [F('m', 22)]);
    const r = recommend(a, [a], me);
    expect(r.kind).toBe('both');
    expect(r.facility?.id).toBe('m');
  });
  it('경계: 정확히 20% 는 부족으로 본다(≤), 21% 는 충분', () => {
    expect(recommend(A('x', 4, 20, [F('m', 5)]), [], me).kind).toBe('prefer-mech');
    expect(recommend(A('x', 5, 20, [F('m', 5)]), [], me).kind).toBe('both');
    expect(DEFAULT_LOW_RATIO).toBe(0.2);
  });
  it('부족(≤20%): 기계식 우선 추천 + 시설명/잔여 슬롯 포함', () => {
    const a = A('lot', 2, 20, [F('타워', 7, 10)]);
    const r = recommend(a, [a], me);
    expect(r.kind).toBe('prefer-mech');
    expect(r.facility?.name).toBe('타워');
    expect(r.facility?.free).toBe(7);
    expect(r.headline).toContain('우선 추천');
  });
  it('임계값은 설정으로 바꿀 수 있다 (30% 로 올리면 25% 도 기계식 우선)', () => {
    const a = A('x', 5, 20, [F('m', 5)]);
    expect(recommend(a, [a], me, 0.2).kind).toBe('both');
    expect(recommend(a, [a], me, 0.3).kind).toBe('prefer-mech');
  });
  it('일반 칸 0: 이용 가능한 기계식으로 안내, 가장 가까운 시설 선택', () => {
    const a = A('lot', 0, 20, [F('far', 5, 22, 'available', 100, 0), F('near', 5, 22, 'available', 10, 0)]);
    const r = recommend(a, [a], me);
    expect(r.kind).toBe('only-mech');
    expect(r.facility?.id).toBe('near');
  });
  it('작동 중(busy)인 시설도 안내 대상이고, 만차/고장/비상정지는 제외', () => {
    const a = A('lot', 0, 20, [F('full', 0, 22, 'full'), F('estop', 5, 22, 'estop'), F('fault', 5, 22, 'fault'), F('busy', 5, 22, 'busy')]);
    const r = recommend(a, [a], me);
    expect(r.usable.map((f) => f.id)).toEqual(['busy']);
    expect(r.facility?.id).toBe('busy');
  });
  it('기계식도 만차: 다른 구역의 이용 가능한 주차장으로 안내(가장 가까운 구역)', () => {
    const here = A('here', 0, 20, [F('m', 0, 22, 'full')]);
    const near = A('near', 3, 20, [], 30, 0);
    const far = A('far', 9, 20, [], 300, 0);
    const r = recommend(here, [here, far, near], me);
    expect(r.kind).toBe('other-area');
    expect(r.area?.id).toBe('near');
  });
  it('어디에도 자리가 없으면 none', () => {
    const here = A('here', 0, 20, [F('m', 0, 22, 'full')]);
    const r = recommend(here, [here, A('o', 0, 10, [F('m2', 0, 10, 'full')])], me);
    expect(r.kind).toBe('none');
  });
  it('구역은 독립: 한 구역이 만차여도 다른 구역 판정에는 영향이 없다', () => {
    const a = A('a', 0, 10, [F('ma', 0, 10, 'full')]);
    const b = A('b', 9, 10, [F('mb', 10, 10)]);
    expect(recommend(b, [a, b], me).kind).toBe('both');
    expect(recommend(a, [a, b], me).kind).toBe('other-area');
  });
  it('일반 칸이 적고 기계식 불가이면 일반 칸만 안내(regular-only)', () => {
    const a = A('x', 1, 20, [F('m', 0, 22, 'full')]);
    expect(recommend(a, [a], me).kind).toBe('regular-only');
  });
  it('요약 문자열에는 거리 숫자(m)가 없다', () => {
    const s = summaryLine(A('x', 3, 20, [F('m', 5, 22)]));
    expect(s).toBe('일반 3/20 · 기계식 5/22');
    expect(s).not.toMatch(/\d\s*m\b/);
  });
});
