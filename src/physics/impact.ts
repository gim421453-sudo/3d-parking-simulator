/**
 * 충돌 파손 물리 (v0.6.0, 순수 로직 — 렌더링/게임 상태와 독립, 단위 테스트 대상).
 *
 * 모델 (간단한 강체 충돌 근사):
 *  - 접촉 법선 n: 장애물 표면의 가장 가까운 점 → 차체 중심 방향.
 *  - 접근 속도 vn = −(V_rel · n) (> 0 이면 서로 다가가는 중). 비스듬히 스치면 vn 이 작아 손상도 작다.
 *  - 충돌 에너지 E = ½ · μ · vn², μ = 환산 질량(움직이는 물체: m1·m2/(m1+m2), 고정 물체: m1).
 *  - 장애물: 재질별 최소 에너지(minE) 이상이면 손상 누적. 누적 손상 ≥ 내구도(hp)이면 재질의 파손 방식대로 부서진다.
 *  - 움직이는 물체(콘/드럼/주차 차량): 반발계수 e 로 충격량 J = (1+e)·μ·vn 을 주고받는다(운동량 보존).
 *  - 고정 물체가 버티면: 차량은 막히고 빠른 충돌은 살짝 튕긴다. 부서지면: 흡수한 에너지만큼 속도가 줄고 통과한다.
 *  - 차량 손상: 부딪힌 부위(전/후/좌/우)에 에너지에 비례해 누적. 2kJ(≈시속 6km 접촉) 미만은 범퍼가 흡수해 손상 없음.
 * 실제 차량 충돌 시험 데이터가 아니라 게임용 근사이며 수치는 아래 상수로 조정한다.
 */
import type { Collider } from '../core/geometry';
import { worldToLocal } from '../core/math';

/** 파손 방식 */
export type BreakMode =
  /** 밀려난다(움직이는 물체) — 사라지지 않음 */
  | 'push'
  /** 산산조각: 충돌체 제거 + 파편 */
  | 'shatter'
  /** 넘어짐/휘어짐: 충돌체 제거(쓰러진 모델은 바닥에 남음) */
  | 'topple'
  /** 벽: 부딪힌 자리만 차폭+여유 크기로 구멍 */
  | 'hole'
  /** 구조물(건물/기둥): 균열·파편만, 형태/충돌체 유지 */
  | 'scar'
  /** 파손 대상 아님(장치가 관리하는 충돌체 등) */
  | 'none';

export interface Material {
  name: string;
  mode: BreakMode;
  /** 움직이는 물체의 질량(kg). 고정 물체는 Infinity */
  mass: number;
  /** 내구도(J). 누적 손상이 이 값을 넘으면 파손 */
  hp: number;
  /** 이 에너지(J) 미만의 접촉은 손상 없음 */
  minE: number;
  /** 반발계수 */
  e: number;
}

const INF = Number.POSITIVE_INFINITY;
const volumeOf = (c: Collider): number => (c.kind === 'box' ? c.w * c.d * c.h : Math.PI * c.r * c.r * c.h);
const thicknessOf = (c: Collider): number => (c.kind === 'box' ? Math.min(c.w, c.d) : c.r * 2);

/** 장치/시스템이 관리하는 충돌체: 파손 대상에서 뺀다 (기계식 셔터, 리프트 기둥, 팔레트 가이드, 카메라 전용) */
export function isSystemCollider(c: Pick<Collider, 'id' | 'tag'>): boolean {
  return c.tag === 'guide' || c.tag === 'curb' || c.tag === 'camera-only' || /shutter|(^|:)door|lift-[ab]-post|lift-post|ms-front|ms-back/.test(c.id);
}

