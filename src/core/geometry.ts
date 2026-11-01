import { localToWorld, worldToLocal, type Vec2 } from './math';

/**
 * 충돌/센서가 함께 쓰는 기하 데이터.
 * - box: 중심(x,z), 크기 w(로컬 x) × d(로컬 z), 회전 rot(heading 규칙), 높이 구간 [y0, y0+h]
 * - cyl: 중심(x,z), 반지름 r, 높이 구간 [y0, y0+h]
 * 지면은 충돌체가 아니다(= 센서가 지면을 감지할 수 없다).
 */
export interface BoxCollider {
  kind: 'box';
  id: string;
  tag: string;
  x: number;
  z: number;
  w: number;
  d: number;
  rot: number;
  y0: number;
  h: number;
}
export interface CylCollider {
  kind: 'cyl';
  id: string;
  tag: string;
  x: number;
  z: number;
  r: number;
  y0: number;
  h: number;
}
export type Collider = BoxCollider | CylCollider;

/** 차량의 최저 지상고. 이보다 낮은 물체(연석 등)는 차체와 충돌하지 않는다. */
export const GROUND_CLEARANCE = 0.2;

export interface Obb {
  x: number;
  z: number;
  rot: number;
  hw: number; // 로컬 x 반폭
  hl: number; // 로컬 z 반길이
}

export function obbCorners(o: Obb): Vec2[] {
  return [
    localToWorld(o.x, o.z, o.rot, o.hw, o.hl),
    localToWorld(o.x, o.z, o.rot, -o.hw, o.hl),
    localToWorld(o.x, o.z, o.rot, -o.hw, -o.hl),
    localToWorld(o.x, o.z, o.rot, o.hw, -o.hl),
  ];
}

function project(corners: Vec2[], ax: number, az: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const p = c.x * ax + c.z * az;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

/** SAT 방식 OBB-OBB 겹침 검사 */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes: [number, number][] = [
    [Math.cos(a.rot), -Math.sin(a.rot)],
    [Math.sin(a.rot), Math.cos(a.rot)],
    [Math.cos(b.rot), -Math.sin(b.rot)],
    [Math.sin(b.rot), Math.cos(b.rot)],
  ];
  for (const [ax, az] of axes) {
    const [amin, amax] = project(ca, ax, az);
    const [bmin, bmax] = project(cb, ax, az);
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

export function obbCircleOverlap(o: Obb, cx: number, cz: number, r: number): boolean {
  const l = worldToLocal(o.x, o.z, o.rot, cx, cz);
  const qx = Math.max(-o.hw, Math.min(o.hw, l.x));
  const qz = Math.max(-o.hl, Math.min(o.hl, l.z));
  const dx = l.x - qx;
  const dz = l.z - qz;
  return dx * dx + dz * dz <= r * r;
}

export function colliderIsSolidForCar(c: Collider): boolean {
  return c.y0 + c.h > GROUND_CLEARANCE;
}

/** 차량 OBB가 충돌체와 겹치는지. 겹치면 해당 충돌체를 반환. */
export function findVehicleCollision(car: Obb, colliders: readonly Collider[]): Collider | null {
  const reach = Math.hypot(car.hw, car.hl);
  for (const c of colliders) {
    if (!colliderIsSolidForCar(c)) continue;
    if (c.kind === 'box') {
      const br = Math.hypot(c.w / 2, c.d / 2) + reach;
      const dx = c.x - car.x;
      const dz = c.z - car.z;
      if (dx * dx + dz * dz > br * br) continue;
      if (obbOverlap(car, { x: c.x, z: c.z, rot: c.rot, hw: c.w / 2, hl: c.d / 2 })) return c;
    } else {
      const br = c.r + reach;
      const dx = c.x - car.x;
      const dz = c.z - car.z;
      if (dx * dx + dz * dz > br * br) continue;
      if (obbCircleOverlap(car, c.x, c.z, c.r)) return c;
    }
  }
  return null;
}

/** 광선-박스(2D) 교차. 교차 거리 t(0..maxT) 또는 null */
export function rayBox(ox: number, oz: number, dx: number, dz: number, b: BoxCollider, maxT: number): number | null {
  const o = worldToLocal(b.x, b.z, b.rot, ox, oz);
  // 방향 벡터는 회전만 적용 (평행이동 없음)
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  const hw = b.w / 2;
  const hl = b.d / 2;
  let tmin = 0;
  let tmax = maxT;
  const slab = (p: number, d: number, half: number): boolean => {
    if (Math.abs(d) < 1e-9) return p >= -half && p <= half;
    let t1 = (-half - p) / d;
    let t2 = (half - p) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(o.x, ldx, hw)) return null;
  if (!slab(o.z, ldz, hl)) return null;
  return tmin <= maxT ? tmin : null;
}

export function rayCyl(ox: number, oz: number, dx: number, dz: number, cy: CylCollider, maxT: number): number | null {
  const fx = ox - cy.x;
  const fz = oz - cy.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - cy.r * cy.r;
  if (c <= 0) return 0; // 시작점이 이미 내부
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= maxT ? t : null;
}

export interface RayHit {
  t: number;
  collider: Collider;
}

/**
 * 높이 sy(미터)의 수평 평면에서 광선을 쏜다.
 * 충돌체의 높이 구간 [y0, y0+h]에 sy가 들어가야만 감지된다(지면/낮은 연석/천장 물체는 제외).
 */
export function raycast(
  colliders: readonly Collider[],
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxT: number,
  sy: number,
): RayHit | null {
  let best: RayHit | null = null;
  let bestT = maxT;
  for (const c of colliders) {
    if (sy < c.y0 || sy > c.y0 + c.h) continue;
    const limit: number = bestT;
    const t: number | null = c.kind === 'box' ? rayBox(ox, oz, dx, dz, c, limit) : rayCyl(ox, oz, dx, dz, c, limit);
    if (t !== null && (best === null || t < best.t)) {
      best = { t, collider: c };
      bestT = t;
    }
  }
  return best;
}
