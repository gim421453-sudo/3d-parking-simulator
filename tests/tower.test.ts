import { describe, expect, it } from 'vitest';
import { findVehicleCollision } from '../src/core/geometry';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { MAP_TOWER, TOWER_TERRAIN } from '../src/maps/mapTower';
import { ceilingAbove, groundAt, levelAt, surfaceHeight } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { evaluateParking } from '../src/mission/parking';
import { centerOf, createVehicleState, obbOf, stepVehicle, type VehicleState } from '../src/vehicle/physics';
import { getVehicle, VEHICLES } from '../src/vehicle/spec';

const colliders = mapColliders(MAP_TOWER);
const T = TOWER_TERRAIN;

interface Result {
  maxY: number;
  collisions: number;
  offGround: number;
  reached: boolean;
  steps: number;
  car: VehicleState;
}
const place = (specId: string, x: number, z: number, h: number, y: number): { spec: ReturnType<typeof getVehicle>; car: VehicleState } => {
  const spec = getVehicle(specId);
  const car = createVehicleState(spec, x, z, h);
  const wb = spec.wheelbase;
  const yR = groundAt(T, car.x, car.z, y) ?? y;
  const yF = groundAt(T, car.x + Math.sin(h) * wb, car.z + Math.cos(h) * wb, yR) ?? yR;
  car.y = yR;
  car.pitch = Math.atan2(yF - yR, wb);
  car.slope = Math.sin(car.pitch);
  car.gear = 'D';
  return { spec, car };
};
/** Game.physicsStep 과 같은 순서의 한 스텝. 충돌/지면 이탈이면 복원 */
const step = (spec: ReturnType<typeof getVehicle>, car: VehicleState, vin: { throttle: number; brake: number; steerInput: number }, dt: number): 'ok' | 'hit' | 'off' => {
  const px = car.x, pz = car.z, ph = car.heading, py = car.y, pp = car.pitch, ps = car.slope;
  stepVehicle(car, vin, spec, dt);
  const wb = spec.wheelbase;
  const yR = groundAt(T, car.x, car.z, py);
  const yF = groundAt(T, car.x + Math.sin(car.heading) * wb, car.z + Math.cos(car.heading) * wb, py);
  let st: 'ok' | 'hit' | 'off' = 'ok';
  if (yR === null || yF === null) st = 'off';
  else {
    car.y = yR;
    car.pitch = Math.atan2(yF - yR, wb);
    car.slope = Math.sin(car.pitch);
    if (findVehicleCollision(obbOf(car, spec), colliders, car.y, spec.height)) st = 'hit';
  }
  if (st !== 'ok') {
    car.x = px; car.z = pz; car.heading = ph; car.y = py; car.pitch = pp; car.slope = ps; car.v = 0;
  }
  return st;
};
/** 순수 추종(pure pursuit)으로 경로(월드 xz 점열)를 따라 주행 */
const drive = (specId: string, start: { x: number; z: number; h: number; y: number }, path: [number, number][], goal: (car: VehicleState) => boolean, speed = 2.2, maxSec = 160): Result => {
  const { spec, car } = place(specId, start.x, start.z, start.h, start.y);
  const dt = 1 / 120;
  let idx = 0;
  let collisions = 0;
  let offGround = 0;
  let maxY = car.y;
  let steps = 0;
  let wasHit = false;
  for (let t = 0; t < maxSec; t += dt, steps++) {
    const c = centerOf(car, spec);
    // 현재 위치에 가까운 경로점 이후에서 lookahead 점 선택
    while (idx < path.length - 1 && Math.hypot(path[idx][0] - c.x, path[idx][1] - c.z) < 3.0) idx++;
    const [tx, tz] = path[idx];
    const dx = tx - car.x;
    const dz = tz - car.z;
    let err = Math.atan2(dx, dz) - car.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const steerInput = Math.max(-1, Math.min(1, (err * 1.6) / spec.maxSteer));
    const throttle = car.v < speed ? 1 : 0;
    const r = step(spec, car, { throttle, brake: 0, steerInput }, dt);
    if (r === 'hit') { if (!wasHit) collisions++; wasHit = true; } else wasHit = false;
    if (r === 'off') offGround++;
    maxY = Math.max(maxY, car.y);
    if (goal(car)) return { maxY, collisions, offGround, reached: true, steps, car };
  }
  return { maxY, collisions, offGround, reached: false, steps, car };
};

