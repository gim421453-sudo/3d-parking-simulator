import { describe, expect, it } from 'vitest';
import { findVehicleCollision, type Collider } from '../src/core/geometry';
import { SpatialIndex } from '../src/core/spatial';
import { MAPS, getMap, mapColliders } from '../src/maps';
import { groundAt, headroomAt, rampMaxGrade, rampProfile, surfaceHeight, underbodyGap, type RampSurface, type Terrain } from '../src/maps/terrain';
import { arcPath, drivePath, startState } from '../src/sim/autodrive';
import { FULL_STEER_SPEED, maxSteerAt, minTurnRadius, spiralPassBand, sweptAnnulus } from '../src/vehicle/physics';
import { SELECTABLE_VEHICLES, getVehicle } from '../src/vehicle/spec';

describe('경사로 완화 구간(수직 곡선)', () => {
  it('완화 없음: 선형', () => {
    expect(rampProfile(0, 20)).toBe(0);
    expect(rampProfile(10, 20)).toBeCloseTo(0.5, 9);
    expect(rampProfile(20, 20)).toBe(1);
  });
  it('완화 있음: 양 끝 경사 0, 가운데 일정 경사, 연속/단조 증가, 대칭', () => {
    const L = 30;
    const e = 5;
    const d = 1e-4;
    expect((rampProfile(d, L, e) - rampProfile(0, L, e)) / d).toBeLessThan(1e-4);
    expect((rampProfile(L, L, e) - rampProfile(L - d, L, e)) / d).toBeLessThan(1e-4);
    const mid = (rampProfile(15 + d, L, e) - rampProfile(15, L, e)) / d;
    expect(mid).toBeCloseTo(1 / (L - e), 4);
    let prev = -1;
    for (let u = 0; u <= L; u += 0.25) {
      const f = rampProfile(u, L, e);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
      expect(f + rampProfile(L - u, L, e)).toBeCloseTo(1, 9);
    }
    expect(rampProfile(L, L, e)).toBeCloseTo(1, 9);
  });
  it('완화 구간이 있으면 진입 직후 피치(앞뒤 차축 높이차)가 작게 시작한다', () => {
    const base: RampSurface = { kind: 'ramp', id: 'r', x: 0, z: 0, rot: 0, length: 30, width: 4, y0: 0, y1: -3.2 };
    const eased: RampSurface = { ...base, ease: 5 };
    const wb = 2.85;
    const pitchAt = (r: RampSurface, front: number): number => Math.atan2((surfaceHeight(r, 0, front) ?? 0) - (surfaceHeight(r, 0, Math.max(0, front - wb)) ?? 0), wb);
    // 앞바퀴가 0.5m 들어갔을 때
    expect(Math.abs(pitchAt(eased, 0.5))).toBeLessThan(Math.abs(pitchAt(base, 0.5)) * 0.2);
    expect(rampMaxGrade(eased)).toBeCloseTo(3.2 / 25, 6);
  });
});

