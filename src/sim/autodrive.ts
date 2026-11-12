import { SpatialIndex } from '../core/spatial';
import { mapColliders } from '../maps/types';
import type { MapData } from '../maps/types';
import { groundAt } from '../maps/terrain';
import { createVehicleState, substepCount, type VehicleState } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';
import { stepVehicleInWorld, type BlockReason } from '../vehicle/worldStep';

/**
 * 헤드리스 자동 주행 (v0.5.4): 브라우저 없이 **게임과 같은 물리/지형/충돌 코드**(`stepVehicleInWorld`, 1/120s + 서브스텝)로
 * 경로를 따라 실제로 주행해 본다. 맵 자동 검사(경사로/나선/도로 연결/차종별 통과)에 쓴다.
 * 조향은 순수 추종(pure pursuit: 전방 주시점 방향 오차 × 게인), 속도는 목표 속도 유지(가속/브레이크).
 */
export interface DriveOptions {
  speed: number;
  /** 전방 주시 거리(m) */
  lookahead?: number;
  /** 최대 시뮬레이션 시간(s) */
  maxTime?: number;
  /** 후진 주행(R) */
  reverse?: boolean;
  /** 마지막 점에서 이 거리 안이면 도착 */
  goalRadius?: number;
  /** 막혀도 계속 시도할지(기본: 첫 차단에서 중단) */
  continueOnBlock?: boolean;
  /** 경로 진행 중 강제 브레이크 구간 테스트: [시작 시간, 끝 시간] */
  brakeWindow?: [number, number];
  /** 조향 게인 */
  gain?: number;
  /** 도착 시 차량 높이(층) 조건 */
  goalY?: number;
}
export interface DriveBlock {
  reason: BlockReason;
  id: string;
  x: number;
  z: number;
  y: number;
  t: number;
}
export interface DriveResult {
  reached: boolean;
  blocks: DriveBlock[];
  time: number;
  car: VehicleState;
  /** 주행 중 높이 범위/최대 피치/최대 높이 변화율(층 순간이동 검출) */
  minY: number;
  maxY: number;
  maxPitch: number;
  maxStepDy: number;
  /** 지나간 경로 길이 */
  dist: number;
}

const STEP = 1 / 120;

export function startState(map: MapData, spec: VehicleSpec, cx: number, cz: number, heading: number, y = 0): VehicleState {
  const car = createVehicleState(spec, cx, cz, heading);
  if (map.terrain) {
    const wb = spec.wheelbase;
    const yR = groundAt(map.terrain, car.x, car.z, y) ?? y;
    const yF = groundAt(map.terrain, car.x + Math.sin(heading) * wb, car.z + Math.cos(heading) * wb, yR) ?? yR;
    car.y = yR;
    car.pitch = Math.atan2(yF - yR, wb);
    car.slope = Math.sin(car.pitch);
  } else car.y = y;
  return car;
}

export function drivePath(map: MapData, spec: VehicleSpec, car: VehicleState, path: readonly (readonly [number, number])[], o: DriveOptions): DriveResult {
  const index = new SpatialIndex(8);
  const all = mapColliders(map);
  index.rebuild(all);
  let near = index.query(car.x, car.z, 14);
  let ncx = car.x;
  let ncz = car.z;
  const look = o.lookahead ?? 3;
  const goalR = o.goalRadius ?? 1.6;
  const gain = o.gain ?? 1.6;
  const rev = !!o.reverse;
  const blocks: DriveBlock[] = [];
  car.gear = rev ? 'R' : 'D';
  car.handbrake = false;
  let idx = 0;
  let t = 0;
  let minY = car.y;
  let maxY = car.y;
  let maxPitch = 0;
  let maxStepDy = 0;
  let dist = 0;
  const maxT = o.maxTime ?? 300;
  const goal = path[path.length - 1];
  const levelAware = !!(map.terrain || map.mech);
  let reached = false;
  while (t < maxT) {
    // 기준점: 전진은 차체 중심, 후진은 뒷축
    const off = rev ? 0 : spec.length / 2 - spec.rearOverhang;
    const cx = car.x + Math.sin(car.heading) * off;
    const cz = car.z + Math.cos(car.heading) * off;
    while (idx < path.length - 1 && Math.hypot(path[idx][0] - cx, path[idx][1] - cz) < look) idx++;
    const [tx, tz] = path[idx];
    // 도착: 경로의 마지막 점을 주시하는 단계(앞선 점을 모두 지남)에서 목표 반경 안 + (지정 시) 목표 높이
    if (idx === path.length - 1 && Math.hypot(goal[0] - cx, goal[1] - cz) < goalR && (o.goalY === undefined || Math.abs(car.y - o.goalY) < 0.3)) {
      reached = true;
      break;
    }
    const dirH = rev ? car.heading + Math.PI : car.heading;
    let err = Math.atan2(tx - car.x, tz - car.z) - dirH;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const steerCmd = Math.max(-1, Math.min(1, (err * gain) / spec.maxSteer)) * (rev ? -1 : 1);
    const braking = o.brakeWindow && t >= o.brakeWindow[0] && t <= o.brakeWindow[1];
    const vin = { throttle: !braking && Math.abs(car.v) < o.speed ? 1 : 0, brake: braking ? 1 : Math.abs(car.v) > o.speed * 1.25 ? 0.5 : 0, steerInput: steerCmd };
    const n = substepCount(car.v, STEP);
    let stop = false;
    for (let k = 0; k < n; k++) {
      const dx = car.x - ncx;
      const dz = car.z - ncz;
      if (dx * dx + dz * dz > 9) {
        near = index.query(car.x, car.z, 14);
        ncx = car.x;
        ncz = car.z;
      }
      const py = car.y;
      const px = car.x;
      const pz = car.z;
      const r = stepVehicleInWorld(car, vin, spec, { terrain: map.terrain, bounds: map.bounds, colliders: near, levelAware, slide: false }, STEP / n);
      maxStepDy = Math.max(maxStepDy, Math.abs(car.y - py));
      dist += Math.hypot(car.x - px, car.z - pz);
      if (r.blocked && Math.abs(r.prevV) > 0.05) {
        blocks.push({ reason: r.reason, id: r.hit ? r.hit.id : r.reason, x: car.x, z: car.z, y: car.y, t });
        if (!o.continueOnBlock) stop = true;
        break;
      }
    }
    minY = Math.min(minY, car.y);
    maxY = Math.max(maxY, car.y);
    maxPitch = Math.max(maxPitch, Math.abs(car.pitch));
    t += STEP;
    if (stop) break;
  }
  return { reached, blocks, time: t, car, minY, maxY, maxPitch, maxStepDy, dist };
}

/** 원호 경로 점열 (중심, 반경, 각도 구간) — 나선 램프 주행용. x = cx + r·cosθ, z = cz + r·sinθ */
export function arcPath(cx: number, cz: number, r: number, th0: number, th1: number, step = 0.06): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.max(2, Math.ceil(Math.abs(th1 - th0) / step));
  for (let i = 0; i <= n; i++) {
    const th = th0 + ((th1 - th0) * i) / n;
    out.push([cx + r * Math.cos(th), cz + r * Math.sin(th)]);
  }
  return out;
}