describe('주차타워 지형/지면', () => {
  it('3개 층(1F/2F/3F), 층고 3.2m, 직선 경사로 14.5% 이하, 나선 경사로 14% 이하', () => {
    expect(T.levels.map((l) => l.name)).toEqual(['1F', '2F', '3F']);
    expect(T.levels.map((l) => l.y)).toEqual([0, 3.2, 6.4]);
    const ramp = T.surfaces.find((s) => s.kind === 'ramp')!;
    if (ramp.kind === 'ramp') expect((ramp.y1 - ramp.y0) / ramp.length).toBeLessThan(0.15);
    const sp = T.surfaces.find((s) => s.kind === 'spiral')!;
    if (sp.kind === 'spiral') {
      const arc = Math.abs(sp.th1 - sp.th0) * ((sp.r0 + sp.r1) / 2);
      expect((sp.y1 - sp.y0) / arc).toBeLessThan(0.14);
    }
  });
  it('같은 평면 좌표의 여러 층 중 차량 높이에 가장 가까운 층을 고른다 (층 점프 방지)', () => {
    expect(groundAt(T, 5, 0, 0)).toBe(0);
    expect(groundAt(T, 5, 0, 3.2)).toBe(3.2);
    expect(groundAt(T, 5, 0, 6.4)).toBe(6.4);
    expect(groundAt(T, 5, 0, 1.6)).toBeNull(); // 허공(층 사이)에는 올라설 면이 없다
    expect(levelAt(T, 3.0).name).toBe('2F');
  });
  it('경사로 높이는 시작에서 끝까지 선형, 나선은 각도에 따라 선형', () => {
    const r = T.surfaces.find((s) => s.id === 'ramp-r1')!;
    expect(surfaceHeight(r, -30, 0)).toBeCloseTo(0, 6);
    expect(surfaceHeight(r, -19, 0)).toBeCloseTo(1.6, 6);
    expect(surfaceHeight(r, -8, 0)).toBeCloseTo(3.2, 6);
    expect(surfaceHeight(r, -19, 3)).toBeNull(); // 폭 밖
    const sp = T.surfaces.find((s) => s.id === 'spiral-s1')!;
    expect(surfaceHeight(sp, 24, 5.2 - 5.2)).toBeCloseTo(3.2, 3); // θ=-90° 시작
    expect(surfaceHeight(sp, 24 - 5.2, 5.2)).toBeCloseTo(6.4, 3); // θ=180° 끝
    expect(surfaceHeight(sp, 24, 5.2)).toBeNull(); // 중심(코어)
  });
  it('천장(위층 바닥) 아랫면: 1F 통로 위는 2F 바닥, 옥상 위는 없음', () => {
    expect(ceilingAbove(T, 5, 0, 0.5)).toBeCloseTo(2.9, 6);
    expect(ceilingAbove(T, 5, 0, 6.5)).toBe(Infinity);
  });
});