describe('천장 높이 / 하부 접촉', () => {
  const t: Terrain = {
    levels: [{ id: 'g', name: 'G', y: 0 }],
    surfaces: [
      { kind: 'deck', id: 'g', rect: { x: 0, z: 0, w: 100, d: 100 }, y: 0 },
      { kind: 'deck', id: 'up', rect: { x: 20, z: 0, w: 10, d: 10 }, y: 2.0, thickness: 0.3 },
    ],
    ceilings: [{ id: 'beam', rect: { x: -20, z: 0, w: 4, d: 10 }, y: 1.5 }],
  };
  it('데크 아랫면과 추가 천장까지의 여유', () => {
    expect(headroomAt(t, 0, 0, 0)).toBe(Infinity);
    expect(headroomAt(t, 20, 0, 0)).toBeCloseTo(1.7, 9);
    expect(headroomAt(t, -20, 0, 0)).toBeCloseTo(1.5, 9);
    expect(headroomAt(t, 20, 0, 2.0)).toBe(Infinity); // 그 데크 위에 있으면 천장 아님
  });
  it('차고 1.70m SUV 는 1.5m 보 아래를 지나가지 못하고(ceiling), 낮은 차는 통과', () => {
    const map = { ...getMap('tower'), id: 'x', terrain: t, obstacles: [], bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, slots: [], missions: [] };
    const suv = getVehicle('suv-x6');
    const r = drivePath(map, suv, startState(map, suv, -30, 0, Math.PI / 2), [[-10, 0]], { speed: 2, maxTime: 30 });
    expect(r.reached).toBe(false);
    expect(r.blocks[0].reason).toBe('ceiling');
    expect(r.car.x).toBeLessThan(-22);
    const low = { ...suv, height: 1.3 };
    expect(drivePath(map, low, startState(map, low, -30, 0, Math.PI / 2), [[-10, 0]], { speed: 2, maxTime: 30 }).reached).toBe(true);
  });
  it('뾰족한 마루(볼록 전환부)에서는 하부 여유가 음수, 평지/완만한 경사에서는 양수', () => {
    const crest: Terrain = {
      levels: [{ id: 'g', name: 'G', y: 0 }],
      surfaces: [
        { kind: 'ramp', id: 'up', x: 0, z: -4, rot: 0, length: 4, width: 6, y0: 0, y1: 1.6 },
        { kind: 'ramp', id: 'dn', x: 0, z: 0, rot: 0, length: 4, width: 6, y0: 1.6, y1: 0 },
      ],
    };
    // 앞축 z=+1.4, 뒷축 z=-1.4 (마루 z=0 을 걸침): 각 0.4*... 높이 1.04
    const yR = groundAt(crest, 0, -1.4, 1.0)!;
    const yF = groundAt(crest, 0, 1.4, 1.0)!;
    expect(underbodyGap(crest, 0, -1.4, yR, 0, 1.4, yF, 0.2)).toBeLessThan(0);
    const flat: Terrain = { levels: crest.levels, surfaces: [{ kind: 'deck', id: 'f', rect: { x: 0, z: 0, w: 20, d: 20 }, y: 0 }] };
    expect(underbodyGap(flat, 0, -1.4, 0, 0, 1.4, 0, 0.2)).toBeCloseTo(0.2, 9);
  });
  it('기존 다층 맵의 모든 경사로 전환부는 선택 가능한 모든 차량이 하부 접촉 없이 지난다(표본 주행)', () => {
    for (const m of MAPS) {
      if (!m.terrain) continue;
      for (const s of m.terrain.surfaces) {
        if (s.kind !== 'ramp') continue;
        const fx = Math.sin(s.rot);
        const fz = Math.cos(s.rot);
        for (const spec of SELECTABLE_VEHICLES) {
          for (let u = -spec.wheelbase; u <= s.length; u += 0.25) {
            const rx = s.x + fx * u;
            const rz = s.z + fz * u;
            const qx = rx + fx * spec.wheelbase;
            const qz = rz + fz * spec.wheelbase;
            const hint = s.y0 + (s.y1 - s.y0) * rampProfile(u + spec.wheelbase / 2, s.length, s.ease);
            const yR = groundAt(m.terrain, rx, rz, hint, 1.2);
            const yF = groundAt(m.terrain, qx, qz, hint, 1.2);
            if (yR === null || yF === null) continue;
            expect(underbodyGap(m.terrain, rx, rz, yR, qx, qz, yF, 0.2), `${m.id}/${s.id}/${spec.id}@${u.toFixed(2)}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('공간 인덱스(균일 격자)', () => {
  it('megapark: 조회 결과로 한 충돌 판정이 전수 검사와 항상 같다 (무작위 2000회, 여러 높이)', () => {
    const map = getMap('megapark');
    const all = mapColliders(map);
    const idx = new SpatialIndex(8);
    idx.rebuild(all);
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    let hits = 0;
    let candTotal = 0;
    const near: Collider[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = map.bounds.minX + rnd() * (map.bounds.maxX - map.bounds.minX);
      const z = map.bounds.minZ + rnd() * (map.bounds.maxZ - map.bounds.minZ);
      const y = [0, 3.2, 6.4, -3.2][i % 4];
      const obb = { x, z, rot: rnd() * 6.28, hw: 1.0, hl: 2.47 };
      idx.query(x, z, 6, near);
      candTotal += near.length;
      const a = findVehicleCollision(obb, all, y, 1.7);
      const b = findVehicleCollision(obb, near, y, 1.7);
      expect(!!b).toBe(!!a);
      if (a) hits++;
    }
    expect(hits).toBeGreaterThan(20);
    // 후보 수는 전체의 일부여야 한다(성능 근거)
    expect(candTotal / 2000).toBeLessThan(all.length * 0.1);
  });
  it('큰 충돌체(긴 벽)도 걸친 모든 칸에서 조회된다', () => {
    const wall: Collider = { kind: 'box', id: 'w', tag: 'wall', x: 0, z: 0, w: 100, d: 0.6, rot: 0.3, y0: 0, h: 2 };
    const idx = new SpatialIndex(8);
    idx.rebuild([wall]);
    for (let u = -48; u <= 48; u += 4) {
      const x = u * Math.cos(0.3);
      const z = -u * Math.sin(0.3);
      expect(idx.query(x, z, 1)).toContain(wall);
    }
    expect(idx.query(0, 40, 2).length).toBe(0);
  });
  it('sync: 목록이 바뀌면(길이/참조) 다시 만들고, 같으면 그대로', () => {
    const idx = new SpatialIndex();
    const list: Collider[] = [{ kind: 'cyl', id: 'a', tag: 'pillar', x: 1, z: 1, r: 0.3, y0: 0, h: 2 }];
    expect(idx.sync(list)).toBe(true);
    expect(idx.sync(list)).toBe(false);
    list.push({ kind: 'cyl', id: 'b', tag: 'pillar', x: 50, z: 50, r: 0.3, y0: 0, h: 2 });
    expect(idx.sync(list)).toBe(true);
    expect(idx.query(50, 50, 1).map((c) => c.id)).toEqual(['b']);
  });
});

describe('나선 램프: 원인 분석과 수정 (조향/치수)', () => {
  const suv = getVehicle('suv-x6');
  it('저속(≤2.5m/s)에서는 풀 조향, 그 위로는 줄어든다', () => {
    expect(maxSteerAt(suv, 0)).toBe(suv.maxSteer);
    expect(maxSteerAt(suv, 2)).toBe(suv.maxSteer);
    expect(maxSteerAt(suv, FULL_STEER_SPEED)).toBe(suv.maxSteer);
    expect(maxSteerAt(suv, 5)).toBeLessThan(suv.maxSteer);
    expect(maxSteerAt(suv, 33)).toBeLessThan(suv.maxSteer * 0.06);
  });
  it('정상 원선회 궤적: 안쪽 = R - 반폭, 바깥 = 앞 바깥 모서리', () => {
    const a = sweptAnnulus(suv, 5);
    expect(a.inner).toBeCloseTo(5 - suv.width / 2, 9);
    expect(a.outer).toBeCloseTo(Math.hypot(5 + suv.width / 2, suv.length - suv.rearOverhang), 9);
  });
  it('원인: 이전 타워 나선(r 3.4~7.0) + 이전 조향식은 SUV 통과 구간이 0.3m 미만이었다', () => {
    // 이전 조향식(2m/s 에서 0.573rad)의 최소 반경 4.60m, 기하 상한 4.85m
    const oldSteer = suv.maxSteer / (1 + (2 / 7) ** 2);
    const oldMinR = suv.wheelbase / Math.tan(oldSteer);
    const geo = spiralPassBand(suv, 3.4, 7.0, 0);
    expect(geo.hi - Math.max(geo.lo, oldMinR)).toBeLessThan(0.3);
    expect(geo.hi - Math.max(geo.lo, oldMinR)).toBeGreaterThan(0);
  });
  it('모든 맵의 모든 나선 램프: 선택 가능한 모든 차량의 통과 구간(벽 여유 0.15m 포함) ≥ 0.6m', () => {
    let n = 0;
    for (const m of MAPS) {
      for (const s of m.terrain?.surfaces ?? []) {
        if (s.kind !== 'spiral') continue;
        n++;
        for (const spec of SELECTABLE_VEHICLES) {
          const b = spiralPassBand(spec, s.r0, s.r1, 2.5, 0.15);
          expect(b.hi - b.lo, `${m.id}/${s.id}/${spec.id}`).toBeGreaterThanOrEqual(0.6);
          expect(minTurnRadius(spec, 2.5)).toBeLessThan(b.hi);
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(3); // tower, spiral, megapark(복사본들)
  });
});

describe('나선 램프 실제 주행(헤드리스, 게임과 같은 물리·충돌 코드)', () => {
  const tower = getMap('tower');
  const SP = tower.terrain!.surfaces.find((s) => s.kind === 'spiral')! as { cx: number; cz: number; r0: number; r1: number };
  const upPath = (Rp: number, zOff = 0): [number, number][] => {
    const p: [number, number][] = [];
    for (let x = 4; x <= 24; x += 1) p.push([x, SP.cz - Rp + zOff * Math.max(0, 1 - (x - 4) / 12)]);
    p.push(...arcPath(SP.cx, SP.cz, Rp, -Math.PI / 2 + 0.05, Math.PI));
    p.push([SP.cx - Rp, SP.cz - 1.2], [SP.cx - Rp + 0.2, SP.cz - 3.2]);
    return p;
  };
  it('타워 나선 상승: SUV/세단/쿠페 × 속도 1.5~3.5m/s × 경로 반경 3종 × 시작 횡오프셋 — 충돌 0, 3F 도달, 층 순간이동 없음', () => {
    let runs = 0;
    for (const id of ['suv-x6', 'sedan', 'coupe-m4']) {
      const spec = getVehicle(id);
      for (const v of [1.5, 2.0, 2.5, 3.5]) {
        for (const Rp of [4.7, 5.05, 5.4]) {
          for (const off of [-0.3, 0, 0.3]) {
            const car = startState(tower, spec, 2, SP.cz - Rp + off, Math.PI / 2, 3.2);
            const r = drivePath(tower, spec, car, upPath(Rp, off), { speed: v, maxTime: 150, goalY: 6.4 });
            runs++;
            expect(r.blocks, `${id} v${v} R${Rp} off${off}`).toEqual([]);
            expect(r.reached, `${id} v${v} R${Rp} off${off}`).toBe(true);
            expect(r.maxStepDy).toBeLessThan(0.05); // 한 스텝에 층이 바뀌지 않는다
            expect(r.maxPitch).toBeLessThan(0.25);
          }
        }
      }
    }
    expect(runs).toBe(108);
  });
  it('타워 나선 하강(3F→2F, 반대 방향 회전): SUV/세단/쿠페 — 충돌 0, 2F 도달', () => {
    for (const id of ['suv-x6', 'sedan', 'coupe-m4']) {
      const spec = getVehicle(id);
      for (const v of [1.5, 2.5]) {
        const Rp = 5.05;
        const p: [number, number][] = [[SP.cx - Rp, SP.cz - 1.0], ...arcPath(SP.cx, SP.cz, Rp, Math.PI, -Math.PI / 2), [18, SP.cz - Rp], [10, SP.cz - Rp]];
        const car = startState(tower, spec, SP.cx - Rp, SP.cz - 3.0, 0, 6.4);
        const r = drivePath(tower, spec, car, p, { speed: v, maxTime: 150, goalY: 3.2 });
        expect(r.blocks, `${id} v${v}`).toEqual([]);
        expect(r.reached, `${id} v${v}`).toBe(true);
        expect(r.minY).toBeCloseTo(3.2, 1);
      }
    }
  });
  it('커브 중 제동 후 재출발(저속 가속)해도 충돌 없이 올라간다', () => {
    const spec = getVehicle('suv-x6');
    const car = startState(tower, spec, 2, SP.cz - 5.05, Math.PI / 2, 3.2);
    const r = drivePath(tower, spec, car, upPath(5.05), { speed: 2, maxTime: 200, goalY: 6.4, brakeWindow: [14, 18] });
    expect(r.blocks).toEqual([]);
    expect(r.reached).toBe(true);
  });
  it('나선 중간에서 후진으로 내려와도(R) 충돌 없이 2F 로 돌아온다', () => {
    const spec = getVehicle('suv-x6');
    const car = startState(tower, spec, 2, SP.cz - 5.05, Math.PI / 2, 3.2);
    // 반 바퀴까지 올라간 뒤 정지
    const half = [...upPath(5.05).slice(0, 22 + Math.round((Math.PI * 0.9) / 0.06))];
    const up = drivePath(tower, spec, car, half, { speed: 2, maxTime: 100 });
    expect(up.blocks).toEqual([]);
    expect(up.car.y).toBeGreaterThan(4.0);
    up.car.v = 0;
    const back = [...half].reverse();
    // 후진 추종은 주시 거리가 짧으면(≤2.2m) 조향이 진동해 안쪽 벽에 닿는다 — 자동 조종기의 특성(물리 결함 아님). 주시 3m 이상에서 여러 속도로 확인.
    for (const [la, sp] of [[3, 1.0], [3, 1.5], [3.5, 1.2], [4, 1.5], [3, 2.0]] as const) {
      const dn = drivePath(tower, spec, { ...up.car }, back, { speed: sp, maxTime: 200, reverse: true, goalRadius: 2.5, lookahead: la });
      expect(dn.blocks, `la${la} v${sp}`).toEqual([]);
      expect(dn.reached).toBe(true);
      expect(dn.car.y).toBeCloseTo(3.2, 1);
    }
  });
  it('조향 최대(풀 락)로 돌면 안쪽 벽에 닿아 멈춘다 — 벽 충돌체가 실제로 동작(관통 없음)', () => {
    const spec = getVehicle('suv-x6');
    const car = startState(tower, spec, 20, SP.cz - 5.05, Math.PI / 2, 3.2);
    // 중심 쪽(안쪽 벽)을 향해 가는 경로
    const r = drivePath(tower, spec, car, [[SP.cx, SP.cz - 3.2], [SP.cx, SP.cz]], { speed: 2, maxTime: 60 });
    expect(r.reached).toBe(false);
    expect(r.blocks[0].reason).toBe('collider');
    expect(Math.hypot(r.car.x - SP.cx, r.car.z - SP.cz)).toBeGreaterThan(SP.r0 - 0.5);
  });
  it('spiral 맵(r 4.2~9.2): SUV/세단/쿠페 상승과 하강', () => {
    const map = getMap('spiral');
    const s = map.terrain!.surfaces.find((q) => q.kind === 'spiral')! as { cx: number; cz: number; r0: number; r1: number; th0: number; th1: number };
    const Rp = (s.r0 + s.r1) / 2 - 0.3;
    for (const id of ['suv-x6', 'sedan', 'coupe-m4']) {
      const spec = getVehicle(id);
      for (const v of [1.5, 3.0]) {
        const up = [[s.cx + Rp, s.cz - 10] as [number, number], ...arcPath(s.cx, s.cz, Rp, s.th0, s.th1), ...((): [number, number][] => { const ex = s.cx + Rp * Math.cos(s.th1); const ez = s.cz + Rp * Math.sin(s.th1); const hx = -Math.sin(s.th1); const hz = Math.cos(s.th1); return [[ex + hx * 3, ez + hz * 3], [ex + hx * 6, ez + hz * 6]]; })()];
        const car = startState(map, spec, s.cx + Rp, s.cz - 14, 0, 0);
        const r = drivePath(map, spec, car, up, { speed: v, maxTime: 200, goalY: 3.2 });
        expect(r.blocks, `${id} up v${v}`).toEqual([]);
        expect(r.reached, `${id} up v${v}`).toBe(true);
        // 하강: 착지 데크에서 반대로
        const ex = s.cx + Rp * Math.cos(s.th1);
        const ez = s.cz + Rp * Math.sin(s.th1);
        const hx = -Math.sin(s.th1);
        const hz = Math.cos(s.th1);
        const down: [number, number][] = [[ex + hx * 1, ez + hz * 1], ...arcPath(s.cx, s.cz, Rp, s.th1, s.th0), [s.cx + Rp, s.cz - 6], [s.cx + Rp, s.cz - 12]];
        const car2 = startState(map, spec, ex + hx * 5, ez + hz * 5, Math.atan2(-hx, -hz), 3.2);
        const d = drivePath(map, spec, car2, down, { speed: v, maxTime: 200, goalY: 0 });
        expect(d.blocks, `${id} down v${v}`).toEqual([]);
        expect(d.reached, `${id} down v${v}`).toBe(true);
      }
    }
  });
});