/** 충돌체의 재질 (태그 + 크기에서 결정) */
export function materialOf(c: Collider): Material {
  if (isSystemCollider(c)) return { name: '장치', mode: 'none', mass: INF, hp: INF, minE: INF, e: 0 };
  const v = volumeOf(c);
  switch (c.tag) {
    case 'cone':
      return { name: '라바콘', mode: 'push', mass: 4, hp: INF, minE: 0, e: 0.5 };
    case 'drum':
      return { name: '드럼', mode: 'push', mass: 30, hp: INF, minE: 0, e: 0.35 };
    case 'car':
      return { name: '주차 차량', mode: 'push', mass: 1400, hp: INF, minE: 2000, e: 0.2 };
    case 'planter':
      // 화분/벤치/공구함: 부피에 비례하는 내구도 (2m³ ≈ 50kJ ≈ 시속 30km 세단 정면)
      return { name: '화분·집기', mode: 'shatter', mass: INF, hp: Math.max(15000, v * 25000), minE: 1500, e: 0.1 };
    case 'barrier':
      return { name: '방호벽', mode: 'shatter', mass: INF, hp: Math.max(25000, v * 60000), minE: 2000, e: 0.1 };
    case 'lamp':
      return { name: '가로등', mode: 'topple', mass: INF, hp: 25000, minE: 1500, e: 0.1 };
    case 'tree':
      return { name: '가로수', mode: 'topple', mass: INF, hp: 70000, minE: 2000, e: 0.1 };
    case 'bollard':
      return { name: '볼라드', mode: 'topple', mass: INF, hp: 35000, minE: 2000, e: 0.15 };
    case 'wall': {
      // 두께 0.3m·높이 1.2m 기준 250kJ(세단 ≈ 시속 66km). 두께에 비례, 높이는 완만하게(제곱근) 반영
      const t = thicknessOf(c);
      const hp = 250000 * Math.max(0.6, t / 0.3) * Math.sqrt(Math.min(3, Math.max(0.6, c.h)) / 1.2);
      return { name: '벽', mode: 'hole', mass: INF, hp, minE: 2500, e: 0.12 };
    }
    case 'pillar':
      return { name: '기둥', mode: 'scar', mass: INF, hp: INF, minE: 2500, e: 0.1 };
    case 'building':
      return { name: '건물', mode: 'scar', mass: INF, hp: INF, minE: 2500, e: 0.1 };
    default:
      return { name: c.tag, mode: 'scar', mass: INF, hp: INF, minE: 2500, e: 0.1 };
  }
}

/** 차량 질량 근사(kg): 차체 부피 × 115kg/m³ (세단 4.9×1.85×1.45 ≈ 1.5t), 0.9~2.6t */
export function vehicleMassKg(spec: { length: number; width: number; height: number }): number {
  return Math.min(2600, Math.max(900, spec.length * spec.width * spec.height * 115));
}

/** 충돌체 바닥 면에서 (x,z) 에 가장 가까운 점 */
export function closestPointOn(c: Collider, x: number, z: number): { x: number; z: number; inside: boolean } {
  if (c.kind === 'cyl') {
    const dx = x - c.x;
    const dz = z - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-9) return { x: c.x + c.r, z: c.z, inside: true };
    return { x: c.x + (dx / d) * c.r, z: c.z + (dz / d) * c.r, inside: d < c.r };
  }
  const l = worldToLocal(c.x, c.z, c.rot, x, z);
  const hx = c.w / 2;
  const hz = c.d / 2;
  const inside = Math.abs(l.x) <= hx && Math.abs(l.z) <= hz;
  let qx = Math.max(-hx, Math.min(hx, l.x));
  let qz = Math.max(-hz, Math.min(hz, l.z));
  if (inside) {
    // 안쪽: 가장 가까운 면으로 밀어낸다
    if (hx - Math.abs(l.x) < hz - Math.abs(l.z)) qx = Math.sign(l.x || 1) * hx;
    else qz = Math.sign(l.z || 1) * hz;
  }
  const s = Math.sin(c.rot);
  const co = Math.cos(c.rot);
  // localToWorld 와 같은 규칙(로컬 +x = 왼쪽, +z = 앞): world = c + (x·cos + z·sin, −x·sin + z·cos)
  return { x: c.x + qx * co + qz * s, z: c.z - qx * s + qz * co, inside };
}

export type CarZone = 'front' | 'rear' | 'left' | 'right';

/** 차체 중심 기준 접촉점의 부위 (차량 로컬 +x = 왼쪽, +z = 앞) */
export function carZoneOf(car: { x: number; z: number; heading: number; hw: number; hl: number }, px: number, pz: number): CarZone {
  const l = worldToLocal(car.x, car.z, car.heading, px, pz);
  if (Math.abs(l.z) / car.hl >= Math.abs(l.x) / car.hw) return l.z >= 0 ? 'front' : 'rear';
  return l.x >= 0 ? 'left' : 'right';
}

