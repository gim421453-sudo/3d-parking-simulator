import { GROUND_CLEARANCE, findVehicleCollision, type Collider } from '../core/geometry';
import { groundAt, headroomAt, underbodyGap, type Terrain } from '../maps/terrain';
import { centerOf, obbOf, stepVehicle, type VehicleInput, type VehicleState } from './physics';
import type { VehicleSpec } from './spec';

/**
 * 차량 한 스텝 + 월드(지형/경계/충돌체) 제약 — 게임 루프와 헤드리스 검사(맵 자동 주행 검사)가 **같은 코드**를 쓴다 (v0.5.4).
 *  1. 차량 물리 적분(stepVehicle)
 *  2. 다층/경사: 앞·뒤 차축 아래 지면으로 높이/피치 결정. 올라설 면이 없으면 이동 불가.
 *  3. 천장 높이(위층 데크 아랫면/보) < 차고 이면 이동 불가, 볼록 전환부에서 하부가 닿으면 이동 불가.
 *  4. 충돌체(현재 높이 구간과 겹치는 것만) 검사. slide 가 켜져 있으면 접촉면을 따라 미끄러짐을 시도.
 *  5. 막히면 이전 자세로 복원 + 속도 0.
 */
export interface WorldEnv {
  terrain?: Terrain;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 검사할 충돌체(전체 또는 공간 인덱스로 추린 주변 목록) */
  colliders: readonly Collider[];
  /** 높이 구간을 반영해 충돌을 검사한다(다층/기계식 맵) */
  levelAware: boolean;
  /** 접촉면을 따라 미끄러짐 허용(기계식 맵의 볼라드/가이드) */
  slide?: boolean;
  /**
   * 충돌 파손 처리(v0.6.0, 게임에서만): 부딪힌 충돌체와 (겹친 새 자세의) 차량을 받아 결과를 돌려준다.
   * 'pass' = 장애물이 부서지거나 밀려나 차량이 계속 진행(속도 v), 'block' = 막힘(이전 자세 복원, 속도 v — 빠른 충돌은 튕김).
   * 없으면(헤드리스 검사) 이전처럼 막히고 속도 0.
   */
  impact?: (hit: Collider, car: VehicleState, prevV: number) => { action: 'block' | 'pass'; v: number };
}
export interface ImpactEvent {
  hit: Collider;
  action: 'block' | 'pass';
}
export type BlockReason = '' | 'collider' | 'edge' | 'ceiling' | 'underbody';
export interface WorldStepResult {
  blocked: boolean;
  reason: BlockReason;
  hit: Collider | null;
  /** 스텝 전 속도 (충돌 판정/카운트용) */
  prevV: number;
  slid: boolean;
  /** 이번 스텝의 파손 처리 결과(impact 가 있을 때) */
  impacts: ImpactEvent[];
}

export function stepVehicleInWorld(car: VehicleState, vin: VehicleInput, spec: VehicleSpec, env: WorldEnv, dt: number): WorldStepResult {
  const px = car.x;
  const pz = car.z;
  const ph = car.heading;
  const pv = car.v;
  const py = car.y;
  const ppitch = car.pitch;
  const pslope = car.slope;
  stepVehicle(car, vin, spec, dt);
  let reason: BlockReason = '';
  if (env.terrain) {
    const wb = spec.wheelbase;
    const fx = car.x + Math.sin(car.heading) * wb;
    const fz = car.z + Math.cos(car.heading) * wb;
    const yR = groundAt(env.terrain, car.x, car.z, py);
    const yF = groundAt(env.terrain, fx, fz, py);
    if (yR === null || yF === null) reason = 'edge';
    else {
      car.y = yR;
      car.pitch = Math.atan2(yF - yR, wb);
      car.slope = Math.sin(car.pitch);
      if (Math.min(headroomAt(env.terrain, car.x, car.z, yR), headroomAt(env.terrain, fx, fz, yF)) < spec.height) reason = 'ceiling';
      else if (underbodyGap(env.terrain, car.x, car.z, yR, fx, fz, yF, GROUND_CLEARANCE) < 0) reason = 'underbody';
    }
  }
  if (!reason) {
    const c = centerOf(car, spec);
    const b = env.bounds;
    if (c.x < b.minX || c.x > b.maxX || c.z < b.minZ || c.z > b.maxZ) reason = 'edge';
  }
  const lv = env.levelAware;
  const test = (): Collider | null => findVehicleCollision(obbOf(car, spec), env.colliders, lv ? car.y : undefined, lv ? spec.height : undefined);
  let hit: Collider | null = reason ? null : test();
  let slid = false;
  if (hit && env.slide) {
    // 접촉면을 따라 미끄러짐: 이전 자세에서 x 성분만 / z 성분만 이동해 보고 통과 가능하면 채택 (헤딩은 이전 값 유지)
    const nx = car.x;
    const nz = car.z;
    car.heading = ph;
    // 정면으로 들이받은 경우는 미끄러짐이 아니다: 한 축만 남긴 이동량이 원래 이동량의 30% 미만이면 제자리나 다름없으므로 충돌로 처리한다.
    // (v0.5.5 수정: 이 검사가 없으면 벽에 수직으로 돌진해도 "미끄러짐"으로 채택돼 차는 멈추지만 충돌이 기록되지 않았다)
    const stepLen = Math.hypot(nx - px, nz - pz);
    for (const [tx, tz] of [
      [nx, pz],
      [px, nz],
    ] as const) {
      if (Math.hypot(tx - px, tz - pz) < stepLen * 0.3) continue;
      car.x = tx;
      car.z = tz;
      if (!test()) {
        hit = null;
        slid = true;
        car.v = pv * 0.995; // 접촉 마찰/충격 감쇠 (완전 정지가 아니다)
        break;
      }
    }
    if (hit) {
      car.x = nx;
      car.z = nz;
    }
  }
  const impacts: ImpactEvent[] = [];
  let blockV = 0;
  if (hit && env.impact) {
    // 부서지거나 밀려난 물체는 이번 스텝 검사에서 빼고 다시 검사(뒤에 다른 물체가 있을 수 있다). 한 스텝 최대 4개
    const passed = new Set<string>();
    while (hit && passed.size < 4) {
      const r = env.impact(hit, car, car.v);
      impacts.push({ hit, action: r.action });
      if (r.action !== 'pass') {
        blockV = r.v;
        break;
      }
      passed.add(hit.id);
      car.v = r.v;
      hit = findVehicleCollision(obbOf(car, spec), env.colliders.filter((c) => !passed.has(c.id)), lv ? car.y : undefined, lv ? spec.height : undefined);
    }
  }
  if (hit) reason = 'collider';
  if (reason) {
    car.x = px;
    car.z = pz;
    car.heading = ph;
    car.y = py;
    car.pitch = ppitch;
    car.slope = pslope;
    car.v = reason === 'collider' ? blockV : 0;
  }
  return { blocked: !!reason, reason, hit, prevV: pv, slid, impacts };
}
