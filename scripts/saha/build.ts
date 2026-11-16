/**
 * v0.6.2 부산 사하구 전체 지도 전처리 — 원본(data-raw/saha) → 게임용 타일(public/maps/saha).
 *   npx tsx scripts/saha/fetch-osm.ts   (OSM 원본, 1회)
 *   npx tsx scripts/saha/build.ts       (이 파일)
 *
 * 좌표: EPSG:5186(GRS80 TM) → 괴정역 원점 로컬 미터. +x = 동, +z = 남(북쪽 = −z, 기존 지도와 같은 규칙).
 * 높이: Copernicus GLO-30(DSM) → 열림 연산(건물 제거 근사) + 평활 = **추정 지표면**(열림 반경 100m). 괴정역 기계식 시설 자리를 y=0 으로 맞춘다
 *       (기계식 시설 키트가 y=0 바닥을 전제) — 해수면은 y = −seaOffset.
 * 데이터 계층 분리: OSM(ODbL) 도로/건물/면/경계, Copernicus(DEM) 지형. 출처는 manifest.sources 에 계층별로 남긴다.
 * 실제/추정 구분: 차로 수·폭·건물 높이·교량 종단은 값마다 출처 플래그(osm/est)를 둔다. 절차 생성 건물(빈 블록 채움)은 g:1·hs:'gen' 으로 표시해 실제 건물과 구분한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toTM, fromTM } from './lib/tm';
import { loadDem, sampleDem } from './lib/dem';

type P = [number, number];
const RAW = 'data-raw/saha';
const OUT = 'public/maps/saha';
const TILE = 240;
const CELL = 20; // 지형 격자(m)
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- 원점(괴정역)
const ORIGIN = { lat: 35.09975, lon: 128.99159 };
const [E0, N0] = toTM(ORIGIN.lat, ORIGIN.lon).map((v) => Math.round(v));
const proj = (lat: number, lon: number): P => {
  const [e, n] = toTM(lat, lon);
  return [e - E0, -(n - N0)];
};
const unproj = (x: number, z: number): [number, number] => fromTM(x + E0, -z + N0);

// ---------------------------------------------------------------- OSM XML 파서 (여러 파일, id 중복 제거)
const attr = (s: string, k: string): string | undefined => {
  const m = new RegExp(`\\s${k}="([^"]*)"`).exec(s);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'") : undefined;
};
const tagsOf = (body: string): Record<string, string> => {
  const t: Record<string, string> = {};
  for (const m of body.matchAll(/<tag\s[^>]*?\/>/g)) {
    const k = attr(m[0], 'k');
    const v = attr(m[0], 'v');
    if (k !== undefined && v !== undefined) t[k] = v;
  }
  return t;
};
interface Way {
  id: string;
  refs: string[];
  tags: Record<string, string>;
}
interface Rel {
  id: string;
  members: { type: string; ref: string; role: string }[];
  tags: Record<string, string>;
}
const nodeLL = new Map<string, [number, number]>();
/** 도로 표시용 노드 태그(횡단보도/신호) */
const nodeMark = new Map<string, 'cw' | 'sig'>();
const ways = new Map<string, Way>();
const rels = new Map<string, Rel>();
let osmBase: string | null = null;
function parseFile(f: string): void {
  const xml = fs.readFileSync(f, 'utf8');
  osmBase ??= /timestamp="([^"]+)"/.exec(xml)?.[1] ?? null;
  for (const m of xml.matchAll(/<node\s[^>]*?(\/>|>)/g)) {
    const id = attr(m[0], 'id');
    const lat = attr(m[0], 'lat');
    const lon = attr(m[0], 'lon');
    if (id && lat && lon) nodeLL.set(id, [Number(lat), Number(lon)]);
  }
  for (const m of xml.matchAll(/<node\s([^>]*)>([\s\S]*?)<\/node>/g)) {
    const id = attr(' ' + m[1], 'id');
    if (!id) continue;
    const t = tagsOf(m[2]);
    if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals') nodeMark.set(id, t.highway === 'traffic_signals' ? 'sig' : 'cw');
    if (t.highway === 'crossing' && t.crossing !== 'unmarked' && t.crossing !== 'no') nodeMark.set(id, 'cw');
  }
  for (const m of xml.matchAll(/<way\s([^>]*)>([\s\S]*?)<\/way>/g)) {
    const id = attr(' ' + m[1], 'id')!;
    if (ways.has(id)) continue;
    ways.set(id, { id, refs: [...m[2].matchAll(/<nd\s+ref="(\d+)"/g)].map((r) => r[1]), tags: tagsOf(m[2]) });
  }
  for (const m of xml.matchAll(/<relation\s([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const id = attr(' ' + m[1], 'id')!;
    if (rels.has(id)) continue;
    rels.set(id, { id, members: [...m[2].matchAll(/<member\s[^>]*?\/>/g)].map((x) => ({ type: attr(x[0], 'type') ?? '', ref: attr(x[0], 'ref') ?? '', role: attr(x[0], 'role') ?? '' })), tags: tagsOf(m[2]) });
  }
}
const files = fs.readdirSync(RAW).filter((n) => /^(map_|dong-)/.test(n) && n.endsWith('.osm'));
for (const f of files) parseFile(path.join(RAW, f));
const XY = new Map<string, P>();
const xy = (id: string): P | undefined => {
  let p = XY.get(id);
  if (!p) {
    const ll = nodeLL.get(id);
    if (!ll) return undefined;
    p = proj(ll[0], ll[1]);
    XY.set(id, p);
  }
  return p;
};

// ---------------------------------------------------------------- 기하 도우미
const area = (pts: P[]): number => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};
const inRing = (pts: P[], x: number, z: number): boolean => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const segDist = (x: number, z: number, a: P, b: P): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return Math.hypot(x - (a[0] + dx * u), z - (a[1] + dz * u));
};
const crossSeg = (a: P, b: P, c: P, d: P): boolean => {
  const o = (p: P, q: P, r: P): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};
/** 두 다각형이 겹치는가(변 교차 또는 포함) */
const polyOverlap = (A: P[], B: P[]): boolean => {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (crossSeg(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
  return inRing(B, A[0][0], A[0][1]) || inRing(A, B[0][0], B[0][1]);
};
function tidy(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.25) out.push(p);
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.25) out.pop();
  return out;
}
/** 멤버 way 들을 이어 닫힌 고리로 (OSM 멀티폴리곤 조립) */
function assemble(wayIds: string[]): { rings: string[][]; open: number } {
  const rem = wayIds.map((id) => ways.get(id)?.refs.slice()).filter((r): r is string[] => !!r && r.length > 1);
  const rings: string[][] = [];
  let open = 0;
  while (rem.length) {
    const ring = rem.shift()!;
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 10000) {
      const i = rem.findIndex((s) => s[0] === ring[ring.length - 1] || s[s.length - 1] === ring[ring.length - 1]);
      if (i < 0) break;
      const s = rem.splice(i, 1)[0];
      ring.push(...(s[0] === ring[ring.length - 1] ? s.slice(1) : s.reverse().slice(1)));
    }
    if (ring[0] === ring[ring.length - 1]) rings.push(ring.slice(0, -1));
    else open++;
  }
  return { rings, open };
}
const ringPts = (refs: string[]): P[] => refs.map((r) => xy(r)).filter((p): p is P => !!p);

// ---------------------------------------------------------------- 1. 경계: 하위 법정동 8개(육지) 합집합
const DONG_IDS = ['4057092', '4057252', '4057093', '4057253', '4057094', '4055272', '4055251', '4057095'];
interface Dong {
  id: string;
  name: string;
  outer: P[][];
  inner: P[][];
}
const dongs: Dong[] = [];
let boundaryOpen = 0;
for (const id of DONG_IDS) {
  const r = rels.get(id);
  if (!r) throw new Error('경계 관계 없음 ' + id);
  const o = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => m.ref));
  const i = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref));
  boundaryOpen += o.open + i.open;
  dongs.push({ id, name: r.tags.name ?? id, outer: o.rings.map(ringPts), inner: i.rings.map(ringPts) });
}
const landRings = dongs.flatMap((d) => d.outer);
const landHoles = dongs.flatMap((d) => d.inner);
const landArea = dongs.reduce((s, d) => s + d.outer.reduce((a, r) => a + Math.abs(area(r)), 0) - d.inner.reduce((a, r) => a + Math.abs(area(r)), 0), 0);
const inLand = (x: number, z: number): boolean => landRings.some((r) => inRing(r, x, z)) && !landHoles.some((r) => inRing(r, x, z));
const bEdges: [P, P][] = landRings.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]] as [P, P]));
const distToBoundary = (x: number, z: number): number => {
  let d = Infinity;
  for (const [a, b] of bEdges) d = Math.min(d, segDist(x, z, a, b));
  return d;
};
/** 경계 안 또는 경계에서 buf m 이내(경계를 넘는 도로의 완충 구간) */
const nearLand = (x: number, z: number, buf: number): boolean => inLand(x, z) || distToBoundary(x, z) <= buf;
const allB = landRings.flat();
const LB = { minX: Math.min(...allB.map((p) => p[0])), maxX: Math.max(...allB.map((p) => p[0])), minZ: Math.min(...allB.map((p) => p[1])), maxZ: Math.max(...allB.map((p) => p[1])) };
console.log(`경계: 법정동 ${dongs.length}, 고리 ${landRings.length}(+구멍 ${landHoles.length}), 열린 고리 ${boundaryOpen}, 면적 ${(landArea / 1e6).toFixed(2)}km²`);

// ---------------------------------------------------------------- 2. 지형: DEM → 20m 격자, 추정 지표면
const MARGIN = 400;
const FX0 = Math.floor((LB.minX - MARGIN) / CELL) * CELL;
const FZ0 = Math.floor((LB.minZ - MARGIN) / CELL) * CELL;
const FW = Math.ceil((LB.maxX + MARGIN - FX0) / CELL) + 1;
const FH = Math.ceil((LB.maxZ + MARGIN - FZ0) / CELL) + 1;
const demFiles = ['N35_00_E128_00', 'N35_00_E129_00', 'N34_00_E128_00', 'N34_00_E129_00'].map((t) => path.join(RAW, `Copernicus_DSM_COG_10_${t}_DEM.tif`));