export interface ImpactInput {
  /** 차체 중심/방향/반폭·반길이 */
  car: { x: number; z: number; heading: number; hw: number; hl: number };
  /** 차량 속도(부호 있음, 앞 +) */
  v: number;
  carMass: number;
  collider: Collider;
  /** 이미 누적된 장애물 손상(J) */
  damage: number;
  /** 움직이는 물체의 현재 속도 (없으면 정지) */
  bodyV?: { x: number; z: number };
}

export interface ImpactResult {
  /** 'block' 차량 막힘(이전 자세 복원), 'pass' 장애물이 부서지거나 밀려 차량이 계속 진행 */
  action: 'block' | 'pass';
  /** 충돌 후 차량 속도(부호 있음) */
  v: number;
  /** 접근 속도(m/s) */
  vn: number;
  /** 충돌 에너지(J) */
  energy: number;
  /** 장애물에 새로 누적할 손상(J) */
  damage: number;
  /** 이번 충돌로 파손되었는가 */
  broke: boolean;
  mode: BreakMode;
  /** 움직이는 물체에 더할 속도(m/s)와 회전 속도(rad/s) */
  push: { vx: number; vz: number; w: number } | null;
  /** 접촉점/법선(장애물 → 차량) */
  point: { x: number; z: number };
  normal: { x: number; z: number };
  /** 차량 손상 부위와 에너지 */
  zone: CarZone;
}

/** 이 속도(접근 속도, m/s)보다 빠른 정면 충돌만 튕겨 나온다. 그보다 느리면 이전처럼 그 자리에 멈춘다(주차 중 접촉) */
export const BOUNCE_MIN_VN = 2.5;

export function resolveImpact(i: ImpactInput): ImpactResult {
  const mat = materialOf(i.collider);
  const cp = closestPointOn(i.collider, i.car.x, i.car.z);
  let nx = i.car.x - cp.x;
  let nz = i.car.z - cp.z;
  let nl = Math.hypot(nx, nz);
  const fx = Math.sin(i.car.heading);
  const fz = Math.cos(i.car.heading);
  if (cp.inside || nl < 1e-6) {
    // 차체 중심이 장애물 안(얇은 물체를 깊게 침범) — 진행 반대 방향을 법선으로
    nx = -fx * Math.sign(i.v || 1);
    nz = -fz * Math.sign(i.v || 1);
    nl = 1;
  }
  nx /= nl;
  nz /= nl;
  const Vx = fx * i.v;
  const Vz = fz * i.v;
  const bvx = i.bodyV?.x ?? 0;
  const bvz = i.bodyV?.z ?? 0;
  const vn = Math.max(0, -((Vx - bvx) * nx + (Vz - bvz) * nz));
  const movable = Number.isFinite(mat.mass);
  const mu = movable ? (i.carMass * mat.mass) / (i.carMass + mat.mass) : i.carMass;
  const energy = 0.5 * mu * vn * vn;
  const zone = carZoneOf(i.car, cp.x, cp.z);
  const base = { vn, energy, point: { x: cp.x, z: cp.z }, normal: { x: nx, z: nz }, zone, mode: mat.mode };
  const dmg = mat.mode === 'none' || energy < mat.minE ? 0 : energy;

  if (movable && mat.mode === 'push') {
    // 운동량 교환: 충격량 J (법선 방향). 차량은 −J/m1, 물체는 +J/m2 (밀려나는 방향 = −n)
    const J = (1 + mat.e) * mu * vn;
    const cVx = Vx + (J / i.carMass) * nx;
    const cVz = Vz + (J / i.carMass) * nz;
    const v = cVx * fx + cVz * fz;
    // 물체 회전: 물체 중심에서 접촉점까지 팔 길이 × 충격량 / 관성모멘트(직사각형 근사)
    const c = i.collider;
    const rx = cp.x - c.x;
    const rz = cp.z - c.z;
    const px = -nx * J;
    const pz = -nz * J;
    const L = c.kind === 'box' ? Math.max(c.w, c.d) : c.r * 2;
    const W = c.kind === 'box' ? Math.min(c.w, c.d) : c.r * 2;
    const I = (mat.mass * (L * L + W * W)) / 12;
    const w = I > 0 ? (rx * pz - rz * px) / I : 0;
    return { ...base, action: vn > 0.05 ? 'pass' : 'block', v: vn > 0.05 ? v : 0, damage: dmg, broke: false, push: { vx: -nx * (J / mat.mass), vz: -nz * (J / mat.mass), w: -w } };
  }

  const breaks = mat.mode !== 'scar' && mat.mode !== 'none' && dmg > 0 && i.damage + dmg >= mat.hp;
  if (breaks) {
    // 남은 내구도만큼 에너지를 흡수하고 통과 — 차량 운동에너지에서 뺀다
    const absorbed = Math.max(0, Math.min(energy, mat.hp - i.damage));
    const ke = 0.5 * i.carMass * i.v * i.v;
    const k = ke > 1e-9 ? Math.sqrt(Math.max(0, 1 - absorbed / ke)) : 0;
    return { ...base, action: 'pass', v: i.v * k, damage: dmg, broke: true, push: null };
  }
  // 버팀: 막힘. 빠른 정면 충돌은 법선 방향으로 조금 튕긴다(반발계수 e)
  const v = vn > BOUNCE_MIN_VN ? -Math.sign(i.v) * mat.e * vn : 0;
  return { ...base, action: 'block', v, damage: dmg, broke: false, push: null };
}

