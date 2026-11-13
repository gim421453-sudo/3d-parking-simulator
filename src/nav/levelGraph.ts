import { colliderIsSolidForCar, type Collider } from '../core/geometry';
import { SpatialIndex } from '../core/spatial';
import { groundAt, headroomAt, rampProfile, surfaceHeight, type Terrain } from '../maps/terrain';
import type { MapData, RoadSeg } from '../maps/types';
import { mapColliders } from '../maps/types';
import { spiralPassBand } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';
import { distToCollider } from './roadGraph';

/**
 * 다층 도로 그래프 (v0.5.4). 맵의 **실제 지형/충돌체 데이터**에서 만든 3D 주행 가능 그래프:
 *  - 노드: 각 데크(층 바닥) 위의 격자점(높이 포함) + 경사로 중심선 + 나선 램프 중심 반경선.
 *    차량 반폭+여유(clearance) 안에 그 높이 구간의 충돌체가 없고, 천장 높이가 차고 이상이며, 발밑에 실제 지면이 있어야 한다.
 *  - 간선: 같은 층의 이웃 격자점(8방향), 경사로/나선 위의 연속점, 경사로 끝 ↔ 그 높이의 데크 격자점.
 *    두 점 사이를 0.5m 간격으로 표본해 통과 가능(충돌체/지면 연속)할 때만 잇는다 → **지상에서 지하 칸으로 곧바로 가는 가짜 간선은 생기지 않는다.**
 *  - 차종: clearance(차폭)·height(차고)·나선 통과 가능 반경으로 그래프가 달라진다(통과 못 하는 길은 그래프에 없다).
 *  - 도로(`MapData.roads`) 위의 간선은 비용을 낮춰 도로를 우선하고, 일방통행 도로는 역방향 간선을 만들지 않는다.
 */