(async () => {
  const llA = unproj(FX0, FZ0);
  const llB = unproj(FX0 + FW * CELL, FZ0 + FH * CELL);
  const dem = await loadDem(demFiles, { w: Math.min(llA[1], llB[1]) - 0.01, e: Math.max(llA[1], llB[1]) + 0.01, s: Math.min(llA[0], llB[0]) - 0.01, n: Math.max(llA[0], llB[0]) + 0.01 });
  const raw = new Float32Array(FW * FH);
  let demMissing = 0;
  for (let j = 0; j < FH; j++)
    for (let i = 0; i < FW; i++) {
      const [la, lo] = unproj(FX0 + i * CELL, FZ0 + j * CELL);
      let v = sampleDem(dem, la, lo);
      if (!Number.isFinite(v)) {
        v = 0;
        demMissing++;
      }
      raw[j * FW + i] = Math.max(0, v);
    }
  // 열림(최솟값 → 최댓값, 반경 R 칸) + 가우시안 평활: DSM 의 건물/수목 돌출 제거(근사)
  const R = 5; // 100m: 열림은 평면 경사를 보존하고 폭 200m 미만 돌출(아파트 단지 등)만 깎는다
  const morph = (src: Float32Array, fn: (a: number, b: number) => number): Float32Array => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let j = 0; j < FH; j++)
      for (let i = 0; i < FW; i++) {
        let v = src[j * FW + i];
        for (let k = -R; k <= R; k++) {
          const ii = i + k;
          if (ii >= 0 && ii < FW) v = fn(v, src[j * FW + ii]);
        }
        tmp[j * FW + i] = v;
      }
    for (let j = 0; j < FH; j++)
      for (let i = 0; i < FW; i++) {
        let v = tmp[j * FW + i];
        for (let k = -R; k <= R; k++) {
          const jj = j + k;
          if (jj >= 0 && jj < FH) v = fn(v, tmp[jj * FW + i]);
        }
        out[j * FW + i] = v;
      }
    return out;
  };
  const opened = morph(morph(raw, Math.min), Math.max);
  const blur = (src: Float32Array, rad: number): Float32Array => {
    const w = Array.from({ length: 2 * rad + 1 }, (_, k) => Math.exp(-((k - rad) ** 2) / (2 * (rad / 2) ** 2)));
    const pass = (s: Float32Array, horiz: boolean): Float32Array => {
      const o = new Float32Array(s.length);
      for (let j = 0; j < FH; j++)
        for (let i = 0; i < FW; i++) {
          let acc = 0;
          let ws = 0;
          for (let k = -rad; k <= rad; k++) {
            const ii = horiz ? i + k : i;
            const jj = horiz ? j : j + k;
            if (ii < 0 || jj < 0 || ii >= FW || jj >= FH) continue;
            acc += s[jj * FW + ii] * w[k + rad];
            ws += w[k + rad];
          }
          o[j * FW + i] = acc / ws;
        }
      return o;
    };
    return pass(pass(src, true), false);
  };
  const dtm = blur(opened, 3);
  const fieldAt = (x: number, z: number, f = dtm): number => {
    const fx = Math.max(0, Math.min(FW - 1.0001, (x - FX0) / CELL));
    const fz = Math.max(0, Math.min(FH - 1.0001, (z - FZ0) / CELL));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    // 렌더 메시와 같은 삼각형 분할(대각선 (i,j)–(i+1,j+1))의 평면 보간
    const h00 = f[j * FW + i];
    const h10 = f[j * FW + i + 1];
    const h01 = f[(j + 1) * FW + i];
    const h11 = f[(j + 1) * FW + i + 1];
    return u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h11 - h01) * u + (h01 - h00) * v;
  };

  // 기계식 시설 자리(기존 괴정동 맵 GJ_FACILITY (26,38) — 당시 등장방형 투영 기준) → 새 좌표, 주변 평탄화
  const oldLL = (x: number, z: number): [number, number] => [ORIGIN.lat - z / 111320, ORIGIN.lon + x / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180))];
  const fac = proj(...oldLL(26, 38));
  const SEA_ZERO = fieldAt(fac[0], fac[1]); // 시설 바닥 = y 0
  for (let j = 0; j < FH; j++)
    for (let i = 0; i < FW; i++) {
      const d = Math.hypot(FX0 + i * CELL - fac[0], FZ0 + j * CELL - fac[1]);
      const k = d <= 45 ? 1 : d >= 90 ? 0 : 1 - (d - 45) / 45;
      dtm[j * FW + i] = dtm[j * FW + i] * (1 - k) + SEA_ZERO * k;
    }
  // 바다: DSM ≤ 0.3m 이고 육지 경계 밖 → 해저(해수면 −2.5m)로 내려 물 평면과 겹치지 않게
  const LAND = new Uint8Array(FW * FH);
  let seaCells = 0;
  for (let j = 0; j < FH; j++)
    for (let i = 0; i < FW; i++) {
      const x = FX0 + i * CELL;
      const z = FZ0 + j * CELL;
      const land = inLand(x, z);
      LAND[j * FW + i] = land ? 1 : 0;
      if (!land && raw[j * FW + i] <= 0.3 && distToBoundary(x, z) > 40) {
        dtm[j * FW + i] = -2.5;
        seaCells++;
      }
    }

  // ---------------------------------------------------------------- 3. 토지피복(격자): 0 시가지 1 풀 2 숲 3 물 4 모래
  const cover = new Uint8Array(FW * FH);
  for (let k = 0; k < cover.length; k++) if (dtm[k] < -1) cover[k] = 3;
  const coverOf = (t: Record<string, string>): number => {
    if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 2;
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'wetland' || t.landuse === 'reservoir') return 3;
    if (t.natural === 'beach' || t.natural === 'sand') return 4;
    if (t.leisure === 'park' || t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'farmland' || t.natural === 'grassland' || t.leisure === 'golf_course' || t.landuse === 'recreation_ground' || t.landuse === 'cemetery') return 1;
    return -1;
  };
  const raster = (outer: P[][], inner: P[][], val: number): void => {
    for (const r of outer) {
      const xs = r.map((p) => p[0]);
      const zs = r.map((p) => p[1]);
      const i0 = Math.max(0, Math.floor((Math.min(...xs) - FX0) / CELL));
      const i1 = Math.min(FW - 1, Math.ceil((Math.max(...xs) - FX0) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(...zs) - FZ0) / CELL));
      const j1 = Math.min(FH - 1, Math.ceil((Math.max(...zs) - FZ0) / CELL));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = FX0 + i * CELL;
          const z = FZ0 + j * CELL;
          if (inRing(r, x, z) && !inner.some((h) => inRing(h, x, z))) cover[j * FW + i] = val;
        }
    }
  };
  let coverPolys = 0;
  for (const w of ways.values()) {
    const v = coverOf(w.tags);
    if (v < 0 || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
    raster([ringPts(w.refs.slice(0, -1))], [], v);
    coverPolys++;
  }
  for (const r of rels.values()) {
    if (r.tags.type !== 'multipolygon') continue;
    const v = coverOf(r.tags);
    if (v < 0) continue;
    const o = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => m.ref));
    const i = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref));
    raster(o.rings.map(ringPts), i.rings.map(ringPts), v);
    coverPolys++;
  }

  // ---------------------------------------------------------------- 4. 도로
  const DRIVE: Record<string, { lanes2: number; lanes1: number; rank: number }> = {
    motorway: { lanes2: 4, lanes1: 2, rank: 6 },
    trunk: { lanes2: 6, lanes1: 3, rank: 6 },
    primary: { lanes2: 6, lanes1: 3, rank: 5 },
    secondary: { lanes2: 4, lanes1: 2, rank: 4 },
    tertiary: { lanes2: 2, lanes1: 1, rank: 3 },
    unclassified: { lanes2: 2, lanes1: 1, rank: 2 },
    residential: { lanes2: 2, lanes1: 1, rank: 2 },
    living_street: { lanes2: 1, lanes1: 1, rank: 1 },
    service: { lanes2: 1, lanes1: 1, rank: 1 },
  };
  const CLASSES = Object.keys(DRIVE);
  const LANE_W = 3.2;
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const v = Number(String(s).replace(/\s*(m|km\/h)$/, ''));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  interface RoadOut {
    id: string;
    name?: string;
    ref?: string;
    cls: number;
    link: boolean;
    oneway: 0 | 1;
    lanes: number;
    fwd: number;
    bwd: number;
    lanesSrc: 'osm' | 'est';
    w: number;
    wSrc: 'osm' | 'lanes' | 'est' | 'fit';
    turn?: string;
    turnF?: string;
    turnB?: string;
    bus?: string;
    speed: number | null;
    surface: string;
    bridge: 0 | 1;
    tunnel: 0 | 1;
    layer: number;
    pts: [number, number, number][]; // x,z,y (조밀화 ≤8m, y = 노면 높이)
    nodeIdx: number[]; // pts 중 OSM 노드에 해당하는 인덱스(도로망 연결용, 나머지는 조밀화 점)
    refs: string[];
    profileSrc: 'dem' | 'deck-est';
  }
  const roads: RoadOut[] = [];
  const st = { ways: 0, skippedAccess: 0, outside: 0, lanesOsm: 0, lanesEst: 0, turnLanes: 0, maxspeed: 0, bridges: 0, tunnels: 0, lenTotal: 0, lenLanesOsm: 0 };
  for (const w of ways.values()) {
    const t = w.tags;
    const hw = t.highway;
    if (!hw) continue;
    const base = hw.replace(/_link$/, '');
    const def = DRIVE[base];
    if (!def) continue;
    if (t.area === 'yes') continue;
    if (t.access === 'no' || t.access === 'private' && base !== 'service' || t.motor_vehicle === 'no' || t.motorcar === 'no') {
      st.skippedAccess++;
      continue;
    }
    let refs = w.refs.filter((r) => nodeLL.has(r));
    if (refs.length < 2) continue;
    // 일방통행 정규화: -1 은 점 순서를 뒤집어 1 로
    let oneway: 0 | 1 = 0;
    const ow = t.oneway;
    if (ow === '-1' || ow === 'reverse') {
      refs = refs.slice().reverse();
      oneway = 1;
    } else if (ow === 'yes' || ow === '1' || ow === 'true') oneway = 1;
    else if (ow !== 'no' && (t.junction === 'roundabout' || t.junction === 'circular' || base === 'motorway')) oneway = 1;
    // 경계 안(또는 150m 완충)인 구간만
    const pts0 = refs.map((r) => xy(r)!);
    const keep = pts0.map((p, i) => (i ? nearLand((p[0] + pts0[i - 1][0]) / 2, (p[1] + pts0[i - 1][1]) / 2, 150) : false));
    // 연속 구간으로 나눈다
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = 1; i < refs.length; i++) {
      if (keep[i]) {
        if (!cur.length) cur.push(i - 1);
        cur.push(i);
      } else if (cur.length) {
        runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    if (!runs.length) {
      st.outside++;
      continue;
    }
    st.ways++;
    const lanesTag = num(t.lanes);
    const fT = num(t['lanes:forward']);
    const bT = num(t['lanes:backward']);
    let lanes: number;
    let fwd: number;
    let bwd: number;
    let lanesSrc: 'osm' | 'est';
    if (lanesTag) {
      lanes = Math.round(lanesTag);
      lanesSrc = 'osm';
      if (oneway) {
        fwd = lanes;
        bwd = 0;
      } else if (fT || bT) {
        fwd = Math.round(fT ?? lanes - (bT ?? 0));
        bwd = Math.round(bT ?? lanes - fwd);
      } else {
        fwd = Math.ceil(lanes / 2);
        bwd = lanes - fwd;
      }
    } else {
      lanesSrc = 'est';
      lanes = hw.endsWith('_link') ? 1 : oneway ? def.lanes1 : def.lanes2;
      fwd = oneway ? lanes : Math.ceil(lanes / 2);
      bwd = oneway ? 0 : lanes - fwd;
    }
    if (lanesSrc === 'osm') st.lanesOsm++;
    else st.lanesEst++;
    const wTag = num(t.width);
    const w2 = wTag && wTag > 2 ? wTag : Math.max(3.0, lanes * LANE_W + (def.rank >= 4 ? 1.0 : 0.4));
    const wSrc: RoadOut['wSrc'] = wTag && wTag > 2 ? 'osm' : lanesSrc === 'osm' ? 'lanes' : 'est';
    const turn = t['turn:lanes'];
    const turnF = t['turn:lanes:forward'];
    const turnB = t['turn:lanes:backward'];
    if (turn || turnF || turnB) st.turnLanes++;
    const speed = num(t.maxspeed);
    if (speed) st.maxspeed++;
    const bridge: 0 | 1 = t.bridge && t.bridge !== 'no' ? 1 : 0;
    const tunnel: 0 | 1 = t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage' ? 1 : 0;
    if (bridge) st.bridges++;
    if (tunnel) st.tunnels++;
    runs.forEach((run, k) => {
      // 조밀화(≤8m) + 높이
      const pts: [number, number, number][] = [];
      const nodeIdx: number[] = [];
      for (let q = 0; q < run.length; q++) {
        const p = pts0[run[q]];
        if (q > 0) {
          const a = pts0[run[q - 1]];
          const L = Math.hypot(p[0] - a[0], p[1] - a[1]);
          const n = Math.ceil(L / 8);
          for (let s = 1; s < n; s++) pts.push([a[0] + ((p[0] - a[0]) * s) / n, a[1] + ((p[1] - a[1]) * s) / n, 0]);
        }
        nodeIdx.push(pts.length);
        pts.push([p[0], p[1], 0]);
      }
      let L = 0;
      const sAt: number[] = [0];
      for (let q = 1; q < pts.length; q++) sAt.push((L += Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1])));
      st.lenTotal += L;
      if (lanesSrc === 'osm') st.lenLanesOsm += L;
      if (bridge || tunnel) {
        // 상판(추정): 양 끝 지면 높이를 잇는 직선. 교량이 다른 도로 위를 지나면(layer≥1) 가운데를 최대 8% 경사로 올린다
        const ya = fieldAt(pts[0][0], pts[0][1]);
        const yb = fieldAt(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        const hump = bridge && Number(t.layer ?? 1) >= 1 ? 5.5 : 0;
        for (let q = 0; q < pts.length; q++) {
          const u = L ? sAt[q] / L : 0;
          let y = ya + (yb - ya) * u;
          if (hump) y += Math.min(hump, 0.08 * Math.min(sAt[q], L - sAt[q]));
          if (bridge) y = Math.max(y, fieldAt(pts[q][0], pts[q][1]) + (hump ? 0 : 0.3));
          pts[q][2] = r2(y);
        }
      } else for (const p of pts) p[2] = r2(fieldAt(p[0], p[1]));
      roads.push({
        id: `w${w.id}${runs.length > 1 ? `-${k}` : ''}`,
        name: t.name,
        ref: t.ref,
        cls: CLASSES.indexOf(base),
        link: hw.endsWith('_link'),
        oneway,
        lanes,
        fwd,
        bwd,
        lanesSrc,
        w: r1(w2),
        wSrc,
        turn,
        turnF,
        turnB,
        bus: t['lanes:bus'] ?? t['busway'],
        speed,
        surface: t.surface ?? 'unknown',
        bridge,
        tunnel,
        layer: Number(t.layer ?? 0) || 0,
        pts: pts.map(([x, z, y]) => [r1(x), r1(z), y]),
        nodeIdx,
        refs: run.map((i) => refs[i]),
        profileSrc: bridge || tunnel ? 'deck-est' : 'dem',
      });
    });
  }
  console.log(`도로: way ${st.ways}(경계 밖 ${st.outside}, 통행 금지 ${st.skippedAccess}) 조각 ${roads.length}, 총 ${(st.lenTotal / 1000).toFixed(1)}km, 차로 OSM ${st.lanesOsm}/추정 ${st.lanesEst}`);

  // ---------------------------------------------------------------- 5. 도로망 그래프 + 회전 제한
  const netIdx = new Map<string, number>();
  const netNodes: [number, number, number][] = [];
  const netEdges: [number, number, 0 | 1][] = [];
  const edgeCls: number[] = [];
  const edgeLanes: number[] = [];
  const edgeSpeed: number[] = [];
  const nodeOf = (ref: string, p: [number, number, number]): number => {
    let i = netIdx.get(ref);
    if (i === undefined) {
      i = netNodes.length;
      netNodes.push([p[0], p[1], r1(p[2])]);
      netIdx.set(ref, i);
    }
    return i;
  };
  for (const r of roads) {
    for (let q = 1; q < r.refs.length; q++) {
      const a = nodeOf(r.refs[q - 1], r.pts[r.nodeIdx[q - 1]]);
      const b = nodeOf(r.refs[q], r.pts[r.nodeIdx[q]]);
      if (a === b) continue;
      netEdges.push([a, b, r.oneway]);
      edgeCls.push(r.cls);
      edgeLanes.push(r.oneway ? r.fwd : Math.max(1, Math.min(r.fwd, r.bwd)));
      edgeSpeed.push(r.speed ?? 0);
    }
  }
  // 회전 제한: from(way)–via(node)–to(way) → 노드 3개 [u, v, w, only]
  const wayNodes = new Map<string, string[]>();
  for (const r of roads) {
    const id = r.id.replace(/^w/, '').replace(/-\d+$/, '');
    const a = wayNodes.get(id) ?? [];
    a.push(...r.refs);
    wayNodes.set(id, a);
  }
  const restrictions: [number, number, number, 0 | 1][] = [];
  let restrTotal = 0;
  for (const r of rels.values()) {
    if (r.tags.type !== 'restriction') continue;
    const kind = r.tags.restriction ?? r.tags['restriction:motorcar'];
    if (!kind) continue;
    restrTotal++;
    const from = r.members.find((m) => m.role === 'from' && m.type === 'way');
    const via = r.members.find((m) => m.role === 'via' && m.type === 'node');
    const to = r.members.find((m) => m.role === 'to' && m.type === 'way');
    if (!from || !via || !to) continue;
    const v = netIdx.get(via.ref);
    const fw = wayNodes.get(from.ref);
    const tw = wayNodes.get(to.ref);
    if (v === undefined || !fw || !tw) continue;
    const nb = (list: string[]): number | undefined => {
      const k = list.indexOf(via.ref);
      if (k < 0) return undefined;
      const n = list[k - 1] ?? list[k + 1];
      const alt = list[k + 1] ?? list[k - 1];
      return netIdx.get(k > 0 ? n : alt);
    };
    const u = nb(fw);
    const w2 = nb(tw);
    if (u === undefined || w2 === undefined) continue;
    restrictions.push([u, v, w2, kind.startsWith('only_') ? 1 : 0]);
  }
  // 연결성: 약연결 성분(길이 가중)
  const parent = netNodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of netEdges) parent[find(a)] = find(b);
  const compLen = new Map<number, number>();
  let netLen = 0;
  netEdges.forEach(([a, b]) => {
    const l = Math.hypot(netNodes[a][0] - netNodes[b][0], netNodes[a][1] - netNodes[b][1]);
    netLen += l;
    const c = find(a);
    compLen.set(c, (compLen.get(c) ?? 0) + l);
  });
  const mainComp = [...compLen.entries()].sort((a, b) => b[1] - a[1])[0];
  const connectedRatio = mainComp[1] / netLen;

  // ---------------------------------------------------------------- 6. 건물 (구멍 보존)
  interface BldOut {
    id: string;
    name?: string;
    kind: string;
    outer: P[];
    holes: P[][];
    h: number;
    levels: number | null;
    hSrc: 'osm-height' | 'osm-levels' | 'est';
    base: number;
  }
  const blds: BldOut[] = [];
  /**
   * v0.6.3: 건물 바닥 = 외곽선을 2m 간격으로 따라간 지면의 최저(이전: 꼭짓점 최저). 지형 삼각형이 변 중간에서 꺾여 내려가면
   * 경사지에서 벽 밑이 떠 보였다. 감사(quality.audit.floating)에 이 보정으로 내려간 건물 수·최대량을 남긴다.
   */
  const lowered = { n: 0, max: 0 };
  const outlineMin = (ring: P[]): number => {
    let mv = Infinity;
    let mVert = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 2));
      mVert = Math.min(mVert, fieldAt(a[0], a[1]));
      for (let q = 0; q < n; q++) mv = Math.min(mv, fieldAt(a[0] + ((b[0] - a[0]) * q) / n, a[1] + ((b[1] - a[1]) * q) / n));
    }
    if (mVert - mv > 0.05) {
      lowered.n++;
      lowered.max = Math.max(lowered.max, mVert - mv);
    }
    return mv;
  };
  const bst = { found: 0, outside: 0, tiny: 0, withLevels: 0, withHeight: 0, holes: 0, mpRels: 0, openRings: 0 };
  const EST_LV: Record<string, number> = { apartments: 15, house: 2, detached: 2, residential: 4, school: 4, university: 5, commercial: 5, retail: 2, industrial: 2, warehouse: 2, church: 3, kindergarten: 2, hospital: 6, office: 8, public: 4, hotel: 10, garage: 1, shed: 1, roof: 1 };
  const pushB = (id: string, outerRefs: string[], innerRefs: string[][], t: Record<string, string>): void => {
    bst.found++;
    let outer = tidy(ringPts(outerRefs));
    if (outer.length < 3 || Math.abs(area(outer)) < 10) {
      bst.tiny++;
      return;
    }
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
    const cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
    if (!nearLand(cx, cz, 20)) {
      bst.outside++;
      return;
    }
    if (area(outer) < 0) outer = outer.reverse();
    const holes = innerRefs.map((r) => tidy(ringPts(r))).filter((h) => h.length >= 3 && Math.abs(area(h)) > 4).map((h) => (area(h) > 0 ? h.reverse() : h));
    if (holes.length) bst.holes++;
    const hTag = num(t.height ?? t['building:height']);
    const lvTag = num(t['building:levels']);
    let h: number;
    let hSrc: BldOut['hSrc'];
    if (hTag && hTag > 2) {
      h = hTag;
      hSrc = 'osm-height';
      bst.withHeight++;
    } else if (lvTag) {
      h = lvTag * 3.0 + 1.0;
      hSrc = 'osm-levels';
      bst.withLevels++;
    } else {
      h = (EST_LV[t.building] ?? 3) * 3.0 + 1.0;
      hSrc = 'est';
    }
    const base = outlineMin(outer);
    blds.push({ id, name: t.name, kind: t.building ?? 'yes', outer: outer.map(([x, z]) => [r1(x), r1(z)]), holes: holes.map((r) => r.map(([x, z]) => [r1(x), r1(z)] as P)), h: r1(h), levels: lvTag, hSrc, base: r2(base) });
  };
  for (const w of ways.values()) {
    const b = w.tags.building;
    if (!b || b === 'no' || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
    pushB(`w${w.id}`, w.refs.slice(0, -1), [], w.tags);
  }
  for (const r of rels.values()) {
    if (!r.tags.building || r.tags.type !== 'multipolygon') continue;
    bst.mpRels++;
    const o = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => m.ref));
    const i = assemble(r.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref));
    bst.openRings += o.open + i.open;
    o.rings.forEach((ring, k) => {
      const op = ringPts(ring);
      const holes = i.rings.filter((h) => {
        const hp = xy(h[0]);
        return hp && inRing(op, hp[0], hp[1]);
      });
      pushB(`r${r.id}-${k}`, ring, holes, r.tags);
    });
  }
  // 같은 건물이 way 와 관계로 중복 등록된 경우(외곽 중심이 1m 이내 + 면적 10% 이내) 관계 쪽을 남긴다
  const seen = new Map<string, BldOut>();
  let dup = 0;
  const cen = (b: BldOut): P => [b.outer.reduce((s, p) => s + p[0], 0) / b.outer.length, b.outer.reduce((s, p) => s + p[1], 0) / b.outer.length];
  const uniq: BldOut[] = [];
  for (const b of [...blds].sort((a, b2) => (a.id < b2.id ? 1 : -1))) {
    const c = cen(b);
    const k = `${Math.round(c[0])}:${Math.round(c[1])}`;
    const o = seen.get(k);
    if (o && Math.abs(Math.abs(area(o.outer)) - Math.abs(area(b.outer))) < 0.1 * Math.abs(area(o.outer))) {
      dup++;
      continue;
    }
    seen.set(k, b);
    uniq.push(b);
  }

  // ---------------------------------------------------------------- 6b. 추정 도로 폭을 실제 건물선에 맞춤(v0.6.3)
  // 감사: 실제 건물이 일반 도로 띠를 0.5m 이상 침범한 136건이 모두 '추정 폭' 구간이었다. 실제 건물 외곽은 보존하고,
  // 추정 폭(차로 수 × 3.2m 등)만 양옆 실제 건물까지의 거리에 맞춰 줄인다(최소 차로당 2.75m). OSM width 태그가 있는 도로는 그대로.
  const fitSt = { roads: 0, maxCut: 0 };
  {
    const EG = 40;
    const egrid = new Map<number, [P, P][]>();
    for (const b of uniq)
      for (let k = 0; k < b.outer.length; k++) {
        const a = b.outer[k];
        const c = b.outer[(k + 1) % b.outer.length];
        for (let i = Math.floor(Math.min(a[0], c[0]) / EG); i <= Math.floor(Math.max(a[0], c[0]) / EG); i++)
          for (let j = Math.floor(Math.min(a[1], c[1]) / EG); j <= Math.floor(Math.max(a[1], c[1]) / EG); j++) {
            const key = (i + 20000) * 40000 + (j + 20000);
            const l = egrid.get(key);
            if (l) l.push([a, c]);
            else egrid.set(key, [[a, c]]);
          }
      }
    for (const r of roads) {
      if (r.wSrc === 'osm' || r.tunnel || r.bridge || r.cls >= 8) continue;
      let minClear = Infinity;
      for (let q = 1; q < r.pts.length; q++) {
        const a = r.pts[q - 1];
        const b = r.pts[q];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(L / 2));
        for (let t = 0; t <= n; t++) {
          const x = a[0] + ((b[0] - a[0]) * t) / n;
          const z = a[1] + ((b[1] - a[1]) * t) / n;
          const i0 = Math.floor(x / EG);
          const j0 = Math.floor(z / EG);
          for (let i = i0 - 1; i <= i0 + 1; i++)
            for (let j = j0 - 1; j <= j0 + 1; j++)
              for (const [ea, eb] of egrid.get((i + 20000) * 40000 + (j + 20000)) ?? []) {
                const d = segDist(x, z, ea, eb);
                // 건물이 도로 중심선 위에 있으면(데이터 충돌) 폭으로 해결할 수 없어 제외 — 감사에 따로 남는다
                if (d > 0.6) minClear = Math.min(minClear, d);
              }
        }
      }
      if (minClear < r.w / 2) {
        // 최소 폭: 차로 수가 OSM 태그면 차로당 2.75m, 추정 차로의 소로(unclassified 이하)는 한 차로 골목 3.0m 까지
        const floor = r.lanesSrc === 'est' && r.cls >= 5 ? 3.0 : r.lanes * 2.75;
        const nw = Math.max(floor, 2 * (minClear - 0.3));
        if (nw < r.w - 0.05) {
          fitSt.roads++;
          fitSt.maxCut = Math.max(fitSt.maxCut, r.w - nw);
          r.w = r1(nw);
          r.wSrc = 'fit';
        }
      }
    }
    console.log(`추정 도로 폭을 실제 건물선에 맞춤: ${fitSt.roads}개 (최대 ${fitSt.maxCut.toFixed(1)}m 줄임)`);
  }

  // ---------------------------------------------------------------- 7. 주차장 면
  interface Lot {
    id: string;
    name?: string;
    pts: P[];
    y: number;
  }
  const lots: Lot[] = [];
  for (const w of ways.values()) {
    if (w.tags.amenity !== 'parking' || w.refs[0] !== w.refs[w.refs.length - 1] || w.tags.parking === 'underground' || w.tags.parking === 'multi-storey') continue;
    let pts = tidy(ringPts(w.refs.slice(0, -1)));
    if (pts.length < 3 || Math.abs(area(pts)) < 30) continue;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    if (!inLand(cx, cz)) continue;
    if (area(pts) < 0) pts = pts.reverse();
    lots.push({ id: `w${w.id}`, name: w.tags.name, pts: pts.map(([x, z]) => [r1(x), r1(z)]), y: r2(fieldAt(cx, cz)) });
  }

  // ---------------------------------------------------------------- 7b. 생성 건물(실제 아님): OSM 에 건물이 없는 시가지 블록 채우기
  // 규칙: 토지피복 '시가지' 칸, 도로 가장자리에서 3.5~40m(블록 앞쪽), 실제 건물·주차장·학교/공원/병원 등 시설 면·기계식 시설 자리와 겹치지 않음,
  //       경사 30% 미만. 2~5층 저층, 가까운 도로와 나란히. 결정적 난수(재현 가능). 타일에는 g:1·hs:'gen' 으로 실제 건물과 구분해 넣는다.
  const OCC = 4;
  const occ = new Set<number>();
  const okey = (i: number, j: number): number => (i + 20000) * 40000 + (j + 20000);
  const rasterOcc = (ring: P[], margin: number): void => {
    const xs = ring.map((p) => p[0]);
    const zs = ring.map((p) => p[1]);
    for (let i = Math.floor((Math.min(...xs) - margin) / OCC); i <= Math.floor((Math.max(...xs) + margin) / OCC); i++)
      for (let j = Math.floor((Math.min(...zs) - margin) / OCC); j <= Math.floor((Math.max(...zs) + margin) / OCC); j++) {
        const x = (i + 0.5) * OCC;
        const z = (j + 0.5) * OCC;
        if (inRing(ring, x, z) || ring.some((p, k) => segDist(x, z, p, ring[(k + 1) % ring.length]) <= margin + OCC * 0.71)) occ.add(okey(i, j));
      }
  };
  for (const b of uniq) rasterOcc(b.outer, 1.5);
  for (const l of lots) rasterOcc(l.pts, 1);
  const NOFILL = (t: Record<string, string>): boolean =>
    ['school', 'university', 'college', 'kindergarten', 'hospital', 'place_of_worship', 'parking', 'fuel', 'marketplace'].includes(t.amenity ?? '') ||
    !!t.leisure ||
    ['military', 'construction', 'railway', 'cemetery', 'religious', 'recreation_ground', 'grass', 'forest', 'farmland', 'meadow', 'brownfield', 'port'].includes(t.landuse ?? '') ||
    !!t.natural || t.waterway === 'riverbank';
  let noFillPolys = 0;
  const protectedPolys: { ring: P[]; kind: string }[] = [];
  for (const w of ways.values()) {
    if (!NOFILL(w.tags) || w.refs[0] !== w.refs[w.refs.length - 1] || w.tags.highway || w.tags.building) continue;
    const ring = ringPts(w.refs.slice(0, -1));
    if (ring.length < 3 || Math.abs(area(ring)) > 2e6) continue;
    rasterOcc(ring, 0);
    noFillPolys++;
    protectedPolys.push({ ring, kind: w.tags.amenity ?? (w.tags.leisure ? `leisure:${w.tags.leisure}` : w.tags.landuse ? `landuse:${w.tags.landuse}` : w.tags.natural ? `natural:${w.tags.natural}` : 'water') });
  }
  // ---- v0.6.3 용도지역(OSM landuse): 1 주거 · 2 상업/판매 · 3 공업 — 생성 건물의 종류·크기를 정한다
  const ZC = 8;
  const zone = new Map<number, number>();
  const zoneCode = (t: Record<string, string>): number => (t.landuse === 'residential' ? 1 : t.landuse === 'commercial' || t.landuse === 'retail' ? 2 : t.landuse === 'industrial' ? 3 : 0);
  const rasterZone = (ring: P[], code: number): void => {
    const xs = ring.map((p) => p[0]);
    const zs = ring.map((p) => p[1]);
    for (let i = Math.floor(Math.min(...xs) / ZC); i <= Math.floor(Math.max(...xs) / ZC); i++)
      for (let j = Math.floor(Math.min(...zs) / ZC); j <= Math.floor(Math.max(...zs) / ZC); j++)
        if (inRing(ring, (i + 0.5) * ZC, (j + 0.5) * ZC)) zone.set(okey(i, j), code);
  };
  const zst = { residential: 0, commercial: 0, industrial: 0 };
  for (const w of ways.values()) {
    const code = zoneCode(w.tags);
    if (!code || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
    const ring = ringPts(w.refs.slice(0, -1));
    if (ring.length < 3 || Math.abs(area(ring)) > 4e6) continue;
    rasterZone(ring, code);
    zst[code === 1 ? 'residential' : code === 2 ? 'commercial' : 'industrial']++;
  }
  for (const r of rels.values()) {
    const code = zoneCode(r.tags);
    if (!code || r.tags.type !== 'multipolygon') continue;
    for (const ring of assemble(r.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => m.ref)).rings) {
      const pts = ringPts(ring);
      if (pts.length >= 3 && Math.abs(area(pts)) <= 4e6) rasterZone(pts, code);
    }
    zst[code === 1 ? 'residential' : code === 2 ? 'commercial' : 'industrial']++;
  }
  const zoneAt = (x: number, z: number): number => zone.get(okey(Math.floor(x / ZC), Math.floor(z / ZC))) ?? 0;
  // 실제 건물 밀도(주변 80m 안 실제 건물 수) — 용도지역이 없는 곳은 실제 마을 근처에만 생성
  const DG = 40;
  const dens = new Map<number, number>();
  for (const b of uniq) {
    const c = cen(b);
    const k = okey(Math.floor(c[0] / DG), Math.floor(c[1] / DG));
    dens.set(k, (dens.get(k) ?? 0) + 1);
  }
  const realNear = (x: number, z: number): number => {
    let n = 0;
    const i0 = Math.floor(x / DG);
    const j0 = Math.floor(z / DG);
    for (let i = i0 - 2; i <= i0 + 2; i++) for (let j = j0 - 2; j <= j0 + 2; j++) n += dens.get(okey(i, j)) ?? 0;
    return n;
  };
  // 도로 선분 격자(가장 가까운 도로 가장자리 거리·방향)
  const RG = 40;
  const rgrid = new Map<number, { a: P; b: P; hw: number }[]>();
  for (const r of roads) {
    // 생성 건물 기준 도로: 일반 도로만(서비스 도로·임도 옆 산지에 집을 만들지 않는다). 터널 제외
    if (r.tunnel || r.cls >= 8) continue;
    for (let q = 1; q < r.pts.length; q++) {
      const a: P = [r.pts[q - 1][0], r.pts[q - 1][1]];
      const b: P = [r.pts[q][0], r.pts[q][1]];
      const seg = { a, b, hw: r.w / 2 };
      for (let i = Math.floor(Math.min(a[0], b[0]) / RG); i <= Math.floor(Math.max(a[0], b[0]) / RG); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / RG); j <= Math.floor(Math.max(a[1], b[1]) / RG); j++) {
          const k = okey(i, j);
          const l = rgrid.get(k);
          if (l) l.push(seg);
          else rgrid.set(k, [seg]);
        }
    }
  }
  const roadEdge = (x: number, z: number): { d: number; dir: number } => {
    let best = { d: Infinity, dir: 0 };
    const i0 = Math.floor(x / RG);
    const j0 = Math.floor(z / RG);
    for (let i = i0 - 2; i <= i0 + 2; i++)
      for (let j = j0 - 2; j <= j0 + 2; j++)
        for (const sgm of rgrid.get(okey(i, j)) ?? []) {
          const d = segDist(x, z, sgm.a, sgm.b) - sgm.hw;
          if (d < best.d) best = { d, dir: Math.atan2(sgm.b[0] - sgm.a[0], sgm.b[1] - sgm.a[1]) };
        }
    return best;
  };
  // v0.6.3: 생성 건물의 도로 여유는 서비스 도로(골목·진입로)까지 포함해 검사한다(이전: 일반 도로만 → 감사에서 골목 침범 421건)
  const cgrid = new Map<number, { a: P; b: P; hw: number }[]>();
  for (const r of roads) {
    if (r.tunnel) continue;
    for (let q = 1; q < r.pts.length; q++) {
      const a: P = [r.pts[q - 1][0], r.pts[q - 1][1]];
      const b: P = [r.pts[q][0], r.pts[q][1]];
      const sg = { a, b, hw: r.w / 2 };
      for (let i = Math.floor(Math.min(a[0], b[0]) / RG); i <= Math.floor(Math.max(a[0], b[0]) / RG); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / RG); j <= Math.floor(Math.max(a[1], b[1]) / RG); j++) {
          const k = okey(i, j);
          const l = cgrid.get(k);
          if (l) l.push(sg);
          else cgrid.set(k, [sg]);
        }
    }
  }
  const clearOf = (x: number, z: number): number => {
    let d = Infinity;
    const i0 = Math.floor(x / RG);
    const j0 = Math.floor(z / RG);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const sg of cgrid.get(okey(i, j)) ?? []) d = Math.min(d, segDist(x, z, sg.a, sg.b) - sg.hw);
    return d;
  };
  // 교차로(팔 ≥3 OSM 노드) — 생성 건물은 교차로 반경 + 2m 밖
  const jArms = new Map<string, { n: number; p: P; w: number }>();
  for (const r of roads) {
    if (r.tunnel) continue;
    r.refs.forEach((ref, q) => {
      const i = r.nodeIdx[q];
      const add = q === 0 || q === r.refs.length - 1 ? 1 : 2;
      const e = jArms.get(ref);
      if (e) {
        e.n += add;
        e.w = Math.max(e.w, r.w);
      } else jArms.set(ref, { n: add, p: [r.pts[i][0], r.pts[i][1]], w: r.w });
    });
  }
  const jgrid = new Map<number, { p: P; R: number }[]>();
  for (const j of jArms.values()) {
    if (j.n < 3) continue;
    const k = okey(Math.floor(j.p[0] / RG), Math.floor(j.p[1] / RG));
    const l = jgrid.get(k);
    const e = { p: j.p, R: j.w / 2 + 2 };
    if (l) l.push(e);
    else jgrid.set(k, [e]);
  }
  const nearJunction = (x: number, z: number): boolean => {
    const i0 = Math.floor(x / RG);
    const j0 = Math.floor(z / RG);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const e of jgrid.get(okey(i, j)) ?? []) if (Math.hypot(x - e.p[0], z - e.p[1]) < e.R) return true;
    return false;
  };
  // 이미 놓은 생성 건물(정확한 다각형 겹침 검사 — 4m 점유 칸만으로는 큰 창고 모서리가 겹쳤다)
  const ggrid = new Map<number, P[][]>();
  const genHits = (o: P[]): boolean => {
    const xs = o.map((q) => q[0]);
    const zs = o.map((q) => q[1]);
    for (let i = Math.floor((Math.min(...xs) - 2) / RG); i <= Math.floor((Math.max(...xs) + 2) / RG); i++)
      for (let j = Math.floor((Math.min(...zs) - 2) / RG); j <= Math.floor((Math.max(...zs) + 2) / RG); j++) for (const q of ggrid.get(okey(i, j)) ?? []) if (polyOverlap(o, q)) return true;
    return false;
  };
  const genAdd = (o: P[]): void => {
    const xs = o.map((q) => q[0]);
    const zs = o.map((q) => q[1]);
    for (let i = Math.floor(Math.min(...xs) / RG); i <= Math.floor(Math.max(...xs) / RG); i++)
      for (let j = Math.floor(Math.min(...zs) / RG); j <= Math.floor(Math.max(...zs) / RG); j++) {
        const k = okey(i, j);
        const l = ggrid.get(k);
        if (l) l.push(o);
        else ggrid.set(k, [o]);
      }
  };
  for (const b of uniq) genAdd(b.outer); // 실제 건물도 정확한 겹침 검사 대상(4m 점유 칸이 얇은 건물을 놓쳤다 — 감사 genReal 1건)
  let seed = 20261116;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  /** 생성 건물 종류(v0.6.3): 재질·지붕·크기를 정한다. 실제 건물이 아니다 */
  type GenKind = 'house' | 'villa' | 'shop' | 'factory' | 'warehouse';
  interface GenB {
    id: string;
    outer: P[];
    h: number;
    levels: number;
    base: number;
    gk: GenKind;
  }
  const genB: GenB[] = [];
  const gst = { zoneR: 0, zoneC: 0, zoneI: 0, zoneNone: 0, skipNoSettlement: 0, skipSlope: 0, skipHigh: 0 };
  const GSTEP = 13;
  /** 용도별 후보 크기(큰 것부터 시도 — 남은 공간이 작으면 작은 건물로) */
  const optionsFor = (zn: number, dn: number): { gk: GenKind; w: [number, number]; d: [number, number]; lv: [number, number] }[] => {
    if (zn === 3)
      return [
        { gk: 'warehouse', w: [22, 34], d: [16, 26], lv: [1, 1] },
        { gk: 'factory', w: [16, 24], d: [12, 18], lv: [1, 2] },
        { gk: 'factory', w: [12, 15], d: [10, 12], lv: [1, 2] },
      ];
    if (zn === 2)
      return [
        { gk: 'shop', w: [12, 17], d: [10, 14], lv: [3, 6] },
        { gk: 'villa', w: [9, 12], d: [8, 11], lv: [3, 5] },
      ];
    const villaFirst = dn >= 8 ? 0.6 : 0.35;
    return rnd() < villaFirst
      ? [
          { gk: 'villa', w: [10, 13], d: [9, 12], lv: [3, 5] },
          { gk: 'house', w: [7, 10], d: [7, 9], lv: [1, 2] },
        ]
      : [
          { gk: 'house', w: [7.5, 10.5], d: [7, 9.5], lv: [1, 2] },
          { gk: 'villa', w: [9, 11], d: [8, 10], lv: [3, 4] },
        ];
  };
  const occAt = (x: number, z: number): boolean => occ.has(okey(Math.floor(x / OCC), Math.floor(z / OCC)));
  for (let gx = LB.minX; gx <= LB.maxX; gx += GSTEP)
    for (let gz = LB.minZ; gz <= LB.maxZ; gz += GSTEP) {
      const x = gx + (rnd() - 0.5) * 4;
      const z = gz + (rnd() - 0.5) * 4;
      const fi = Math.round((x - FX0) / CELL);
      const fj = Math.round((z - FZ0) / CELL);
      if (fi < 0 || fj < 0 || fi >= FW || fj >= FH || !LAND[fj * FW + fi]) continue;
      const zn = zoneAt(x, z);
      // 공업지역은 후보 간격 26m(큰 공장/창고 위주 — 13m 격자로 채우면 작은 공장이 지나치게 촘촘했다)
      if (zn === 3 && (Math.round((gx - LB.minX) / GSTEP) % 2 !== 0 || Math.round((gz - LB.minZ) / GSTEP) % 2 !== 0)) continue;
      // 공업지역은 풀/나대지 피복도 허용(창고 마당), 나머지는 시가지 피복만
      if (cover[fj * FW + fi] !== 0 && !(zn === 3 && cover[fj * FW + fi] === 1)) continue;
      if (Math.hypot(x - fac[0], z - fac[1]) < 70) continue;
      const elev = fieldAt(x, z);
      if (elev > 120) {
        gst.skipHigh++;
        continue; // 해발 120m 위(산지)는 채우지 않는다(추정 지표면 기준)
      }
      const dn = realNear(x, z);
      // 실제 주거지로 확인되지 않은 곳(용도지역 없음)은 실제 건물이 근처에 있어야 한다. 언덕(해발 50m+)은 더 엄격
      if (zn === 0 && (dn < 3 || (elev > 50 && dn < 6))) {
        gst.skipNoSettlement++;
        continue;
      }
      if (zn === 1 && elev > 80 && dn < 3) {
        gst.skipNoSettlement++;
        continue;
      }
      const grad = Math.hypot(fieldAt(x + 6, z) - fieldAt(x - 6, z), fieldAt(x, z + 6) - fieldAt(x, z - 6)) / 12;
      if (grad > 0.25) {
        gst.skipSlope++;
        continue;
      }
      const nr = roadEdge(x, z);
      if (nr.d < 3.5 + 5 || nr.d > (zn === 3 ? 60 : 40)) continue;
      if (occAt(x, z)) continue;
      const c = Math.cos(nr.dir);
      const sn = Math.sin(nr.dir);
      for (const opt of optionsFor(zn, dn)) {
        const w = opt.w[0] + rnd() * (opt.w[1] - opt.w[0]);
        const d = opt.d[0] + rnd() * (opt.d[1] - opt.d[0]);
        const loc = (lx: number, lz: number): P => [r1(x + lx * c + lz * sn), r1(z - lx * sn + lz * c)];
        const corners: P[] = [loc(-w / 2, -d / 2), loc(w / 2, -d / 2), loc(w / 2, d / 2), loc(-w / 2, d / 2)];
        // 외곽선(4m 간격)과 내부(4m 격자) 모두: 도로 가장자리 2.5m 밖, 육지, 점유 칸 아님
        const probes: P[] = [];
        for (let u = -w / 2; u <= w / 2 + 1e-6; u += Math.min(4, w)) for (let v = -d / 2; v <= d / 2 + 1e-6; v += Math.min(4, d)) probes.push(loc(u, v));
        for (const p of corners) probes.push(p);
        if (probes.some(([px, pz]) => clearOf(px, pz) < 2.5 || !inLand(px, pz) || occAt(px, pz) || nearJunction(px, pz))) continue;
        // 1m 여유를 둔 외곽으로 이미 놓은 생성 건물과 정확히 겹침 검사
        const grown: P[] = [loc(-w / 2 - 1, -d / 2 - 1), loc(w / 2 + 1, -d / 2 - 1), loc(w / 2 + 1, d / 2 + 1), loc(-w / 2 - 1, d / 2 + 1)];
        if (genHits(grown)) continue;
        const ys = probes.map(([px, pz]) => fieldAt(px, pz));
        const rise = Math.max(...ys) - Math.min(...ys);
        if (rise > Math.min(0.3 * Math.max(w, d), opt.gk === 'warehouse' || opt.gk === 'factory' ? 2.0 : 3.5)) {
          gst.skipSlope++;
          continue;
        }
        const levels = opt.lv[0] + Math.floor(rnd() * (opt.lv[1] - opt.lv[0] + 1));
        const h = opt.gk === 'warehouse' ? 7 + rnd() * 3 : opt.gk === 'factory' ? levels * 4.5 + 1 : opt.gk === 'shop' ? levels * 3.4 + 0.8 : opt.gk === 'house' ? levels * 2.9 + 1.2 : levels * 2.9 + 0.8;
        const outer = area(corners) < 0 ? corners.reverse() : corners;
        genB.push({ id: `g${genB.length}`, outer, h: r1(h), levels, base: r2(outlineMin(outer)), gk: opt.gk });
        rasterOcc(outer, 1.5);
        genAdd(outer);
        if (zn === 1) gst.zoneR++;
        else if (zn === 2) gst.zoneC++;
        else if (zn === 3) gst.zoneI++;
        else gst.zoneNone++;
        break;
      }
    }
  console.log(`생성 건물(실제 아님): ${genB.length}동 (채우지 않는 면 ${noFillPolys})`);

  // ---------------------------------------------------------------- 8. 타일
  const tkey = (x: number, z: number): string => `${Math.floor(x / TILE)}_${Math.floor(z / TILE)}`;
  interface TileData {
    roads: unknown[];
    buildings: unknown[];
    lots: unknown[];
    marks: unknown[];
  }
  const tiles = new Map<string, TileData>();
  const tileOf = (k: string): TileData => {
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { roads: [], buildings: [], lots: [], marks: [] }));
    return t;
  };
  for (const r of roads) {
    // 연속한 점들을 중간점이 속한 타일별 조각으로
    let start = 0;
    let curK = tkey((r.pts[0][0] + r.pts[1][0]) / 2, (r.pts[0][1] + r.pts[1][1]) / 2);
    const emit = (a: number, b: number, k: string, piece: number): void => {
      tileOf(k).roads.push({
        id: `${r.id}~${piece}`,
        n: r.name,
        ref: r.ref,
        c: r.cls,
        lk: r.link ? 1 : 0,
        o: r.oneway,
        l: [r.lanes, r.fwd, r.bwd],
        ls: r.lanesSrc === 'osm' ? 1 : 0,
        w: r.w,
        ws: r.wSrc,
        t: r.turn,
        tf: r.turnF,
        tb: r.turnB,
        bus: r.bus,
        sp: r.speed,
        sf: r.surface,
        br: r.bridge,
        tn: r.tunnel,
        ly: r.layer,
        p: r.pts.slice(a, b + 1).map((q) => [q[0], q[1], q[2]]), // 복사: 조각 경계 점을 공유하면 기준고를 두 번 빼게 된다
      });
    };
    let piece = 0;
    for (let q = 1; q < r.pts.length; q++) {
      const k = tkey((r.pts[q - 1][0] + r.pts[q][0]) / 2, (r.pts[q - 1][1] + r.pts[q][1]) / 2);
      if (k !== curK) {
        emit(start, q - 1, curK, piece++);
        start = q - 1;
        curK = k;
      }
    }
    emit(start, r.pts.length - 1, curK, piece);
  }
  // 횡단보도/신호 정지선: 실제 OSM 노드 위치(도로 위). 방향 = 그 점의 도로 진행 방향, 폭 = 도로 폭
  const markSeen = new Set<string>();
  const mst = { cw: 0, sig: 0 };
  for (const r of roads) {
    if (r.tunnel || r.cls >= 8) continue;
    r.refs.forEach((ref, q) => {
      const kind = nodeMark.get(ref);
      if (!kind || markSeen.has(ref)) return;
      markSeen.add(ref);
      const i = r.nodeIdx[q];
      const a = r.pts[Math.max(0, i - 1)];
      const b = r.pts[Math.min(r.pts.length - 1, i + 1)];
      const h = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const p = r.pts[i];
      mst[kind]++;
      tileOf(tkey(p[0], p[1])).marks.push({ k: kind, x: p[0], z: p[1], h: Math.round(h * 1000) / 1000, w: r.w, o: r.oneway, l: [r.fwd, r.bwd] });
    });
  }
  for (const b of uniq) {
    const c = cen(b);
    tileOf(tkey(c[0], c[1])).buildings.push({ id: b.id, n: b.name, k: b.kind, o: b.outer, hl: b.holes.length ? b.holes : undefined, h: b.h, lv: b.levels ?? undefined, hs: b.hSrc, y: b.base });
  }
  for (const g of genB) {
    const cx = g.outer.reduce((a, p) => a + p[0], 0) / g.outer.length;
    const cz = g.outer.reduce((a, p) => a + p[1], 0) / g.outer.length;
    tileOf(tkey(cx, cz)).buildings.push({ id: g.id, k: 'gen', gk: g.gk, o: g.outer, h: g.h, lv: g.levels, hs: 'gen', g: 1, y: g.base });
  }
  for (const l of lots) {
    const c: P = [l.pts.reduce((s, p) => s + p[0], 0) / l.pts.length, l.pts.reduce((s, p) => s + p[1], 0) / l.pts.length];
    tileOf(tkey(c[0], c[1])).lots.push({ id: l.id, n: l.name, p: l.pts, y: l.y });
  }

  // ---------------------------------------------------------------- 9. 교량/터널 상판(지형 면) — 전역(작음)
  const decks: { id: string; x: number; z: number; rot: number; length: number; width: number; y0: number; y1: number; tunnel: 0 | 1 }[] = [];
  for (const r of roads) {
    if (!r.bridge && !r.tunnel) continue;
    for (let q = 1; q < r.pts.length; q++) {
      const [ax, az, ay] = r.pts[q - 1];
      const [bx, bz, by] = r.pts[q];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.2) continue;
      decks.push({ id: `${r.id}#${q}`, x: ax, z: az, rot: r1000(Math.atan2(bx - ax, bz - az)), length: r2(L + 0.3), width: r1(r.w), y0: ay, y1: by, tunnel: r.tunnel });
    }
  }
  function r1000(v: number): number {
    return Math.round(v * 1000) / 1000;
  }

  // ---------------------------------------------------------------- 9b. 배치 감사(v0.6.3) — 실제 건물은 보존(보고만), 생성 건물은 0 이어야 하는 항목
  const audit = (() => {
    type B = { id: string; o: P[]; g: boolean; base: number; c: P };
    const all: B[] = [...uniq.map((b) => ({ id: b.id, o: b.outer, g: false, base: b.base, c: cen(b) })), ...genB.map((b) => ({ id: b.id, o: b.outer, g: true, base: b.base, c: [b.outer.reduce((a, q) => a + q[0], 0) / 4, b.outer.reduce((a, q) => a + q[1], 0) / 4] as P }))];
    const AG = 50;
    const bgrid = new Map<number, B[]>();
    const bbox = (o: P[]): [number, number, number, number] => [Math.min(...o.map((q) => q[0])), Math.max(...o.map((q) => q[0])), Math.min(...o.map((q) => q[1])), Math.max(...o.map((q) => q[1]))];
    for (const b of all) {
      const [x0, x1, z0, z1] = bbox(b.o);
      for (let i = Math.floor(x0 / AG); i <= Math.floor(x1 / AG); i++)
        for (let j = Math.floor(z0 / AG); j <= Math.floor(z1 / AG); j++) {
          const k = okey(i, j);
          const l = bgrid.get(k);
          if (l) l.push(b);
          else bgrid.set(k, [b]);
        }
    }
    const segSeg = (a: P, b: P, c: P, d: P): number => (crossSeg(a, b, c, d) ? 0 : Math.min(segDist(a[0], a[1], c, d), segDist(b[0], b[1], c, d), segDist(c[0], c[1], a, b), segDist(d[0], d[1], a, b)));
    // 1) 건물–건물 겹침
    const ov = { realReal: 0, genReal: 0, genGen: 0, samples: [] as string[] };
    const seenPair = new Set<string>();
    for (const list of bgrid.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          const [ax0, ax1, az0, az1] = bbox(a.o);
          const [bx0, bx1, bz0, bz1] = bbox(b.o);
          if (ax1 < bx0 || bx1 < ax0 || az1 < bz0 || bz1 < az0) continue;
          if (!polyOverlap(a.o, b.o)) continue;
          if (a.g && b.g) ov.genGen++;
          else if (a.g || b.g) ov.genReal++;
          else ov.realReal++;
          if (ov.samples.length < 6) ov.samples.push(key);
        }
    // 2) 건물–도로(지상 도로, 교량/터널 제외): 차도 띠 안으로 0.5m 이상 들어옴
    const RG2 = 40;
    const rg2 = new Map<number, { a: P; b: P; hw: number; cls: number; ws: string }[]>();
    for (const r of roads) {
      if (r.tunnel || r.bridge) continue;
      for (let q = 1; q < r.pts.length; q++) {
        const a: P = [r.pts[q - 1][0], r.pts[q - 1][1]];
        const b: P = [r.pts[q][0], r.pts[q][1]];
        for (let i = Math.floor(Math.min(a[0], b[0]) / RG2); i <= Math.floor(Math.max(a[0], b[0]) / RG2); i++)
          for (let j = Math.floor(Math.min(a[1], b[1]) / RG2); j <= Math.floor(Math.max(a[1], b[1]) / RG2); j++) {
            const k = okey(i, j);
            const l = rg2.get(k);
            const sg = { a, b, hw: r.w / 2, cls: r.cls, ws: r.wSrc };
            if (l) l.push(sg);
            else rg2.set(k, [sg]);
          }
      }
    }
    const segsNear = (o: P[]): { a: P; b: P; hw: number; cls: number; ws: string }[] => {
      const [x0, x1, z0, z1] = bbox(o);
      const out: { a: P; b: P; hw: number; cls: number; ws: string }[] = [];
      const seen = new Set<object>();
      for (let i = Math.floor((x0 - 15) / RG2); i <= Math.floor((x1 + 15) / RG2); i++)
        for (let j = Math.floor((z0 - 15) / RG2); j <= Math.floor((z1 + 15) / RG2); j++)
          for (const sg of rg2.get(okey(i, j)) ?? []) if (!seen.has(sg)) (seen.add(sg), out.push(sg));
      return out;
    };
    const rd = { real: 0, realMain: 0, gen: 0, realMainDepth: { lt1: 0, lt2: 0, ge2: 0 }, realMainEstWidth: 0, samples: [] as string[] };
    const ent = { real30: 0, real60: 0, gen30: 0 };
    for (const b of all) {
      const segs = segsNear(b.o);
      let hit = false;
      let main = false;
      let near = Infinity;
      let depth = 0;
      let est = false;
      for (const sg of segs) {
        let d = Infinity;
        for (let k = 0; k < b.o.length; k++) d = Math.min(d, segSeg(b.o[k], b.o[(k + 1) % b.o.length], sg.a, sg.b));
        if (inRing(b.o, sg.a[0], sg.a[1]) || inRing(b.o, sg.b[0], sg.b[1])) d = 0;
        near = Math.min(near, d - sg.hw);
        if (d < sg.hw - 0.5) {
          hit = true;
          if (sg.cls < 8) {
            main = true;
            if (sg.hw - d > depth) [depth, est] = [sg.hw - d, sg.ws !== 'osm'];
          }
        }
      }
      if (main && !b.g) {
        if (depth < 1) rd.realMainDepth.lt1++;
        else if (depth < 2) rd.realMainDepth.lt2++;
        else rd.realMainDepth.ge2++;
        if (est) rd.realMainEstWidth++;
      }
      if (hit) {
        if (b.g) rd.gen++;
        else rd.real++;
        if (main && !b.g) rd.realMain++;
        if (rd.samples.length < 6 && (b.g || main)) rd.samples.push(b.id);
      }
      if (!segs.length || near > 30) {
        if (b.g) ent.gen30++;
        else ent.real30++;
      }
      if (!b.g && (!segs.length || near > 60)) ent.real60++;
    }
    // 3) 교차로(팔 ≥3 노드) 위
    const arms = new Map<string, { n: number; p: P; w: number }>();
    for (const r of roads) {
      if (r.tunnel || r.bridge) continue;
      r.refs.forEach((ref, q) => {
        const i = r.nodeIdx[q];
        const add = q === 0 || q === r.refs.length - 1 ? 1 : 2;
        const e = arms.get(ref);
        if (e) {
          e.n += add;
          e.w = Math.max(e.w, r.w);
        } else arms.set(ref, { n: add, p: [r.pts[i][0], r.pts[i][1]], w: r.w });
      });
    }
    const junc = { nodes: 0, real: 0, gen: 0 };
    for (const j of arms.values()) {
      if (j.n < 3) continue;
      junc.nodes++;
      const R = j.w / 2;
      for (const b of bgrid.get(okey(Math.floor(j.p[0] / AG), Math.floor(j.p[1] / AG))) ?? []) {
        let d = inRing(b.o, j.p[0], j.p[1]) ? 0 : Infinity;
        for (let k = 0; k < b.o.length && d > 0; k++) d = Math.min(d, segDist(j.p[0], j.p[1], b.o[k], b.o[(k + 1) % b.o.length]));
        if (d < R - 0.5) b.g ? junc.gen++ : junc.real++;
      }
    }
    // 4) 보호 구역(공원·학교·물·숲 등)·바다 / 5) 급경사 / 6) 산지 생성 밀도
    const prot = { genInside: 0, realInside: 0, byKind: {} as Record<string, number>, genSea: 0, realSea: 0 };
    const pgrid = new Map<number, { ring: P[]; kind: string }[]>();
    for (const pp of protectedPolys) {
      const [x0, x1, z0, z1] = bbox(pp.ring);
      for (let i = Math.floor(x0 / AG); i <= Math.floor(x1 / AG); i++)
        for (let j = Math.floor(z0 / AG); j <= Math.floor(z1 / AG); j++) {
          const k = okey(i, j);
          const l = pgrid.get(k);
          if (l) l.push(pp);
          else pgrid.set(k, [pp]);
        }
    }
    const steep = { real: 0, gen: 0 };
    const mount = { gen50: 0, gen80: 0, gen100: 0, genIsolated: 0 };
    for (const b of all) {
      const inside = (pgrid.get(okey(Math.floor(b.c[0] / AG), Math.floor(b.c[1] / AG))) ?? []).find((pp) => inRing(pp.ring, b.c[0], b.c[1]));
      if (inside) {
        if (b.g) prot.genInside++;
        else {
          prot.realInside++;
          prot.byKind[inside.kind] = (prot.byKind[inside.kind] ?? 0) + 1;
        }
      }
      if (!inLand(b.c[0], b.c[1])) b.g ? prot.genSea++ : prot.realSea++;
      const ys = b.o.map((q) => fieldAt(q[0], q[1]));
      const [x0, x1, z0, z1] = bbox(b.o);
      if ((Math.max(...ys) - Math.min(...ys)) / Math.max(4, Math.hypot(x1 - x0, z1 - z0)) > 0.3) b.g ? steep.gen++ : steep.real++;
      if (b.g) {
        const e = fieldAt(b.c[0], b.c[1]);
        if (e > 50) mount.gen50++;
        if (e > 80) mount.gen80++;
        if (e > 100) mount.gen100++;
        if (realNear(b.c[0], b.c[1]) < 3) mount.genIsolated++;
      }
    }
    const kinds: Record<string, number> = {};
    for (const g of genB) kinds[g.gk] = (kinds[g.gk] ?? 0) + 1;
    return {
      note: '실제 건물(OSM)은 위치·외곽을 보존하고 보고만 한다. 생성 건물은 겹침·도로 침범·교차로·보호 구역·바다가 0 이어야 한다(tests/saha.test.ts).',
      buildingOverlap: ov,
      roadOverlap: { ...rd, note: '차도 띠 안으로 0.5m 이상(지상 도로만). realMain = 서비스 도로 제외. 남은 것은 최소 차로 폭보다 건물선이 좁은 곳(데이터 충돌)' },
      roadWidthFit: { roads: fitSt.roads, maxCutM: r2(fitSt.maxCut), note: "추정 폭을 양옆 실제 건물선에 맞춰 줄인 도로(ws:'fit', 여전히 추정)" },
      junction: junc,
      protectedArea: prot,
      steepFootprint: steep,
      farFromRoad: { ...ent, note: '가장 가까운 지상 도로 가장자리까지 30m/60m 초과(진입 연결 어려움 후보)' },
      floating: { loweredByOutline: lowered.n, maxLoweredM: r2(lowered.max), note: '바닥을 외곽선 2m 간격 최저 지면으로 내린 건물 수(이전 방식이면 벽 밑이 뜸)' },
      generatedMountain: mount,
      generatedKinds: kinds,
      generatedZones: gst,
      zonePolygons: zst,
      zoneAreaKm2: { residential: r2(([...zone.values()].filter((v) => v === 1).length * ZC * ZC) / 1e6), commercial: r2(([...zone.values()].filter((v) => v === 2).length * ZC * ZC) / 1e6), industrial: r2(([...zone.values()].filter((v) => v === 3).length * ZC * ZC) / 1e6) },
      realInZone: uniq.reduce((a, b) => { const c = cen(b); const zz = zoneAt(c[0], c[1]); a[zz]++; return a; }, [0, 0, 0, 0]),
    };
  })();
  console.log('배치 감사', JSON.stringify(audit));

  // ---------------------------------------------------------------- 10. 쓰기
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'tiles'), { recursive: true });
  let tileBytes = 0;
  const tileList: { k: string; r: number; b: number; l: number; bytes: number }[] = [];
  for (const [k, t] of tiles) {
    const s = JSON.stringify(t);
    fs.writeFileSync(path.join(OUT, 'tiles', `${k}.json`), s);
    tileBytes += s.length;
    tileList.push({ k, r: t.roads.length, b: t.buildings.length, l: t.lots.length, bytes: s.length });
  }
  // 지형: Int16(0.1m) 높이 + Uint8 피복
  const hbuf = Buffer.alloc(FW * FH * 2);
  for (let k = 0; k < FW * FH; k++) hbuf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((dtm[k] - SEA_ZERO) * 10))), k * 2);
  fs.writeFileSync(path.join(OUT, 'field.bin'), Buffer.concat([hbuf, Buffer.from(cover)]));
  const simpl = (r: P[]): P[] => r.filter((_, i) => i % 1 === 0).map(([x, z]) => [r1(x), r1(z)]);
  const roadNet = { nodes: netNodes.map(([x, z, y]) => [x, z, r1(y - SEA_ZERO)]), edges: netEdges, cls: edgeCls, lanes: edgeLanes, speed: edgeSpeed, restrictions };
  const rn = JSON.stringify(roadNet);
  fs.writeFileSync(path.join(OUT, 'roadnet.json'), rn);
  // 도로/건물/상판 높이는 시설 기준(y − SEA_ZERO)으로 바꿔 쓴다 → 타일 파일 다시 쓰기
  for (const [k, t] of tiles) {
    for (const r of t.roads as { p: [number, number, number][] }[]) for (const p of r.p) p[2] = r2(p[2] - SEA_ZERO);
    for (const b of t.buildings as { y: number }[]) b.y = r2(b.y - SEA_ZERO);
    for (const l of t.lots as { y: number }[]) l.y = r2(l.y - SEA_ZERO);
    fs.writeFileSync(path.join(OUT, 'tiles', `${k}.json`), JSON.stringify(t));
  }
  for (const d of decks) {
    d.y0 = r2(d.y0 - SEA_ZERO);
    d.y1 = r2(d.y1 - SEA_ZERO);
  }
  const roadLenByCls: Record<string, number> = {};
  for (const r of roads) {
    let L = 0;
    for (let q = 1; q < r.pts.length; q++) L += Math.hypot(r.pts[q][0] - r.pts[q - 1][0], r.pts[q][1] - r.pts[q - 1][1]);
    roadLenByCls[CLASSES[r.cls]] = (roadLenByCls[CLASSES[r.cls]] ?? 0) + L;
  }
  const covCount = [0, 0, 0, 0, 0];
  let landCells = 0;
  for (let k = 0; k < cover.length; k++)
    if (LAND[k]) {
      landCells++;
      covCount[cover[k]]++;
    }
  const quality = {
    boundaryAreaKm2: r2(landArea / 1e6),
    boundaryOfficialKm2: 41.79,
    boundaryRings: landRings.length,
    boundaryOpenRings: boundaryOpen,
    roadWays: st.ways,
    roadPieces: roads.length,
    roadLengthKm: r2(st.lenTotal / 1000),
    roadLengthKmByClass: Object.fromEntries(Object.entries(roadLenByCls).map(([k, v]) => [k, r2(v / 1000)])),
    networkNodes: netNodes.length,
    networkEdges: netEdges.length,
    networkConnectedRatio: r2(connectedRatio),
    networkComponents: compLen.size,
    lanesOsmWays: st.lanesOsm,
    lanesEstWays: st.lanesEst,
    lanesOsmRatioByWay: r2(st.lanesOsm / Math.max(1, st.ways)),
    lanesOsmRatioByLength: r2(st.lenLanesOsm / Math.max(1, st.lenTotal)),
    turnLanesWays: st.turnLanes,
    crosswalks: mst.cw,
    trafficSignals: mst.sig,
    maxspeedWays: st.maxspeed,
    bridges: st.bridges,
    tunnels: st.tunnels,
    restrictionsTotal: restrTotal,
    restrictionsMapped: restrictions.length,
    buildingsFound: bst.found,
    buildingsKept: uniq.length,
    buildingsDuplicateRemoved: dup,
    buildingsOutside: bst.outside,
    buildingsTiny: bst.tiny,
    buildingsWithHoles: bst.holes,
    buildingsMultipolygon: bst.mpRels,
    buildingsWithHeightTag: uniq.filter((b) => b.hSrc === 'osm-height').length,
    buildingsWithLevelsTag: uniq.filter((b) => b.hSrc === 'osm-levels').length,
    buildingsHeightEstimated: uniq.filter((b) => b.hSrc === 'est').length,
    buildingsGenerated: genB.length,
    buildingsGeneratedNote: 'g:1 / hs:gen — OSM 에 건물이 없는 시가지 블록을 채운 절차 생성 건물(실제 아님). gk = 생성 종류(house/villa/shop/factory/warehouse, OSM 용도지역 기준)',
    audit,
    parkingLots: lots.length,
    dem: { source: 'Copernicus GLO-30 (DSM)', cellM: CELL, grid: [FW, FH], missingCells: demMissing, seaCells, coverage: r2(1 - demMissing / (FW * FH)), dtm: 'estimated (opening r=100m + gaussian)' },
    landCover: { cells: landCells, urban: covCount[0], grass: covCount[1], forest: covCount[2], water: covCount[3], sand: covCount[4], polygons: coverPolys },
    tiles: tiles.size,
    tileBytes,
    roadnetBytes: rn.length,
    fieldBytes: FW * FH * 3,
  };
  const manifest = {
    version: 1,
    name: '부산광역시 사하구',
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon, epsg: 5186, E0, N0 },
    axes: '+x=east, +z=south (m), y = 지면 높이 − 기준고(괴정역 기계식 시설 자리)',
    seaLevelY: r2(-SEA_ZERO),
    facility: { x: r1(fac[0]), z: r1(fac[1]) },
    tileSize: TILE,
    tiles: tileList.map((t) => t.k),
    field: { x0: FX0, z0: FZ0, w: FW, h: FH, cell: CELL, scale: 0.1, file: 'field.bin', cover: ['urban', 'grass', 'forest', 'water', 'sand'] },
    bounds: { minX: r1(LB.minX), maxX: r1(LB.maxX), minZ: r1(LB.minZ), maxZ: r1(LB.maxZ) },
    boundary: dongs.map((d) => ({ name: d.name, outer: d.outer.map(simpl), inner: d.inner.map(simpl) })),
    decks,
    sources: [
      { layer: 'roads, buildings, parking, boundary, land cover', name: 'OpenStreetMap', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', snapshot: osmBase, method: 'OSM API /map (0.02° 격자) + relation/full' },
      { layer: 'terrain', name: 'Copernicus DEM GLO-30', license: 'Copernicus DEM licence (free, attribution)', attribution: 'Copernicus DEM © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA' },
    ],
    quality,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(OUT, 'LICENSE.md'), `# 사하구 지도 데이터 출처\n\n- 도로·건물·주차장·경계·토지피복: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). 이 디렉터리의 JSON 은 OSM 데이터베이스에서 파생된 데이터베이스이며 ODbL 1.0 을 따른다.\n- 지형(field.bin): Copernicus DEM GLO-30 — © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA. 표면 모델(DSM)을 열림 연산·평활로 가공한 **추정 지표면**.\n- 변환 스크립트: scripts/saha/build.ts (OSM 스냅샷 ${osmBase ?? '알 수 없음'}).\n`);
  console.log(JSON.stringify(quality, null, 1));
  console.log(`시설 자리 기준고 ${SEA_ZERO.toFixed(1)}m(해수면 y=${(-SEA_ZERO).toFixed(1)}), 상판 ${decks.length}`);
})();