// ---------------------------------------------------------------- 차량 손상
export interface CarDamage {
  front: number;
  rear: number;
  left: number;
  right: number;
}
export const newCarDamage = (): CarDamage => ({ front: 0, rear: 0, left: 0, right: 0 });

/** 이 에너지 미만은 범퍼/차체가 흡수(손상 없음) — ≈ 1.5t 차량 시속 6km */
export const CAR_DAMAGE_MIN_E = 2000;
/** 한 부위가 완전히 파손되는 누적 에너지 — ≈ 1.5t 차량 시속 60km 정면 */
export const CAR_DAMAGE_FULL_E = 210000;

/** 차량 손상 누적. 반환: 이번에 늘어난 손상(0~1) */
export function applyCarDamage(d: CarDamage, zone: CarZone, energy: number): number {
  if (energy < CAR_DAMAGE_MIN_E) return 0;
  const add = (energy - CAR_DAMAGE_MIN_E) / (CAR_DAMAGE_FULL_E - CAR_DAMAGE_MIN_E);
  const before = d[zone];
  d[zone] = Math.min(1, before + add);
  // 큰 충격은 인접 부위에도 일부 전달(프레임 변형)
  if (add > 0.15) {
    const near: CarZone[] = zone === 'front' || zone === 'rear' ? ['left', 'right'] : ['front', 'rear'];
    for (const z of near) d[z] = Math.min(1, d[z] + add * 0.15);
  }
  return d[zone] - before;
}

/** 전체 손상 정도 0~1 (가장 심한 부위 70% + 평균 30%) */
export function carSeverity(d: CarDamage): number {
  const vals = [d.front, d.rear, d.left, d.right];
  const max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / 4;
  return Math.min(1, max * 0.7 + mean * 0.3 + (max >= 1 ? 0.3 : 0));
}

export interface CarDamageEffects {
  /** 가속 페달 배율 0~1 */
  power: number;
  /** 최고 속도 배율 0~1 */
  topSpeed: number;
  /** 조향 쏠림(rad, 왼쪽 +): 측면이 찌그러지면 그쪽으로 당긴다 */
  steerPull: number;
  /** 전조등 파손(앞 부위 40% 이상) */
  headlightsBroken: boolean;
  /** 연기(심한 손상) */
  smoke: boolean;
  /** 운행 불가(엔진 정지, 시동 불가) */
  disabled: boolean;
  level: 'none' | 'minor' | 'moderate' | 'severe' | 'wrecked';
}

export function carDamageEffects(d: CarDamage): CarDamageEffects {
  const s = carSeverity(d);
  const disabled = s >= 1;
  const level = disabled ? 'wrecked' : s >= 0.6 ? 'severe' : s >= 0.3 ? 'moderate' : s > 0.02 ? 'minor' : 'none';
  const k = Math.max(0, s - 0.3) / 0.7; // 30% 까지는 성능 영향 없음
  return {
    power: disabled ? 0 : 1 - 0.6 * k,
    topSpeed: disabled ? 0 : 1 - 0.65 * k,
    steerPull: (d.left - d.right) * 0.035 * (d.left > 0.4 || d.right > 0.4 ? 1 : 0),
    headlightsBroken: d.front >= 0.4,
    smoke: s >= 0.55,
    disabled,
    level,
  };
}

export const CAR_DAMAGE_LEVEL_NAME: Record<CarDamageEffects['level'], string> = { none: '정상', minor: '경미한 손상', moderate: '손상', severe: '심한 손상', wrecked: '운행 불가' };
