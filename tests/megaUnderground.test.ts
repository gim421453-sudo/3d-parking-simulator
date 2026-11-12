import { describe, expect, it } from 'vitest';
import { getMap, mapColliders } from '../src/maps';
import { B1_Y, MEGA_ROADS, MEGA_ZONES, UG_RAMP } from '../src/maps/mapMegaPark';
import { groundAt, headroomAt, rampMaxGrade, type RampSurface } from '../src/maps/terrain';
import { drivePath, startState } from '../src/sim/autodrive';
import { getVehicle } from '../src/vehicle/spec';

const M = getMap('megapark');
const T = M.terrain!;
const Z = UG_RAMP.z;

describe('megapark 지하주차장 = 실제 지하층(B1)', () => {
  it('B1 은 y=-3.2 에 있고(층 목록/주차칸/충돌체/미션 시작 위치), 지상에는 지하주차장 구조물이 없다', () => {
    expect(T.levels.some((l) => Math.abs(l.y - B1_Y) < 1e-9 && /B1/.test(l.name))).toBe(true);
    const ugSlots = M.slots.filter((s) => s.id.startsWith('ug:'));
    expect(ugSlots.length).toBe(32);
    for (const s of ugSlots) expect(s.y).toBeCloseTo(B1_Y, 9);
    const ugCols = mapColliders(M).filter((c) => c.id.startsWith('ug:'));
    expect(ugCols.length).toBeGreaterThan(30);
    for (const c of ugCols) {
      expect(c.y0).toBeLessThan(-0.3);
      expect(c.y0 + c.h).toBeLessThanOrEqual(0.001); // 지상(y>0)으로 튀어나온 지하 충돌체 없음
    }
    for (const ms of M.missions.filter((m) => m.id.startsWith('ug:'))) expect(ms.spawn!.y).toBeCloseTo(B1_Y, 9);
  });
  it('경사로: 길이 32m, 완화 구간 6m, 최대 경사 ≤ 13%, 꼭대기는 지상(0) · 바닥은 B1 과 높이가 이어진다', () => {
    const r = T.surfaces.find((s) => s.id === 'ug-ramp') as RampSurface;
    expect(r.length).toBe(32);
    expect(rampMaxGrade(r)).toBeLessThanOrEqual(0.13);
    expect(groundAt(T, UG_RAMP.topX + 0.5, Z, 0)).toBeCloseTo(0, 6); // 꼭대기 바깥: 지상
    expect(groundAt(T, UG_RAMP.topX - 0.5, Z, 0)!).toBeGreaterThan(-0.02); // 진입 직후 거의 0
    expect(groundAt(T, UG_RAMP.bottomX + 0.5, Z, B1_Y)!).toBeLessThan(B1_Y + 0.02);
    expect(groundAt(T, UG_RAMP.bottomX - 1, Z, B1_Y)).toBeCloseTo(B1_Y, 6); // B1 바닥
    // 트렌치: 지상 데크에 구멍이 있어 경사로 위에서 지상(0)으로 올라설 수 없다
    expect(groundAt(T, (UG_RAMP.topX + UG_RAMP.bottomX) / 2, Z, 0, 0.7)).toBeNull();
    expect(groundAt(T, (UG_RAMP.topX + UG_RAMP.bottomX) / 2, Z, -1.6)!).toBeCloseTo(-1.6, 1);
  });
  it('B1 천장 높이 2.9m (지상 슬래브 아랫면), 경사로 위는 뚫려 있다', () => {
    expect(headroomAt(T, 0, Z, B1_Y)).toBeCloseTo(2.9, 6);
    expect(headroomAt(T, (UG_RAMP.topX + UG_RAMP.bottomX) / 2, Z, -1.6)).toBe(Infinity);
  });
  it('도로 데이터: 지하 진입로가 동쪽 간선도로에서 경사로 꼭대기로 이어지고 경사로는 0 → B1', () => {
    const acc = MEGA_ROADS.find((r) => r.id === 'in-underground')!;
    const ramp = MEGA_ROADS.find((r) => r.id === 'ramp-underground')!;
    expect(acc.bx).toBeCloseTo(ramp.ax, 9);
    expect(ramp.y0).toBe(0);
    expect(ramp.y1).toBe(B1_Y);
    expect(MEGA_ZONES.find((z) => z.map.id === 'underground')!.dy).toBe(B1_Y);
  });

  const down: [number, number][] = [[80, 100], [79, 104], [76, Z], [60, Z], [UG_RAMP.topX, Z], [30, Z], [UG_RAMP.bottomX, Z], [4, Z], [-4, Z]];
  for (const id of ['sedan', 'suv-x6', 'coupe-m4']) {
    it(`실제 주행(${id}): 동쪽 간선도로 → 진입로 → 경사로 하강 → B1 통로 도착, 충돌 0, 피치가 서서히 변하고 층 순간이동 없음`, () => {
      const spec = getVehicle(id);
      for (const v of [2, 4]) {
        const car = startState(M, spec, 80, 88, 0, 0);
        const r = drivePath(M, spec, car, down, { speed: v, maxTime: 240, goalY: B1_Y });
        expect(r.blocks, `v${v}`).toEqual([]);
        expect(r.reached, `v${v}`).toBe(true);
        expect(r.car.y).toBeCloseTo(B1_Y, 6);
        expect(r.minY).toBeCloseTo(B1_Y, 6);
        expect(r.maxPitch).toBeLessThan(0.135); // 최대 경사 12.3% ≈ 0.123rad
        expect(r.maxStepDy).toBeLessThan(0.02); // 한 물리 스텝(≤0.12m 이동)에 2cm 미만 — 순간이동 없음
      }
    });
    it(`실제 주행(${id}): B1 → 경사로 상승 → 지상 진입로 → 동쪽 간선도로`, () => {
      const spec = getVehicle(id);
      const up: [number, number][] = [[UG_RAMP.bottomX, Z], [30, Z], [UG_RAMP.topX, Z], [60, Z], [72, Z], [79, Z + 6], [80, Z + 16]];
      const car = startState(M, spec, 2, Z, Math.PI / 2, B1_Y);
      const r = drivePath(M, spec, car, up, { speed: 3, maxTime: 240, goalY: 0 });
      expect(r.blocks).toEqual([]);
      expect(r.reached).toBe(true);
      expect(r.maxY).toBeCloseTo(0, 6);
    });
  }
  it('경사로 중간에서 정지 후 후진(R)으로 지상까지 되돌아 나올 수 있다', () => {
    const spec = getVehicle('suv-x6');
    const car = startState(M, spec, 60, Z, -Math.PI / 2, 0);
    const half = drivePath(M, spec, car, [[UG_RAMP.topX, Z], [30, Z]], { speed: 2, maxTime: 60, goalRadius: 3 });
    expect(half.blocks).toEqual([]);
    expect(half.car.y).toBeLessThan(-0.5);
    half.car.v = 0;
    const back = drivePath(M, spec, half.car, [[UG_RAMP.topX, Z], [56, Z], [62, Z]], { speed: 1.5, maxTime: 120, reverse: true, lookahead: 3.5, goalRadius: 2.5 });
    expect(back.blocks).toEqual([]);
    expect(back.car.y).toBeCloseTo(0, 6);
  });
  it('옹벽은 실제 충돌체: 경사로에서 옆으로 벗어나려 하면 벽에 막힌다(관통 없음, 지상으로 튀어 오르지 않음)', () => {
    const spec = getVehicle('sedan');
    const car = startState(M, spec, 34, Z, -Math.PI / 2, groundAt(T, 34, Z, -0.5)!);
    const r = drivePath(M, spec, car, [[28, Z + 8], [24, Z + 14]], { speed: 2, maxTime: 40 });
    expect(r.reached).toBe(false);
    expect(r.blocks[0].reason).toBe('collider');
    expect(r.blocks[0].id).toMatch(/^ugr-wall/);
    expect(r.car.y).toBeLessThan(-0.3);
  });
  it('층별 충돌 분리: 지상 차량은 B1 의 벽/기둥/주차 차량 위를 그대로 지나가고, B1 차량은 지상 장애물과 부딪히지 않는다', () => {
    const spec = getVehicle('suv-x6');
    // 지상: B1 바로 위를 가로지른다(북쪽 줄 주차 차량/기둥의 x,z 를 지남)
    const g = drivePath(M, spec, startState(M, spec, -30, Z + 6, Math.PI / 2, 0), [[-10, Z + 6], [8, Z + 6]], { speed: 4, maxTime: 60, goalY: 0 });
    expect(g.blocks).toEqual([]);
    expect(g.reached).toBe(true);
    // B1: 통로를 끝에서 끝까지 (지상의 도로/시설과 무관)
    const b = drivePath(M, spec, startState(M, spec, 6, Z, -Math.PI / 2, B1_Y), [[-6, Z - 0.3], [-14, Z - 0.3]], { speed: 2, maxTime: 60, goalY: B1_Y });
    expect(b.blocks).toEqual([]);
    expect(b.reached).toBe(true);
  });
  it('천장 제한: 차고 3.0m 차량은 B1 입구(슬래브 아래 2.9m)에서 막힌다(ceiling)', () => {
    const tall = { ...getVehicle('suv-x6'), height: 3.0 };
    const r = drivePath(M, tall, startState(M, tall, 60, Z, -Math.PI / 2, 0), [[UG_RAMP.topX, Z], [20, Z], [0, Z]], { speed: 2, maxTime: 90 });
    expect(r.reached).toBe(false);
    expect(r.blocks[0].reason).toBe('ceiling');
    expect(r.car.x).toBeGreaterThan(UG_RAMP.bottomX - 4);
  });
  it('B1 미션: 시작 위치가 B1 통로이고 차량이 바닥 위에 선다(충돌 없음)', () => {
    const ms = M.missions.find((m) => m.id === 'ug:ug-reverse')!;
    const spec = getVehicle('sedan');
    const car = startState(M, spec, ms.spawn!.x, ms.spawn!.z, ms.spawn!.heading, ms.spawn!.y);
    expect(car.y).toBeCloseTo(B1_Y, 6);
    const r = drivePath(M, spec, car, [[ms.spawn!.x - 8, ms.spawn!.z]], { speed: 2, maxTime: 30, goalY: B1_Y });
    expect(r.blocks).toEqual([]);
  });
});
