import type { Collider, Obb } from '../core/geometry';
import { worldToLocal } from '../core/math';

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}
export interface CarBody extends Obb {
  height: number;
  /** 차체 바닥 높이 (다층) */
  base?: number;
}

/** 월드 (x,z) 가 충돌체 평면 영역 안인가 */
export function insideFootprint(c: Collider, x: number, z: number): boolean {
  if (c.kind === 'cyl') return (x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r;
  const l = worldToLocal(c.x, c.z, c.rot, x, z);
  return Math.abs(l.x) <= c.w / 2 && Math.abs(l.z) <= c.d / 2;
}

export function insideCar(car: CarBody, x: number, z: number): boolean {
  const l = worldToLocal(car.x, car.z, car.rot, x, z);
  return Math.abs(l.x) <= car.hw && Math.abs(l.z) <= car.hl;
}

/**
 * 선분 a→b 가 충돌체/자기 차체에 막히는가 (3D 높이 반영, 샘플링).
 * ignoreIds: 시선 끝점이 놓인 충돌체(표시 대상 장애물 자신) 등 막힘 판정에서 제외할 id.
 * 끝점 근처 endMargin(m) 구간은 판정하지 않는다(표면 위의 점이 자기 자신에 가려지는 것을 방지).
 */
export function segmentBlocked(
  a: Pt3,
  b: Pt3,
  colliders: readonly Collider[],
  car: CarBody | null,
  opts: { ignoreIds?: ReadonlySet<string>; endMargin?: number; startMargin?: number; step?: number } = {},
): boolean {
  const step = opts.step ?? 0.2;
  const end = opts.endMargin ?? 0.15;
  const start = opts.startMargin ?? 0;
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (len < 1e-6) return false;
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 0; i <= n; i++) {
    const d = (i / n) * len;
    if (d < start || d > len - end) continue;
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const c of colliders) {
      if (opts.ignoreIds?.has(c.id)) continue;
      if (y < c.y0 || y > c.y0 + c.h) continue;
      if (insideFootprint(c, x, z)) return true;
    }
    if (car && y >= (car.base ?? 0) + 0.1 && y <= (car.base ?? 0) + car.height && insideCar(car, x, z)) return true;
  }
  return false;
}

/** 점이 (높이 포함) 충돌체/차체 내부에 있는가 — 카메라 위치 검증용 */
export function pointInsideSolid(p: Pt3, colliders: readonly Collider[], car: CarBody | null): boolean {
  for (const c of colliders) if (p.y >= c.y0 && p.y <= c.y0 + c.h && insideFootprint(c, p.x, p.z)) return true;
  return !!(car && p.y >= (car.base ?? 0) && p.y <= (car.base ?? 0) + car.height && insideCar(car, p.x, p.z));
}

/** 점(x,z)에서 충돌체 평면 영역까지의 거리 (내부면 0) */
export function distToFootprint(c: Collider, x: number, z: number): number {
  if (c.kind === 'cyl') return Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
  const l = worldToLocal(c.x, c.z, c.rot, x, z);
  return Math.hypot(Math.max(Math.abs(l.x) - c.w / 2, 0), Math.max(Math.abs(l.z) - c.d / 2, 0));
}

/** 카메라 위치가 어떤 충돌체에든 margin 이내로 붙어 있는가 (높이가 충돌체 위 +0.5m 이내일 때) */
export function tooCloseToSolid(p: Pt3, colliders: readonly Collider[], margin: number): boolean {
  for (const c of colliders) {
    if (p.y > c.y0 + c.h + 0.5 || p.y < c.y0 - 0.2) continue;
    if (distToFootprint(c, p.x, p.z) < margin) return true;
  }
  return false;
}

/**
 * 추적 카메라 가림 보정: look 에서 desired 쪽으로 가다가 처음 막히는 지점 직전까지만 간다.
 * 반환 t(0..1) 는 look→desired 선분에서 허용되는 비율 (minT 이하로는 줄이지 않음).
 */
export function freeFraction(look: Pt3, desired: Pt3, colliders: readonly Collider[], margin = 0.5, minT = 0.3): number {
  const len = Math.hypot(desired.x - look.x, desired.y - look.y, desired.z - look.z);
  if (len < 1e-6) return 1;
  const step = 0.25;
  const n = Math.ceil(len / step);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = look.x + (desired.x - look.x) * t;
    const y = look.y + (desired.y - look.y) * t;
    const z = look.z + (desired.z - look.z) * t;
    for (const c of colliders) {
      if (y < c.y0 - 0.1 || y > c.y0 + c.h + 0.1) continue;
      if (distToFootprint(c, x, z) < margin) return Math.max(minT, ((i - 1) / n) * 1);
    }
  }
  return 1;
}
