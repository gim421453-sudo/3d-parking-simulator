import { findVehicleCollision } from '../core/geometry';
import { SpatialIndex } from '../core/spatial';
import { mapColliders } from '../maps/types';
import type { MapData } from '../maps/types';
import type { VehicleSpec } from '../vehicle/spec';

/**
 * 차량 기구학 경로 탐색 (하이브리드 A*, v0.5.4) — "이 차가 여기를 실제로 지나갈 수 있는가"를 증명하는 검사 도구.
 *  - 상태: 뒷축 (x, z, heading). 동작: 조향 {좌 최대, 직진, 우 최대} × {전진, 후진} 으로 step(m) 이동(자전거 모델의 원호).
 *  - 충돌: 게임과 같은 차체 OBB × 맵 충돌체(`findVehicleCollision`) — 중간 자세도 검사한다. 평면 맵 전용(높이 미사용).
 *  - 비용: 이동 거리 + 후진 가중 + 전/후진 전환 벌점. 결과에 전환 횟수(switches)가 나온다: 0 = 한 번에 통과, ≥1 = 꺾어 넣기(전후진) 필요.
 * 자동 조종기(순수 추종)가 좁은 골목에서 실패하는 것과 "지나갈 수 없는 것"을 구분하기 위한 것이다.
 */
export interface PlanOptions {
  step?: number;
  gridXZ?: number;
  headingBins?: number;
  goalRadius?: number;
  /** 목표 heading 과 허용 오차(rad). 생략하면 방향 무관 */
  goalHeading?: number;
  goalHeadingTol?: number;
  maxExpand?: number;
  /** 후진 허용 */
  allowReverse?: boolean;
  /** 차체 옆 여유(m) — 충돌 검사 시 차폭/길이에 더한다 */
  margin?: number;
}
export interface PlanResult {
  found: boolean;
  /** 뒷축 자세 열 */
  poses: { x: number; z: number; heading: number; dir: 1 | -1 }[];
  length: number;
  /** 전진↔후진 전환 횟수 */
  switches: number;
  expanded: number;
}

interface Node {
  x: number;
  z: number;
  h: number;
  g: number;
  f: number;
  dir: 1 | -1;
  parent: Node | null;
}

export function planPath(map: MapData, spec: VehicleSpec, start: { x: number; z: number; heading: number }, goal: { x: number; z: number }, o: PlanOptions = {}): PlanResult {
  const step = o.step ?? 0.7;
  const res = o.gridXZ ?? 0.4;
  const bins = o.headingBins ?? 32;
  const goalR = o.goalRadius ?? 1.2;
  const maxExpand = o.maxExpand ?? 400000;
  const margin = o.margin ?? 0.05;
  const index = new SpatialIndex(8);
  index.rebuild(mapColliders(map));
  const off = spec.length / 2 - spec.rearOverhang;
  const hw = spec.width / 2 + margin;
  const hl = spec.length / 2 + margin;
  const b = map.bounds;
  const near: ReturnType<typeof mapColliders> = [];
  const free = (x: number, z: number, h: number): boolean => {
    const cx = x + Math.sin(h) * off;
    const cz = z + Math.cos(h) * off;
    if (cx < b.minX || cx > b.maxX || cz < b.minZ || cz > b.maxZ) return false;
    index.query(cx, cz, 4, near);
    return !findVehicleCollision({ x: cx, z: cz, rot: h, hw, hl }, near, 0, spec.height);
  };
  const key = (x: number, z: number, h: number, dir: number): string => {
    const hb = ((Math.round((h / (2 * Math.PI)) * bins) % bins) + bins) % bins;
    return `${Math.round(x / res)},${Math.round(z / res)},${hb},${dir}`;
  };
  const heur = (x: number, z: number): number => Math.hypot(goal.x - x, goal.z - z);
  const steers = [spec.maxSteer, 0, -spec.maxSteer];
  const dirs: (1 | -1)[] = o.allowReverse === false ? [1] : [1, -1];
  // 이진 힙
  const heap: Node[] = [];
  const push = (n: Node): void => {
    heap.push(n);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p].f <= heap[k].f) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = (): Node => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const seen = new Map<string, number>();
  if (!free(start.x, start.z, start.heading)) return { found: false, poses: [], length: 0, switches: 0, expanded: 0 };
  push({ x: start.x, z: start.z, h: start.heading, g: 0, f: heur(start.x, start.z), dir: 1, parent: null });
  let expanded = 0;
  while (heap.length && expanded < maxExpand) {
    const n = pop();
    const k0 = key(n.x, n.z, n.h, n.dir);
    const best = seen.get(k0);
    if (best !== undefined && best <= n.g) continue;
    seen.set(k0, n.g);
    expanded++;
    const cx = n.x + Math.sin(n.h) * off;
    const cz = n.z + Math.cos(n.h) * off;
    const headOk = o.goalHeading === undefined || Math.abs(Math.atan2(Math.sin(n.h - o.goalHeading), Math.cos(n.h - o.goalHeading))) <= (o.goalHeadingTol ?? 0.3);
    if (Math.hypot(goal.x - cx, goal.z - cz) <= goalR && headOk) {
      const poses: PlanResult['poses'] = [];
      let sw = 0;
      for (let c: Node | null = n; c; c = c.parent) {
        poses.push({ x: c.x, z: c.z, heading: c.h, dir: c.dir });
        if (c.parent && c.parent.parent && c.parent.dir !== c.dir) sw++;
      }
      poses.reverse();
      return { found: true, poses, length: n.g, switches: sw, expanded };
    }
    for (const dir of dirs) {
      for (const st of steers) {
        // 자전거 모델: 뒷축이 step 만큼 이동, heading 변화 = dir·step·tan(steer)/wheelbase
        const dh = (dir * step * Math.tan(st)) / spec.wheelbase;
        let ok = true;
        let x = n.x;
        let z = n.z;
        let h = n.h;
        const sub = 2;
        for (let i = 0; i < sub; i++) {
          const hm = h + dh / (2 * sub);
          x += Math.sin(hm) * dir * (step / sub);
          z += Math.cos(hm) * dir * (step / sub);
          h += dh / sub;
          if (!free(x, z, h)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const cost = step * (dir < 0 ? 2.2 : 1) + (n.parent && dir !== n.dir ? 4 : 0) + (st !== 0 ? 0.05 : 0);
        const g = n.g + cost;
        const kk = key(x, z, h, dir);
        const sb = seen.get(kk);
        if (sb !== undefined && sb <= g) continue;
        const fx = x + Math.sin(h) * off;
        const fz = z + Math.cos(h) * off;
        push({ x, z, h, g, f: g + heur(fx, fz), dir, parent: n });
      }
    }
  }
  return { found: false, poses: [], length: 0, switches: 0, expanded };
}