export interface LNode {
  id: number;
  x: number;
  z: number;
  y: number;
  kind: 'deck' | 'ramp' | 'spiral';
}
export interface LEdge {
  to: number;
  /** 비용(길이 × 가중) */
  w: number;
  len: number;
}
export interface LevelGraph {
  nodes: LNode[];
  adj: LEdge[][];
  spacing: number;
  clearance: number;
  height: number;
  buildMs: number;
}
export interface GraphOptions {
  spacing?: number;
  clearance?: number;
  /** 차고(천장 제한 검사) */
  height?: number;
  /** 나선 통과 검사에 쓸 차량(없으면 검사 안 함) */
  spec?: VehicleSpec;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function buildLevelGraph(map: MapData, o: GraphOptions = {}): LevelGraph {
  const t0 = now();
  const spacing = o.spacing ?? 3;
  const clearance = o.clearance ?? 1.4;
  const height = o.height ?? 1.75;
  const solids = mapColliders(map).filter(colliderIsSolidForCar);
  const index = new SpatialIndex(8);
  index.rebuild(solids);
  const b = map.bounds;
  const t: Terrain | undefined = map.terrain;
  const scratch: Collider[] = [];
  const clearAt = (x: number, z: number, y: number, r: number): boolean => {
    if (x < b.minX + r || x > b.maxX - r || z < b.minZ + r || z > b.maxZ - r) return false;
    index.query(x, z, r, scratch);
    for (const c of scratch) {
      if (c.y0 + c.h <= y + 0.2 || c.y0 >= y + height) continue; // 다른 층 물체
      if (distToCollider(x, z, c) < r) return false;
    }
    return true;
  };
  /** 그 높이에 실제 지면이 있는가 (지형 맵) */
  const grounded = (x: number, z: number, y: number, step = 0.35): boolean => {
    if (!t) return true;
    const g = groundAt(t, x, z, y, step);
    return g !== null && Math.abs(g - y) <= step;
  };
  const supported = (x: number, z: number, y: number): boolean => {
    if (!t) return true;
    if (!grounded(x, z, y, 0.06)) return false;
    const r = Math.min(0.9, clearance * 0.65);
    return grounded(x + r, z, y) && grounded(x - r, z, y) && grounded(x, z + r, y) && grounded(x, z - r, y);
  };
  const roomy = (x: number, z: number, y: number): boolean => !t || headroomAt(t, x, z, y) >= height;

  const nodes: LNode[] = [];
  const adj: LEdge[][] = [];
  const add = (x: number, z: number, y: number, kind: LNode['kind']): number => {
    nodes.push({ id: nodes.length, x, z, y, kind });
    adj.push([]);
    return nodes.length - 1;
  };
  // ---- 데크(층 바닥) 격자 노드 ----
  // 지상(y≈0)은 spacing(3m), 그 밖의 층(상층/지하)은 통로가 좁으므로 2m 격자를 쓴다(격자 정렬에 따라 좁은 통로를 놓치지 않게)
  const fine = Math.min(2, spacing);
  const stepOf = (y: number): number => (Math.abs(y) < 0.05 ? spacing : fine);
  const gridKey = (ix: number, iz: number, y: number): string => `${ix},${iz},${Math.round(y * 10)}`;
  const grid = new Map<string, number>();
  const tryGrid = (ix: number, iz: number, y: number): void => {
    const k = gridKey(ix, iz, y);
    if (grid.has(k)) return;
    const sp = stepOf(y);
    const x = ix * sp;
    const z = iz * sp;
    if (!roomy(x, z, y) || !supported(x, z, y) || !clearAt(x, z, y, clearance)) return;
    grid.set(k, add(x, z, y, 'deck'));
  };
  if (!t) {
    for (let ix = Math.ceil(b.minX / spacing); ix <= Math.floor(b.maxX / spacing); ix++) for (let iz = Math.ceil(b.minZ / spacing); iz <= Math.floor(b.maxZ / spacing); iz++) tryGrid(ix, iz, 0);
  } else {
    for (const s of t.surfaces) {
      if (s.kind !== 'deck') continue;
      const r = s.rect;
      const sp = stepOf(s.y);
      const ext = Math.hypot(r.w, r.d) / 2;
      const x0 = Math.ceil(Math.max(b.minX, r.x - ext) / sp);
      const x1 = Math.floor(Math.min(b.maxX, r.x + ext) / sp);
      const z0 = Math.ceil(Math.max(b.minZ, r.z - ext) / sp);
      const z1 = Math.floor(Math.min(b.maxZ, r.z + ext) / sp);
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) if (surfaceHeight(s, ix * sp, iz * sp) !== null) tryGrid(ix, iz, s.y);
    }
  }

