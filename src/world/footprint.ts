/**
 * 건물 바닥 다각형 도구 (v0.6.0, 순수 로직). 실제 지도(OSM) 건물을 충돌체로 쓰기 위해
 * 다각형을 **회전된 직사각형 여러 개**로 나눈다(충돌/센서 엔진은 OBB·원기둥만 다루므로).
 *  1. 방향: 다각형 각 변 방향 중 경계 직사각형 면적이 가장 작은 방향(최소 면적 사각형 근사)
 *  2. 그 방향 좌표계에서 res 간격 격자로 래스터화(칸 중심이 다각형 안이면 채움)
 *  3. 행마다 연속 구간 → 직사각형, 위아래 행의 같은 구간을 합쳐 큰 직사각형으로
 * 결과 상자는 실제 외곽에서 최대 res/2 안쪽/바깥으로 어긋난다(기본 1m → ±0.5m).
 */
export type Pt = [number, number];

export function polyArea(p: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function pointInPoly(p: readonly Pt[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

export function centroid(p: readonly Pt[]): Pt {
  let x = 0;
  let z = 0;
  for (const q of p) {
    x += q[0];
    z += q[1];
  }
  return [x / p.length, z / p.length];
}

/** 게임 상자 규칙(heading rot: 로컬 x 축의 월드 방향 = (cos rot, −sin rot)) */
export interface FootBox {
  x: number;
  z: number;
  /** 로컬 x 폭 */
  w: number;
  /** 로컬 z 깊이 */
  d: number;
  rot: number;
}

/** 최소 면적 경계 사각형에 가까운 방향(라디안, 월드 (x,z) 에서 u 축 각도 atan2(dz,dx)) */
export function mainAxis(p: readonly Pt[]): number {
  let best = 0;
  let bestA = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const q of p) {
      const u = q[0] * c + q[1] * s;
      const v = -q[0] * s + q[1] * c;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const A = (u1 - u0) * (v1 - v0);
    if (A < bestA - 1e-9) {
      bestA = A;
      best = ang;
    }
  }
  return best;
}

export function footprintBoxes(p: readonly Pt[], res = 1): FootBox[] {
  if (p.length < 3) return [];
  const ang = mainAxis(p);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const loc: Pt[] = p.map(([x, z]) => [x * c + z * s, -x * s + z * c]);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [u, v] of loc) {
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  // 작은 건물은 칸을 줄여 형태를 잃지 않게(한 변이 3칸 이상)
  const r = Math.max(0.35, Math.min(res, (u1 - u0) / 3, (v1 - v0) / 3));
  const nu = Math.max(1, Math.round((u1 - u0) / r));
  const nv = Math.max(1, Math.round((v1 - v0) / r));
  const du = (u1 - u0) / nu;
  const dv = (v1 - v0) / nv;
  // 행(v) 마다 연속 구간
  type Run = { a: number; b: number; r0: number; r1: number };
  let open: Run[] = [];
  const done: Run[] = [];
  for (let j = 0; j < nv; j++) {
    const vc = v0 + (j + 0.5) * dv;
    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= nu; i++) {
      const inside = i < nu && pointInPoly(loc, u0 + (i + 0.5) * du, vc);
      if (inside && start < 0) start = i;
      if (!inside && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }
    const next: Run[] = [];
    for (const [a, b] of runs) {
      const k = open.findIndex((o) => o.a === a && o.b === b);
      if (k >= 0) {
        const o = open.splice(k, 1)[0];
        o.r1 = j + 1;
        next.push(o);
      } else next.push({ a, b, r0: j, r1: j + 1 });
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  // 로컬(u,v) → 월드: (x,z) = u·(c,s) + v·(−s,c). 상자의 로컬 x(폭) = u 축 → rot = atan2(−s, c)
  const rot = Math.atan2(-s, c);
  return done.map((q) => {
    const uc = u0 + ((q.a + q.b) / 2) * du;
    const vc = v0 + ((q.r0 + q.r1) / 2) * dv;
    return { x: uc * c - vc * s, z: uc * s + vc * c, w: (q.b - q.a) * du, d: (q.r1 - q.r0) * dv, rot };
  });
}

/** 점에서 폴리라인까지 거리 */
export function distToPolyline(pts: readonly Pt[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * u), z - (az + dz * u)));
  }
  return best;
}
