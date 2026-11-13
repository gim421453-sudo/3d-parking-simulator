import { nearestNode, type RoadGraph } from './roadGraph';
import type { MapData, MapSlot } from '../maps/types';

export interface Pt {
  x: number;
  z: number;
  /** 높이(다층 경로). 평면 맵은 생략 */
  y?: number;
}
export interface Route {
  points: Pt[];
  length: number;
  dest: Pt;
}

export function dijkstra(g: RoadGraph, src: number): { dist: number[]; prev: number[] } {
  const n = g.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[src] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = true;
    for (const e of g.adj[u]) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
    }
  }
  return { dist, prev };
}

/** 슬롯 진입 지점 후보: 슬롯 중심 주변 반경 안의 도로 노드 중 경로 비용이 가장 낮은 것 */
export function findRoute(g: RoadGraph, map: MapData, from: Pt, slot: MapSlot): Route | null {
  const src = nearestNode(g, from.x, from.z, map);
  if (src < 0) return null;
  const { dist, prev } = dijkstra(g, src);
  const R = slot.l / 2 + 5.5;
  let best = -1;
  let bc = Infinity;
  for (const n of g.nodes) {
    const dd = Math.hypot(n.x - slot.x, n.z - slot.z);
    if (dd > R || !isFinite(dist[n.id])) continue;
    const cost = dist[n.id] + dd * 1.5;
    if (cost < bc) { bc = cost; best = n.id; }
  }
  if (best < 0) return null;
  const chain: number[] = [];
  for (let c = best; c >= 0; c = prev[c]) chain.push(c);
  chain.reverse();
  const points: Pt[] = [{ x: from.x, z: from.z }, ...chain.map((i) => ({ x: g.nodes[i].x, z: g.nodes[i].z })), { x: slot.x, z: slot.z }];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { points: simplify(points, 0.9), length, dest: { x: slot.x, z: slot.z } };
}

/** Douglas–Peucker 단순화 */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const rec = (a: number, b: number): void => {
    let md = 0;
    let mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i], pts[a], pts[b]);
      if (d > md) { md = d; mi = i; }
    }
    if (mi >= 0 && md > eps) { keep[mi] = true; rec(a, mi); rec(mi, b); }
  };
  rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