  // ---- 간선 ----
  const roads = map.roads ?? [];
  const onRoad = (x: number, z: number): RoadSeg | null => {
    for (const r of roads) {
      const dx = r.bx - r.ax;
      const dz = r.bz - r.az;
      const l2 = dx * dx + dz * dz;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - r.ax) * dx + (z - r.az) * dz) / l2));
      if (Math.hypot(x - (r.ax + dx * u), z - (r.az + dz * u)) <= r.width / 2) return r;
    }
    return null;
  };
  const paved = (x: number, z: number): boolean => {
    for (let i = map.surfaces.length - 1; i >= 0; i--) {
      const sf = map.surfaces[i];
      if (Math.abs(x - sf.x) <= sf.w / 2 && Math.abs(z - sf.z) <= sf.d / 2) return sf.kind !== 'grass';
    }
    return false;
  };
  const segOk = (A: LNode, B: LNode, r: number): boolean => {
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const x = A.x + (B.x - A.x) * k;
      const z = A.z + (B.z - A.z) * k;
      let y = A.y + (B.y - A.y) * k;
      if (t) {
        const g = groundAt(t, x, z, y, 0.6);
        if (g === null) return false;
        y = g;
        if (headroomAt(t, x, z, y) < height) return false;
      }
      if (!clearAt(x, z, y, r)) return false;
    }
    return true;
  };
  const link = (a: number, c: number, checkR: number | null): boolean => {
    const A = nodes[a];
    const B = nodes[c];
    if (checkR !== null && !segOk(A, B, checkR)) return false;
    const len = Math.hypot(A.x - B.x, A.z - B.z, A.y - B.y);
    const mx = (A.x + B.x) / 2;
    const mz = (A.z + B.z) / 2;
    const flat = Math.abs(A.y) < 0.05 && Math.abs(B.y) < 0.05;
    const road = flat ? onRoad(mx, mz) : null;
    // 비용 가중: 도로 0.6(우선) · 포장면(주차장/구역 바닥) 1 · 도로망이 있는 맵의 비포장(잔디) 8 — 잔디밭을 가로지르는 지름길을 내지 않는다
    const w = len * (road ? 0.6 : flat && roads.length && !paved(mx, mz) ? 8 : 1);
    let fwd = true;
    let back = true;
    if (road?.oneway) {
      const dot = (B.x - A.x) * (road.bx - road.ax) + (B.z - A.z) * (road.bz - road.az);
      if (dot > 1e-6) back = false;
      else if (dot < -1e-6) fwd = false;
    }
    if (fwd) adj[a].push({ to: c, w, len });
    if (back) adj[c].push({ to: a, w, len });
    return true;
  };
  const gridNodes = nodes.length;
  for (let a = 0; a < gridNodes; a++) {
    const A = nodes[a];
    const sp = stepOf(A.y);
    const ix = Math.round(A.x / sp);
    const iz = Math.round(A.z / sp);
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ] as const) {
      const c = grid.get(gridKey(ix + dx, iz + dz, A.y));
      if (c !== undefined) link(a, c, clearance * 0.95);
    }
  }
  // ---- 경사로/나선: 중심선 노드 사슬 + 양 끝을 그 높이의 데크 노드에 연결 ----
  const attach = (id: number): void => {
    const A = nodes[id];
    let n = 0;
    const cands: { j: number; d: number }[] = [];
    for (let j = 0; j < gridNodes; j++) {
      const B = nodes[j];
      if (Math.abs(B.y - A.y) > 0.6) continue;
      const d = Math.hypot(B.x - A.x, B.z - A.z);
      if (d <= spacing * 1.6) cands.push({ j, d });
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands) {
      if (link(id, c.j, clearance * 0.9)) n++;
      if (n >= 3) break;
    }
  };
  if (t) {
    for (const s of t.surfaces) {
      if (s.kind === 'ramp') {
        if (s.width / 2 < clearance) continue; // 차폭이 넓어 통과 불가
        const fx = Math.sin(s.rot);
        const fz = Math.cos(s.rot);
        const n = Math.max(2, Math.ceil(s.length / 2));
        const chain: number[] = [];
        // 양 끝 바깥으로 직선 연장(1.5m, 4m, 6.5m): 차량이 경사로와 **정렬된 뒤** 진입하도록 접속점을 경사로 축 위에 둔다(옆에서 비스듬히 들어와 측벽에 닿는 경로 방지)
        const us: number[] = [-6.5, -4, -1.5];
        for (let i = 0; i <= n; i++) us.push((s.length * i) / n);
        us.push(s.length + 1.5, s.length + 4, s.length + 6.5);
        for (const u of us) {
          const x = s.x + fx * u;
          const z = s.z + fz * u;
          const y = groundAt(t, x, z, s.y0 + (s.y1 - s.y0) * rampProfile(u, s.length, s.ease), 0.5);
          if (y === null || !roomy(x, z, y) || !clearAt(x, z, y, clearance * 0.9)) {
            chain.push(-1);
            continue;
          }
          chain.push(add(x, z, y, 'ramp'));
        }
        for (let i = 1; i < chain.length; i++) if (chain[i] >= 0 && chain[i - 1] >= 0) link(chain[i - 1], chain[i], clearance * 0.85);
        // 접속: 각 끝에서 경사로 본체와 이어진 가장 바깥 연장점만 데크 격자에 연결
        const first = chain.findIndex((c) => c >= 0);
        let lo = 3;
        while (lo > 0 && chain[lo - 1] >= 0) lo--;
        let hi = chain.length - 4;
        while (hi < chain.length - 1 && chain[hi + 1] >= 0) hi++;
        if (chain[3] >= 0 && chain[lo] >= 0) attach(chain[lo]);
        if (chain[chain.length - 4] >= 0 && chain[hi] >= 0) attach(chain[hi]);
        void first;
      } else if (s.kind === 'spiral') {
        // 차량이 실제로 돌 수 있는 뒷축 반경 구간이 있어야 한다. 경로선은 그 구간의 가운데.
        let rm = (s.r0 + s.r1) / 2;
        if (o.spec) {
          const band = spiralPassBand(o.spec, s.r0, s.r1, 2.5, 0.15);
          if (band.hi - band.lo < 0.3) continue;
          rm = (band.lo + band.hi) / 2 + 0.2;
        } else if ((s.r1 - s.r0) / 2 < clearance) continue;
        const span = s.th1 - s.th0;
        const n = Math.max(6, Math.ceil((Math.abs(span) * rm) / 1.6));
        const chain: number[] = [];
        for (let i = 0; i <= n; i++) {
          const th = s.th0 + (span * i) / n;
          const x = s.cx + rm * Math.cos(th);
          const z = s.cz + rm * Math.sin(th);
          const y = s.y0 + ((s.y1 - s.y0) * i) / n;
          chain.push(add(x, z, y, 'spiral'));
        }
        // 나선 위 사슬은 차량이 통과 가능함을 위에서(반경 구간) 확인했으므로 충돌체 표본 반경을 줄여 잇는다(벽이 곡선이라 중심선 여유가 작게 보인다)
        for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i], Math.min(clearance * 0.7, (s.r1 - s.r0) / 2 - 0.3));
        // 양 끝: 접선 방향으로 2.2m, 5m 나간 점을 거쳐 데크에 접속 (정렬된 진입/진출)
        for (const [idx, th, sign] of [
          [chain[0], s.th0, -1],
          [chain[n], s.th1, 1],
        ] as const) {
          const dir = Math.sign(span) * sign;
          let last: number = idx;
          for (const dist of [2.2, 5]) {
            const ex = nodes[idx].x + -Math.sin(th) * dir * dist;
            const ez = nodes[idx].z + Math.cos(th) * dir * dist;
            const ey = groundAt(t, ex, ez, nodes[last].y, 0.5);
            if (ey === null || !clearAt(ex, ez, ey, clearance * 0.8)) break;
            const e = add(ex, ez, ey, 'ramp');
            if (!link(last, e, clearance * 0.7)) break;
            last = e;
          }
          attach(last);
        }
      }
    }
  }
  return { nodes, adj, spacing, clearance, height, buildMs: now() - t0 };
}

