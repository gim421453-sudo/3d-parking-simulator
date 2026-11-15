/**
 * v0.6.2 부산 사하구 전체 지도 전처리 — 원본(data-raw/saha) → 게임용 타일(public/maps/saha).
 *   npx tsx scripts/saha/fetch-osm.ts   (OSM 원본, 1회)
 *   npx tsx scripts/saha/build.ts       (이 파일)
 *
 * 좌표: EPSG:5186(GRS80 TM) → 괴정역 원점 로컬 미터. +x = 동, +z = 남(북쪽 = −z, 기존 지도와 같은 규칙).
 * 높이: Copernicus GLO-30(DSM) → 열림 연산(건물 제거 근사) + 평활 = **추정 지표면**(열림 반경 100m). 괴정역 기계식 시설 자리를 y=0 으로 맞춘다
 *       (기계식 시설 키트가 y=0 바닥을 전제) — 해수면은 y = −seaOffset.
 * 데이터 계층 분리: OSM(ODbL) 도로/건물/면/경계, Copernicus(DEM) 지형. 출처는 manifest.sources 에 계층별로 남긴다.
 * 실제/추정 구분: 차로 수·폭·건물 높이·교량 종단은 값마다 출처 플래그(osm/est)를 둔다. 절차 생성 건물은 만들지 않는다.
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
    wSrc: 'osm' | 'lanes' | 'est';
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
    const base = Math.min(...outer.map((p) => fieldAt(p[0], p[1])));
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

  // ---------------------------------------------------------------- 8. 타일
  const tkey = (x: number, z: number): string => `${Math.floor(x / TILE)}_${Math.floor(z / TILE)}`;
  interface TileData {
    roads: unknown[];
    buildings: unknown[];
    lots: unknown[];
  }
  const tiles = new Map<string, TileData>();
  const tileOf = (k: string): TileData => {
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { roads: [], buildings: [], lots: [] }));
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
  for (const b of uniq) {
    const c = cen(b);
    tileOf(tkey(c[0], c[1])).buildings.push({ id: b.id, n: b.name, k: b.kind, o: b.outer, hl: b.holes.length ? b.holes : undefined, h: b.h, lv: b.levels ?? undefined, hs: b.hSrc, y: b.base });
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
    buildingsGenerated: 0,
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
