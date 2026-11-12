import { clamp, forwardOf, localToWorld, normAngle } from '../core/math';
import type { Obb } from '../core/geometry';
import type { VehicleSpec } from './spec';

export type Gear = 'P' | 'R' | 'N' | 'D';

/**
 * 차량 상태. (x, z)는 "뒷바퀴 축 중심"이며 자전거 모델의 기준점이다.
 * 실제 차체 중심은 centerOf()로 구한다.
 */
export interface VehicleState {
  x: number;
  z: number;
  heading: number;
  v: number; // 앞 방향 +, 부호 있는 속도 (m/s)
  steer: number; // 왼쪽 + (rad), 앞바퀴 조향각
  gear: Gear;
  handbrake: boolean;
  wheelRoll: number; // 바퀴 회전 누적(rad)
  /** 뒷축 위치의 지면 높이(m). 평면 맵에서는 항상 0 */
  y: number;
  /** 차체 피치(rad, 앞이 높으면 +) */
  pitch: number;
  /** sin(pitch): 경사로에서 중력 성분 (평면 0) */
  slope: number;
}

export interface VehicleInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steerInput: number; // -1..1, 왼쪽 +
  /** 엔진 시동 상태(생략 = 켜짐). 꺼져 있으면 가속/크리프/엔진 브레이크가 없고 마찰로만 감속한다 */
  engineOn?: boolean;
}

export const CREEP_SPEED = 0.9; // m/s (D/R에서 페달을 밟지 않을 때 서행)
export const SHIFT_SPEED_LIMIT = 0.55; // m/s ≈ 2 km/h : 이 이상으로 구르면 반대 방향 기어 거부
export const PARK_SPEED_LIMIT = 0.3; // m/s ≈ 1 km/h

export function createVehicleState(spec: VehicleSpec, cx: number, cz: number, heading: number): VehicleState {
  const half = spec.length / 2 - spec.rearOverhang;
  const rear = localToWorld(cx, cz, heading, 0, -half);
  return { x: rear.x, z: rear.z, heading, v: 0, steer: 0, gear: 'P', handbrake: false, wheelRoll: 0, y: 0, pitch: 0, slope: 0 };
}

/** 차체 중심(충돌 OBB의 중심) */
export function centerOf(s: VehicleState, spec: VehicleSpec): { x: number; z: number } {
  const off = spec.length / 2 - spec.rearOverhang;
  const f = forwardOf(s.heading);
  return { x: s.x + f.x * off, z: s.z + f.z * off };
}

export function obbOf(s: VehicleState, spec: VehicleSpec): Obb {
  const c = centerOf(s, spec);
  return { x: c.x, z: c.z, rot: s.heading, hw: spec.width / 2, hl: spec.length / 2 };
}

export interface GearResult {
  ok: boolean;
  reason?: string;
}

/** 기어 변경 요청. 속도 조건을 만족하지 않으면 거부한다. */
export function requestGear(s: VehicleState, g: Gear): GearResult {
  if (g === s.gear) return { ok: true };
  switch (g) {
    case 'P':
      if (Math.abs(s.v) > PARK_SPEED_LIMIT) return { ok: false, reason: '차를 완전히 멈춘 뒤 P로 변경하세요' };
      s.v = 0;
      break;
    case 'R':
      if (s.v > SHIFT_SPEED_LIMIT) return { ok: false, reason: '전진 중에는 R로 변경할 수 없습니다' };
      break;
    case 'D':
      if (s.v < -SHIFT_SPEED_LIMIT) return { ok: false, reason: '후진 중에는 D로 변경할 수 없습니다' };
      break;
    case 'N':
      break;
  }
  s.gear = g;
  return { ok: true };
}

/** 속도에 따라 줄어드는 최대 조향각 */
/**
 * v0.5.4: 저속(2.5m/s = 9km/h 이하)에서는 **풀 조향**이 가능하다(실차와 같음). 이전 식은 2m/s 에서 이미 8% 줄어
 * 좁은 나선 램프에서 필요한 회전 반경을 못 만들었다(원인 분석: docs/V054.md). 그 위로는 속도에 따라 부드럽게 줄어든다.
 */
export const FULL_STEER_SPEED = 2.5;
export function maxSteerAt(spec: VehicleSpec, v: number): number {
  const k = Math.max(0, Math.abs(v) - FULL_STEER_SPEED) / 6;
  return spec.maxSteer / (1 + k * k);
}
/** 주어진 속도에서 뒷축 중심의 최소 회전 반경 */
export const minTurnRadius = (spec: VehicleSpec, v = 0): number => spec.wheelbase / Math.tan(maxSteerAt(spec, v));
/**
 * 뒷축 중심이 반경 R 의 원을 돌 때 차체가 쓸고 지나가는 환형의 안/바깥 반경 (정상 원선회, 자전거 모델).
 * 안쪽 = 뒷축 안쪽 옆면, 바깥 = 앞 바깥 모서리.
 */