/** 차량 제원 → 그래프 등급(같은 등급은 그래프를 공유). margin = 차체 옆 여유 */
export function graphClass(spec: VehicleSpec, margin = 0.35): { clearance: number; height: number; key: string } {
  const clearance = Math.ceil((spec.width / 2 + margin) * 20) / 20;
  const height = Math.ceil((spec.height + 0.05) * 10) / 10;
  return { clearance, height, key: `${clearance.toFixed(2)}|${height.toFixed(1)}|${spec.length.toFixed(1)}|${spec.wheelbase.toFixed(1)}` };
}

/** 모든 미션 목적지가 시작 위치에서 도달 가능한가 */
function missionsReachable(map: MapData, g: LevelGraph): boolean {
  return map.missions.every((ms) => {
    const sp = ms.spawn ?? map.spawn;
    const sl = map.slots.find((q) => q.id === ms.slotId);
    if (!sl) return true;
    return findLevelRoute(g, { x: sp.x, z: sp.z, y: sp.y ?? 0 }, { x: sl.x, z: sl.z, y: sl.y ?? 0 }) !== null;
  });
}

const cache = new WeakMap<MapData, Map<string, LevelGraph>>();
/**
 * 차량에 맞는 그래프. 차체 옆 여유가 넉넉한(0.7m) 그래프부터 시도하고, 좁은 맵에서 미션 목적지에 닿지 못하면 여유를 줄인다(0.5 → 0.35).
 * 여유가 클수록 벽에서 떨어진 경로가 나온다.
 */
