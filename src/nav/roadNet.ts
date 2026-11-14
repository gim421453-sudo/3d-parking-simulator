/**
 * 실제 도로망 경로 탐색 (v0.6.0, 순수 로직). 실제 지도(OSM)의 도로 중심선 그래프에서 A* 로 길을 찾는다.
 *  - 노드 = 도로 중심선의 점, 간선 = 연속한 두 점(일방통행이면 a→b 만)
 *  - 출발/도착 지점은 가장 가까운 간선 위로 투영해 가상 노드로 잇는다(일방통행 간선이면 진행 방향 끝으로만)
 *  - 그리드 탐색(levelGraph)을 쓰지 않으므로 1km 지도에서도 즉시 계산된다.
 * 도로망 데이터가 실제 도로를 따라가므로 "지어낸 경로"가 아니다. 도로망 밖(주차장 안)은 마지막 직선 구간으로만 잇는다.
 */
export interface RoadNet {
  nodes: [number, number][];
  /** [a, b, 일방통행(a→b 만)] */
  edges: [number, number, 0 | 1][];
}
export interface NetEdge {
  to: number;
  w: number;
}
export interface RoadNetGraph {
  nodes: [number, number][];
  adj: NetEdge[][];
  edges: [number, number, 0 | 1][];
}

export function buildRoadNetGraph(net: RoadNet): RoadNetGraph {
  const adj: NetEdge[][] = net.nodes.map(() => []);
  for (const [a, b, one] of net.edges) {
    const w = Math.hypot(net.nodes[b][0] - net.nodes[a][0], net.nodes[b][1] - net.nodes[a][1]);
    adj[a].push({ to: b, w });
    if (!one) adj[b].push({ to: a, w });
  }
  return { nodes: net.nodes, adj, edges: net.edges };
}

export interface EdgeHit {
  e: number;
  a: number;
  b: number;
  t: number;
  x: number;
  z: number;
  d: number;
}

export function nearestEdge(g: RoadNetGraph, x: number, z: number): EdgeHit | null {
  let best: EdgeHit | null = null;
  g.edges.forEach(([a, b], e) => {
    const [ax, az] = g.nodes[a];
    const [bx, bz] = g.nodes[b];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { e, a, b, t, x: px, z: pz, d };
  });
  return best;
}

export interface RoadNetRoute {
  points: { x: number; z: number }[];
  length: number;
  /** 지나는 도로망 노드 */
  nodeIds: number[];
}

class MinHeap {
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
  pop(): number {
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
    return top.i;
  }
}

/** from → to 경로. 도로망까지 maxSnap(m) 보다 멀면 null */
export function findRoadNetRoute(g: RoadNetGraph, from: { x: number; z: number }, to: { x: number; z: number }, maxSnap = 60): RoadNetRoute | null {
  const s = nearestEdge(g, from.x, from.z);
  const t = nearestEdge(g, to.x, to.z);
  if (!s || !t || s.d > maxSnap || t.d > maxSnap) return null;
  const P = g.nodes;
  const len = (i: number, x: number, z: number): number => Math.hypot(P[i][0] - x, P[i][1] - z);
  const oneS = g.edges[s.e][2];
  const oneT = g.edges[t.e][2];
  // 같은 간선 위에서 진행 방향이 맞으면 바로
  if (s.e === t.e && (!oneS || t.t >= s.t)) {
    const pts = [from, { x: s.x, z: s.z }, { x: t.x, z: t.z }, to];
    return { points: pts, length: polyLen(pts), nodeIds: [] };
  }
  const n = P.length;
  const G = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  // 출발: 투영점에서 간선 양 끝(일방통행이면 b 만)
  const seed = (i: number, c: number): void => {
    if (c < G[i]) {
      G[i] = c;
      prev[i] = -2;
      heap.push(i, c + len(i, t.x, t.z));
    }
  };
  seed(s.b, len(s.b, s.x, s.z));
  if (!oneS) seed(s.a, len(s.a, s.x, s.z));
  // 도착: 도착 간선의 끝점에서 투영점으로(일방통행이면 a 에서만 들어갈 수 있다)
  const goalCost = (i: number): number => (i === t.a ? len(t.a, t.x, t.z) : i === t.b && !oneT ? len(t.b, t.x, t.z) : Infinity);
  let best = Infinity;
  let bestNode = -1;
  const closed = new Uint8Array(n);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (G[u] >= best) break;
    const gc = goalCost(u);
    if (G[u] + gc < best) {
      best = G[u] + gc;
      bestNode = u;
    }
    for (const e of g.adj[u]) {
      const c = G[u] + e.w;
      if (c < G[e.to]) {
        G[e.to] = c;
        prev[e.to] = u;
        heap.push(e.to, c + len(e.to, t.x, t.z));
      }
    }
  }
  if (bestNode < 0) return null;
  const ids: number[] = [];
  for (let k = bestNode; k >= 0; k = prev[k]) ids.push(k);
  ids.reverse();
  const pts = [from, { x: s.x, z: s.z }, ...ids.map((i) => ({ x: P[i][0], z: P[i][1] })), { x: t.x, z: t.z }, to];
  return { points: pts, length: polyLen(pts), nodeIds: ids };
}

const polyLen = (p: { x: number; z: number }[]): number => {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  return s;
};

/** 연결 요소 크기(가장 큰 것) — 데이터 검증용 */
export function largestComponent(g: RoadNetGraph): number {
  const n = g.nodes.length;
  const und: number[][] = g.nodes.map(() => []);
  for (const [a, b] of g.edges) {
    und[a].push(b);
    und[b].push(a);
  }
  const seen = new Uint8Array(n);
  let best = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i] || !und[i].length) continue;
    let c = 0;
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const u = st.pop()!;
      c++;
      for (const v of und[u])
        if (!seen[v]) {
          seen[v] = 1;
          st.push(v);
        }
    }
    best = Math.max(best, c);
  }
  return best;
}
