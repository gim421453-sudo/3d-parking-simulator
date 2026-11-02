import type { Collider, Obb } from '../core/geometry';
import { worldToLocal } from '../core/math';

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}
export interface CarBody extends Obb {
  height: number;
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
    if (car && y >= 0.1 && y <= car.height && insideCar(car, x, z)) return true;
  }
  return false;
}

/** 점이 (높이 포함) 충돌체/차체 내부에 있는가 — 카메라 위치 검증용 */
export function pointInsideSolid(p: Pt3, colliders: readonly Collider[], car: CarBody | null): boolean {
  for (const c of colliders) if (p.y >= c.y0 && p.y <= c.y0 + c.h && insideFootprint(c, p.x, p.z)) return true;
  return !!(car && p.y <= car.height && insideCar(car, p.x, p.z));
}