export function levelGraphFor(map: MapData, spec: VehicleSpec): LevelGraph {
  let m = cache.get(map);
  if (!m) cache.set(map, (m = new Map()));
  const base = graphClass(spec);
  const hit = m.get(base.key);
  if (hit) return hit;
  let g: LevelGraph | null = null;
  for (const margin of [0.7, 0.5, 0.35]) {
    const c = graphClass(spec, margin);
    g = buildLevelGraph(map, { clearance: c.clearance, height: c.height, spec });
    if (missionsReachable(map, g)) break;
  }
  m.set(base.key, g as LevelGraph);
  return g as LevelGraph;
}

export interface Pt3 {
  x: number;
  z: number;
  y: number;
}
export interface LevelRoute {
  points: Pt3[];
  length: number;
  dest: Pt3;
  /** 경로가 지나는 그래프 노드 */
  nodeIds: number[];
}

/** 같은 층(|Δy| ≤ tol)에서 가장 가까운 노드들 (가까운 순, 최대 k개) */
export function nearestNodes(g: LevelGraph, p: Pt3, k = 6, tol = 1.0, maxDist = Infinity): number[] {
  const c: { i: number; d: number }[] = [];
  for (const n of g.nodes) {
    if (Math.abs(n.y - p.y) > tol) continue;
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d <= maxDist) c.push({ i: n.id, d });
  }
  c.sort((a, b) => a.d - b.d);
  return c.slice(0, k).map((q) => q.i);
}

class Heap {
  private a: { i: number; f: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(i: number, f: number): void {
    const a = this.a;
    a.push({ i, f });
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (a[p].f <= a[k].f) break;
      [a[p], a[k]] = [a[k], a[p]];
      k = p;
    }
  }
  pop(): { i: number; f: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        k = m;
      }
    }
    return top;
  }
}

/** A*: 여러 시작/목표 후보 노드 사이의 최소 비용 경로. 없으면 null */
export function astar(g: LevelGraph, starts: number[], goals: Set<number>, goalPt: Pt3): number[] | null {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const h = (i: number): number => Math.hypot(g.nodes[i].x - goalPt.x, g.nodes[i].z - goalPt.z, g.nodes[i].y - goalPt.y) * 0.6; // 도로 가중(0.6)에 맞춘 허용 가능한 추정
  const heap = new Heap();
  for (const s of starts) {
    dist[s] = 0;
    heap.push(s, h(s));
  }
  while (heap.size) {
    const { i: u } = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (goals.has(u)) {
      const chain: number[] = [];
      for (let c = u; c >= 0; c = prev[c]) chain.push(c);
      return chain.reverse();
    }
    for (const e of g.adj[u]) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        heap.push(e.to, nd + h(e.to));
      }
    }
  }
  return null;
}

/**
 * 출발점 → 목적지(주차칸/시설 입구) 경로. 목적지 주변 반경 안의 **같은 층** 노드 중 하나에 도달한다.
 * 경로의 모든 점은 그래프 노드(실제 주행 가능 지점)이고 마지막에 목적지 점만 덧붙인다.
 */
export function findLevelRoute(g: LevelGraph, from: Pt3, dest: Pt3, destRadius = 8): LevelRoute | null {
  const starts = nearestNodes(g, from, 4, 1.0, 12);
  if (!starts.length) return null;
  const goalList = nearestNodes(g, dest, 12, 0.6, destRadius);
  if (!goalList.length) return null;
  const chain = astar(g, starts, new Set(goalList), dest);
  if (!chain) return null;
  const points: Pt3[] = [{ x: from.x, z: from.z, y: from.y }, ...chain.map((i) => ({ x: g.nodes[i].x, z: g.nodes[i].z, y: g.nodes[i].y })), { x: dest.x, z: dest.z, y: dest.y }];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z, points[i].y - points[i - 1].y);
  return { points, length, dest, nodeIds: chain };
}
