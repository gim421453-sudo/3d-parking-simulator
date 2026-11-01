import { colliderIsSolidForCar, type Collider } from '../core/geometry';
import { worldToLocal } from '../core/math';
import type { MapData } from '../maps/types';
import { mapColliders } from '../maps/types';

/** 주행 가능한 도로 그래프. 맵의 실제 충돌체/경계에서 계산하므로 맵 데이터와 항상 일치한다. */
export interface RoadNode {
  id: number;
  x: number;
  z: number;
}
export interface RoadGraph {
  nodes: RoadNode[];
  adj: { to: number; w: number }[][];
  spacing: number;
  clearance: number;
}

/** 점에서 충돌체까지의 거리(음수 = 내부) */
export function distToCollider(x: number, z: number, c: Collider): number {
  if (c.kind === 'cyl') return Math.hypot(x - c.x, z - c.z) - c.r;
  const l = worldToLocal(c.x, c.z, c.rot, x, z);
  const dx = Math.abs(l.x) - c.w / 2;
  const dz = Math.abs(l.z) - c.d / 2;
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

export function isClear(map: MapData, solids: readonly Collider[], x: number, z: number, r: number): boolean {
  const b = map.bounds;
  if (x < b.minX + r || x > b.maxX - r || z < b.minZ + r || z > b.maxZ - r) return false;
  for (const c of solids) if (distToCollider(x, z, c) < r) return false;
  return true;
}

export function segmentClear(map: MapData, solids: readonly Collider[], ax: number, az: number, bx: number, bz: number, r: number): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(len / 0.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!isClear(map, solids, ax + (bx - ax) * t, az + (bz - az) * t, r)) return false;
  }
  return true;
}

export function buildRoadGraph(map: MapData, spacing = 3, clearance = 1.3): RoadGraph {
  const solids = mapColliders(map).filter(colliderIsSolidForCar);
  const b = map.bounds;
  const nodes: RoadNode[] = [];
  const index = new Map<string, number>();
  const gx0 = Math.ceil((b.minX + clearance) / spacing);
  const gx1 = Math.floor((b.maxX - clearance) / spacing);
  const gz0 = Math.ceil((b.minZ + clearance) / spacing);
  const gz1 = Math.floor((b.maxZ - clearance) / spacing);
  for (let ix = gx0; ix <= gx1; ix++) {
    for (let iz = gz0; iz <= gz1; iz++) {
      const x = ix * spacing;
      const z = iz * spacing;
      if (isClear(map, solids, x, z, clearance)) {
        index.set(`${ix},${iz}`, nodes.length);
        nodes.push({ id: nodes.length, x, z });
      }
    }
  }
  const adj: { to: number; w: number }[][] = nodes.map(() => []);
  const dirs: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let ix = gx0; ix <= gx1; ix++) {
    for (let iz = gz0; iz <= gz1; iz++) {
      const a = index.get(`${ix},${iz}`);
      if (a === undefined) continue;
      for (const [dx, dz] of dirs) {
        const bI = index.get(`${ix + dx},${iz + dz}`);
        if (bI === undefined) continue;
        const A = nodes[a];
        const B = nodes[bI];
        if (!segmentClear(map, solids, A.x, A.z, B.x, B.z, clearance * 0.95)) continue;
        const w = Math.hypot(A.x - B.x, A.z - B.z);
        adj[a].push({ to: bI, w });
        adj[bI].push({ to: a, w });
      }
    }
  }
  return { nodes, adj, spacing, clearance };
}

export function nearestNode(g: RoadGraph, x: number, z: number, map?: MapData): number {
  const solids = map ? mapColliders(map).filter(colliderIsSolidForCar) : null;
  let best = -1;
  let bd = Infinity;
  for (const n of g.nodes) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d >= bd) continue;
    if (map && solids && d > 0.5 && !segmentClear(map, solids, x, z, n.x, n.z, g.clearance * 0.6)) continue;
    bd = d;
    best = n.id;
  }
  if (best < 0) {
    for (const n of g.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
  }
  return best;
}

/** 맵이 좁아도 시작 위치에서 모든 미션 목적지에 도달할 수 있는 가장 넉넉한 여유(clearance)로 그래프를 만든다. */
export function buildBestRoadGraph(map: MapData): RoadGraph {
  const levels = [1.3, 1.15, 1.05, 1.0];
  let last: RoadGraph | null = null;
  for (const c of levels) {
    const g = buildRoadGraph(map, c >= 1.2 ? 3 : 2.5, c);
    last = g;
    if (g.nodes.length < 4) continue;
    const reach = reachableFrom(g, map, map.spawn);
    const ok = map.missions.every((m) => {
      const slot = map.slots.find((sl) => sl.id === m.slotId);
      if (!slot) return true;
      return g.nodes.some((n) => reach[n.id] && Math.hypot(n.x - slot.x, n.z - slot.z) <= slot.l / 2 + 5.5);
    });
    if (ok) return g;
  }
  return last as RoadGraph;
}

function reachableFrom(g: RoadGraph, map: MapData, p: { x: number; z: number }): boolean[] {
  const seen = new Array<boolean>(g.nodes.length).fill(false);
  const start = nearestNode(g, p.x, p.z, map);
  if (start < 0) return seen;
  const st = [start];
  seen[start] = true;
  while (st.length) {
    const u = st.pop()!;
    for (const e of g.adj[u]) if (!seen[e.to]) { seen[e.to] = true; st.push(e.to); }
  }
  return seen;
}