describe('주차타워 실제 주행 (물리 + 지면 + 층별 충돌, 순수 추종 시뮬레이션)', () => {
  const ramp: [number, number][] = [];
  for (let x = -33; x <= 6; x += 1) ramp.push([x, 0]);
  it('직선 경사로: 1F 입구에서 출발해 충돌/이탈 없이 2F(y=3.2)에 도달 (X6, 세단, 소형)', () => {
    for (const id of ['suv-x6', 'sedan', 'compact']) {
      const r = drive(id, { x: -33, z: 0, h: Math.PI / 2, y: 0 }, ramp, (c) => c.x > 2 && Math.abs(c.y - 3.2) < 0.05);
      expect(r.reached, `${id} 도달`).toBe(true);
      expect(r.collisions, `${id} 충돌`).toBe(0);
      expect(r.offGround, `${id} 이탈`).toBe(0);
      expect(r.maxY).toBeGreaterThan(3.15);
    }
  });
  it('나선형 램프: 2F 통로에서 출발해 충돌/이탈 없이 3F(y=6.4) 착지 덱에 도달 (X6, 세단)', () => {
    const path: [number, number][] = [];
    for (let x = 14; x <= 24; x += 1) path.push([x, 0]);
    const sp = TOWER_TERRAIN.surfaces.find((s) => s.kind === 'spiral')!;
    if (sp.kind !== 'spiral') throw new Error();
    const rm = (sp.r0 + sp.r1) / 2;
    for (let th = sp.th0 + 0.05; th <= sp.th1; th += 0.06) path.push([sp.cx + rm * Math.cos(th), sp.cz + rm * Math.sin(th)]);
    path.push([sp.cx - rm, sp.cz - 1.2]);
    path.push([sp.cx - rm + 0.2, sp.cz - 3.2]);
    for (const id of ['suv-x6', 'sedan']) {
      const r = drive(id, { x: 14, z: 0, h: Math.PI / 2, y: 3.2 }, path, (c) => c.y > 6.35 && c.z < 4, 2.0, 200);
      expect(r.reached, `${id} 도달 (y=${r.car.y.toFixed(2)} x=${r.car.x.toFixed(1)} z=${r.car.z.toFixed(1)})`).toBe(true);
      expect(r.collisions, `${id} 충돌`).toBe(0);
      expect(r.offGround, `${id} 이탈`).toBe(0);
    }
  });
  it('경사로 위 차량 자세: 오르막에서 피치가 양수(코가 위), 평지에서는 0', () => {
    const { car } = place('suv-x6', -19, 0, Math.PI / 2, 1.6);
    expect(car.pitch).toBeGreaterThan(0.12);
    expect(car.pitch).toBeLessThan(0.16);
    const flat = place('suv-x6', 5, 0, Math.PI / 2, 0).car;
    expect(Math.abs(flat.pitch)).toBeLessThan(1e-9);
  });
  it('경사로 정지/재출발/제동: 브레이크 없이 두면 뒤로 구르고, 주차 브레이크·풋브레이크는 정지 유지, 다시 가속하면 재출발', () => {
    const { spec, car } = place('suv-x6', -22, 0, Math.PI / 2, 0.9);
    // N 기어: 중력만으로 뒤로 굴러 내려간다
    car.gear = 'N';
    car.v = 0;
    for (let i = 0; i < 240; i++) step(spec, car, { throttle: 0, brake: 0, steerInput: 0 }, 1 / 120);
    expect(car.v).toBeLessThan(-0.5);
    // 풋브레이크로 정지 후 유지
    for (let i = 0; i < 360; i++) step(spec, car, { throttle: 0, brake: 1, steerInput: 0 }, 1 / 120);
    expect(Math.abs(car.v)).toBeLessThan(0.05);
    const x0 = car.x;
    for (let i = 0; i < 240; i++) step(spec, car, { throttle: 0, brake: 1, steerInput: 0 }, 1 / 120);
    expect(Math.abs(car.x - x0)).toBeLessThan(0.05);
    // 주차 브레이크 유지
    car.handbrake = true;
    car.v = 0;
    const x1 = car.x;
    for (let i = 0; i < 240; i++) step(spec, car, { throttle: 0, brake: 0, steerInput: 0 }, 1 / 120);
    expect(Math.abs(car.x - x1)).toBeLessThan(0.05);
    // 재출발: D + 가속
    car.handbrake = false;
    car.gear = 'D';
    const xs = car.x;
    for (let i = 0; i < 600; i++) step(spec, car, { throttle: 1, brake: 0, steerInput: 0 }, 1 / 120);
    expect(car.x).toBeGreaterThan(xs + 1.0);
    expect(car.y).toBeGreaterThan(0.9);
  });
  it('경사로 이탈/난간: 측벽을 향해 조향하면 막히고(충돌) 허공으로 떨어지지 않는다', () => {
    const { spec, car } = place('suv-x6', -20, 0, Math.PI / 2, 1.5);
    let hits = 0;
    let off = 0;
    for (let i = 0; i < 1500; i++) {
      const r = step(spec, car, { throttle: 1, brake: 0, steerInput: 1 }, 1 / 120);
      if (r === 'hit') hits++;
      if (r === 'off') off++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(Math.abs(car.z)).toBeLessThan(2.4);
    expect(off).toBe(0);
  });
});

describe('주차타워 층별 충돌/센서/미션', () => {
  it('다른 층의 같은 평면 좌표 물체와는 충돌하지 않는다', () => {
    const spec = getVehicle('suv-x6');
    // 1F 슬롯(tw1-n-3, 비어 있음) 위치에 2F 주차 차량이 있지만 1F 의 차량은 충돌하지 않는다
    const s = MAP_TOWER.slots.find((x) => x.id === 'tw1-n-3')!;
    const car = createVehicleState(spec, s.x, s.z, s.dir + Math.PI);
    expect(findVehicleCollision(obbOf(car, spec), colliders, 0, spec.height)).toBeNull();
    // 같은 위치를 층 구분 없이 검사하면 위층 차량과 겹친다 (= 층 구분이 없던 기존 방식은 틀린 충돌을 만든다)
    expect(findVehicleCollision(obbOf(car, spec), colliders)).not.toBeNull();
    // 2F 에서 같은 (x,z) 의 2F 차량(tw2-n-3)과는 충돌
    const car2 = createVehicleState(spec, s.x, s.z, s.dir + Math.PI);
    expect(findVehicleCollision(obbOf(car2, spec), colliders, 3.2, spec.height)).not.toBeNull();
  });
  it('센서는 다른 층 장애물을 감지하지 않고 같은 층 장애물만 감지', () => {
    const spec = getVehicle('suv-x6');
    const cfg = { ...DEFAULT_SENSOR_CONFIG, collectRays: false };
    // 1F 통로 중앙에서 보면 2F/3F 주차 차량은 같은 평면이지만 감지되지 않아야 한다
    const slotX = -1.4;
    const p1 = { x: slotX, z: 0, heading: Math.PI / 2, y: 0 };
    const s1 = readSensors(p1, spec.sensors, spec.sensorHeight, colliders, cfg);
    const p2 = { ...p1, y: 3.2 };
    const s2 = readSensors(p2, spec.sensors, spec.sensorHeight, colliders, cfg);
    // 층마다 자기 층 차량(좌우 6.4m 떨어진 슬롯)이 있으므로 둘 다 좌/우 감지 거리는 같은 값(대칭 배치)
    expect(s1.groupMin.left).toBe(s2.groupMin.left);
    // 높이를 층 사이(1.6m)에 두면 어느 층 차량도 감지되지 않는다
    const sMid = readSensors({ ...p1, y: 1.6 }, spec.sensors, spec.sensorHeight, colliders, cfg);
    expect(sMid.groupMin.left).toBeNull();
    expect(sMid.groupMin.right).toBeNull();
  });
  it('주차 성공 판정은 층(높이)도 확인: 1F 에서 2F 슬롯 위치로는 성공 불가', () => {
    const slot = MAP_TOWER.slots.find((x) => x.id === 'tw2-s-4')!;
    const spec = getVehicle('sedan');
    const heading = slot.dir;
    const car = createVehicleState(spec, slot.x, slot.z, heading);
    const c = centerOf(car, spec);
    const base = { x: c.x, z: c.z, heading, length: spec.length, width: spec.width };
    expect(evaluateParking({ ...base, y: 3.2 }, slot, 'perpendicular-front').poseOk).toBe(true);
    expect(evaluateParking({ ...base, y: 0 }, slot, 'perpendicular-front').poseOk).toBe(false);
    expect(evaluateParking({ ...base, y: 6.4 }, slot, 'perpendicular-front').levelOk).toBe(false);
  });
  it('모든 미션 목표 칸에 모든 차량이 규정 자세로 들어갈 수 있고(해당 층 기준) 시작 위치가 막히지 않는다', () => {
    for (const m of MAP_TOWER.missions) {
      const slot = MAP_TOWER.slots.find((s) => s.id === m.slotId)!;
      expect(slot.y).toBeDefined();
      for (const v of VEHICLES) {
        const heading = m.kind === 'perpendicular-reverse' ? slot.dir + Math.PI : slot.dir;
        const car = createVehicleState(v, slot.x, slot.z, heading);
        expect(findVehicleCollision(obbOf(car, v), colliders, slot.y, v.height), `${m.id}/${v.id}`).toBeNull();
        const c = centerOf(car, v);
        expect(evaluateParking({ x: c.x, z: c.z, heading, length: v.length, width: v.width, y: slot.y }, slot, m.kind).poseOk, `${m.id}/${v.id}`).toBe(true);
        const sp = m.spawn ?? MAP_TOWER.spawn;
        const sc = createVehicleState(v, sp.x, sp.z, sp.heading);
        expect(findVehicleCollision(obbOf(sc, v), colliders, sp.y ?? 0, v.height), `${m.id}/${v.id} spawn`).toBeNull();
      }
    }
  });
  it('임시 레이아웃 표시 (최종 확정 맵 아님)', () => {
    expect(MAP_TOWER.provisional).toBe(true);
    expect(MAP_TOWER.name).toContain('임시');
  });
});