export function sweptAnnulus(spec: VehicleSpec, R: number): { inner: number; outer: number } {
  const hw = spec.width / 2;
  const front = spec.length - spec.rearOverhang; // 뒷축 → 앞범퍼
  return { inner: Math.sqrt(Math.max(0, R - hw) ** 2), outer: Math.hypot(R + hw, front) };
}
/** 폭 [r0, r1] 의 원형 통로를 통과할 수 있는 뒷축 반경 구간 [lo, hi] (hi < lo 이면 통과 불가). margin = 벽과의 여유 */
export function spiralPassBand(spec: VehicleSpec, r0: number, r1: number, v = 0, margin = 0): { lo: number; hi: number } {
  const hw = spec.width / 2;
  const front = spec.length - spec.rearOverhang;
  const loGeom = r0 + margin + hw;
  const lo = Math.max(loGeom, minTurnRadius(spec, v));
  const o = r1 - margin;
  const hi = o > front ? Math.sqrt(o * o - front * front) - hw : -Infinity;
  return { lo, hi };
}

/**
 * 한 스텝 적분 (저속 자전거 모델).
 * 후진 시 yaw 변화량의 부호가 자연스럽게 반전되어 후진 조향 방향이 정상으로 동작한다.
 */
export function stepVehicle(s: VehicleState, input: VehicleInput, spec: VehicleSpec, dt: number): void {
  // ---- 조향 ----
  const target = clamp(input.steerInput, -1, 1) * maxSteerAt(spec, s.v);
  const rate = input.steerInput !== 0 ? 1.7 : 2.4; // rad/s : 입력 없으면 더 빨리 복귀
  const d = target - s.steer;
  const dm = rate * dt;
  s.steer += Math.abs(d) <= dm ? d : Math.sign(d) * dm;
  // 속도 상승 시 최대 조향각이 줄어드는 것을 즉시 반영
  const lim = maxSteerAt(spec, s.v);
  s.steer = clamp(s.steer, -lim, lim);

  // ---- 종방향 ----
  const dirSign = s.gear === 'D' ? 1 : s.gear === 'R' ? -1 : 0;
  const eng = input.engineOn !== false;
  let a = 0;
  if (s.gear === 'P' || s.handbrake) {
    // 잠금: 강하게 정지
    const dec = 14 * dt;
    s.v = Math.abs(s.v) <= dec ? 0 : s.v - Math.sign(s.v) * dec;
  } else {
    if (dirSign !== 0) {
      const vmax = dirSign > 0 ? spec.maxSpeedFwd : spec.maxSpeedRev;
      if (!eng) {
        // 시동 OFF: 구동력/크리프/엔진 브레이크 없음 (아래 구름/공기저항과 브레이크만 작용)
      } else if (input.throttle > 0) {
        const ratio = Math.sign(s.v) === dirSign ? Math.abs(s.v) / vmax : 0;
        const room = clamp(1 - ratio * ratio * ratio, 0, 1); // 최고속도 근처에서만 가속이 줄어든다
        a += dirSign * spec.accel * input.throttle * room;
      } else if (input.brake === 0 && Math.abs(s.v) < CREEP_SPEED && (s.v === 0 || Math.sign(s.v) === dirSign)) {
        a += dirSign * 0.9; // 크리프
      } else if (input.brake === 0 && Math.sign(s.v) === dirSign) {
        a -= dirSign * 0.8; // 엔진 브레이크
      }
    }
    // 경사로: 중력의 진행 방향 성분 (앞이 높으면 앞으로 갈수록 감속, 뒤로 구르면 가속). 풋브레이크/주차브레이크/P 가 잡는다.
    if (s.slope !== 0) a -= 9.81 * s.slope;
    // 구름저항 + 공기저항
    // (v0.5.3) 5m/s(18km/h) 까지는 기존 구름저항 곡선(저속 주차 감각 유지), 그 위는 완만한 공기저항만 더해 120km/h↑ 가속이 가능하다
    if (s.v !== 0) {
      const av = Math.abs(s.v);
      a -= Math.sign(s.v) * (0.22 + 0.012 * Math.min(av, 5) ** 2 + 0.0004 * av * av);
    }
    // 풋 브레이크
    const prev = s.v;
    s.v += a * dt;
    if (input.brake > 0 && s.v !== 0) {
      const dec = 7.5 * input.brake * dt;
      s.v = Math.abs(s.v) <= dec ? 0 : s.v - Math.sign(s.v) * dec;
    }
    // 저항으로 부호가 뒤집히는 것 방지
    if (prev !== 0 && Math.sign(prev) !== Math.sign(s.v) && dirSign === 0) s.v = 0;
    s.v = clamp(s.v, -spec.maxSpeedRev, spec.maxSpeedFwd);
  }

  // ---- 기구학 (뒷축 기준 자전거 모델) ----
  const dh = (s.v / spec.wheelbase) * Math.tan(s.steer) * dt;
  const hMid = s.heading + dh / 2;
  s.x += Math.sin(hMid) * s.v * dt;
  s.z += Math.cos(hMid) * s.v * dt;
  s.heading = normAngle(s.heading + dh);
  s.wheelRoll += (s.v / spec.wheelRadius) * dt;
}

/** 고속 연속 충돌 검사를 위한 서브스텝 수: 한 서브스텝 이동량을 MAX_STEP_DIST(0.12m) 이하로 유지(얇은 벽 관통 방지). 최대 8 */
export const MAX_STEP_DIST = 0.12;
export const substepCount = (v: number, dt: number): number => Math.min(8, Math.max(1, Math.ceil((Math.abs(v) * dt) / MAX_STEP_DIST)));

export const speedKmh = (s: VehicleState): number => Math.abs(s.v) * 3.6;
