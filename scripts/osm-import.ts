/**
 * OpenStreetMap(.osm XML) → 게임 지도 데이터(JSON) 변환 (v0.6.0).
 *   npx tsx scripts/osm-import.ts <입력.osm> <출력.json> <중심위도> <중심경도> [반폭m=500]
 * 내려받기(사용자가 직접 하거나 Claude 가 실행): https://api.openstreetmap.org/api/0.6/map?bbox=서,남,동,북
 *
 * 좌표: 중심 기준 미터, **+x = 동쪽, +z = 남쪽** (three.js 오른손 좌표계에서 위에서 본 지도가 뒤집히지 않도록 북쪽 = −z).
 * 출력 데이터는 OSM 데이터베이스에서 파생된 것이므로 ODbL 1.0 을 따른다(docs/ASSETS.md, src/maps/data/LICENSE-OSM.md).
 * 건물이 등록되지 않은 블록은 `--fill` 옵션으로 절차 생성 건물(gen: 1, 실제 건물 아님)을 채울 수 있다.
 */
import * as fs from 'node:fs';

type P = [number, number];
const args = process.argv.slice(2);
const fill = args.includes('--fill');
const pos = args.filter((a) => !a.startsWith('--'));
if (pos.length < 4) {
  console.error('사용법: npx tsx scripts/osm-import.ts <입력.osm> <출력.json> <위도> <경도> [반폭m] [--fill]');
  process.exit(2);
}
const [inPath, outPath, latS, lonS, halfS] = pos;
const LAT0 = Number(latS);
const LON0 = Number(lonS);
const H = Number(halfS ?? 500);
const xml = fs.readFileSync(inPath, 'utf8');

// ---------------------------------------------------------------- 최소 XML 파서 (OSM 구조 전용)
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
const M_PER_DEG = 111320;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);
const proj = (lat: number, lon: number): P => [(lon - LON0) * M_PER_DEG * COS0, -(lat - LAT0) * M_PER_DEG];

const nodes = new Map<string, P>();
for (const m of xml.matchAll(/<node\s[^>]*?(\/>|>)/g)) {
  const id = attr(m[0], 'id');
  const lat = attr(m[0], 'lat');
  const lon = attr(m[0], 'lon');
  if (id && lat && lon) nodes.set(id, proj(Number(lat), Number(lon)));
}
interface Way {
  id: string;
  refs: string[];
  tags: Record<string, string>;
}
const ways = new Map<string, Way>();
for (const m of xml.matchAll(/<way\s([^>]*)>([\s\S]*?)<\/way>/g)) {
  const id = attr(' ' + m[1], 'id')!;
  const refs = [...m[2].matchAll(/<nd\s+ref="(\d+)"/g)].map((r) => r[1]);
  ways.set(id, { id, refs, tags: tagsOf(m[2]) });
}
interface Rel {
  id: string;
  members: { type: string; ref: string; role: string }[];
  tags: Record<string, string>;
}
const rels: Rel[] = [];
for (const m of xml.matchAll(/<relation\s([^>]*)>([\s\S]*?)<\/relation>/g)) {
  const id = attr(' ' + m[1], 'id')!;
  const members = [...m[2].matchAll(/<member\s[^>]*?\/>/g)].map((x) => ({ type: attr(x[0], 'type') ?? '', ref: attr(x[0], 'ref') ?? '', role: attr(x[0], 'role') ?? '' }));
  rels.push({ id, members, tags: tagsOf(m[2]) });
}
const timestamp = /osm_base="([^"]+)"/.exec(xml)?.[1] ?? null;

// ---------------------------------------------------------------- 기하 도우미
const r1 = (v: number): number => Math.round(v * 10) / 10;
const inBox = (p: P, m = 0): boolean => Math.abs(p[0]) <= H + m && Math.abs(p[1]) <= H + m;
/** Sutherland–Hodgman: 다각형을 상자 [-H,H]² 로 자른다 */
function clipPoly(pts: P[]): P[] {
  let out = pts;
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p[0] >= -H, (a, b) => [-H, a[1] + ((b[1] - a[1]) * (-H - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= H, (a, b) => [H, a[1] + ((b[1] - a[1]) * (H - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= -H, (a, b) => [a[0] + ((b[0] - a[0]) * (-H - a[1])) / (b[1] - a[1]), -H]],
    [(p) => p[1] <= H, (a, b) => [a[0] + ((b[0] - a[0]) * (H - a[1])) / (b[1] - a[1]), H]],
  ];
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length];
      const b = src[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) return [];
  }
  return out;
}
/** Liang–Barsky: 선분을 상자로 자른다 */
function clipSeg(a: P, b: P): [P, P] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] + H],
    [dx, H - a[0]],
    [-dz, a[1] + H],
    [dz, H - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 > t1) return null;
  return [
    [a[0] + dx * t0, a[1] + dz * t0],
    [a[0] + dx * t1, a[1] + dz * t1],
  ];
}
const area = (pts: P[]): number => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};
/** 직선 위 정점 제거 (Douglas–Peucker 대신 짧은 변/거의 일직선만 정리) */
function tidy(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 0.25) out.push(p);
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.25) out.pop();
  return out;
}
const ringOf = (w: Way): P[] | null => {
  const pts = w.refs.map((r) => nodes.get(r)).filter((p): p is P => !!p);
  if (pts.length < 4 || w.refs[0] !== w.refs[w.refs.length - 1]) return null;
  return pts.slice(0, -1);
};

// ---------------------------------------------------------------- 건물
interface Bld {
  id: string;
  name?: string;
  kind: string;
  levels: number;
  h: number;
  pts: P[];
  gen?: 1;
}
const buildings: Bld[] = [];
const heightOf = (t: Record<string, string>): { levels: number; h: number } => {
  const lv = Number(t['building:levels']);
  const hh = Number(String(t.height ?? '').replace(/m$/, ''));
  const kind = t.building;
  const levels = Number.isFinite(lv) && lv > 0 ? lv : kind === 'apartments' ? 15 : kind === 'house' || kind === 'detached' ? 2 : kind === 'school' || kind === 'university' ? 4 : 3;
  const h = Number.isFinite(hh) && hh > 2 ? hh : levels * 3.0 + 1.0;
  return { levels, h };
};
const pushBld = (id: string, ring: P[], t: Record<string, string>): void => {
  let pts = tidy(clipPoly(ring));
  if (pts.length < 3 || Math.abs(area(pts)) < 12) return;
  if (area(pts) < 0) pts = pts.reverse(); // 반시계(위에서 본 +x 동 / +z 남 기준 면적 +)로 통일
  const { levels, h } = heightOf(t);
  buildings.push({ id, name: t.name, kind: t.building ?? 'yes', levels, h: r1(h), pts: pts.map(([x, z]) => [r1(x), r1(z)]) });
};
for (const w of ways.values()) {
  if (!w.tags.building || w.tags.building === 'no') continue;
  const ring = ringOf(w);
  if (ring) pushBld(`w${w.id}`, ring, w.tags);
}
for (const r of rels) {
  if (!r.tags.building) continue;
  // 멀티폴리곤: 바깥 고리(outer)만 건물로 쓴다(안뜰 구멍은 생략 — 충돌/표시가 단순해진다)
  for (const m of r.members) {
    if (m.type !== 'way' || m.role !== 'outer') continue;
    const w = ways.get(m.ref);
    const ring = w ? ringOf(w) : null;
    if (ring) pushBld(`r${r.id}-${m.ref}`, ring, { ...w!.tags, ...r.tags });
  }
}

// ---------------------------------------------------------------- 도로 (차량 통행 가능 등급만)
const DRIVE: Record<string, { w: number; rank: number }> = {
  motorway: { w: 22, rank: 6 },
  trunk: { w: 22, rank: 6 },
  primary: { w: 22, rank: 5 },
  secondary: { w: 15, rank: 4 },
  tertiary: { w: 11, rank: 3 },
  unclassified: { w: 7, rank: 2 },
  residential: { w: 6.5, rank: 2 },
  living_street: { w: 5.5, rank: 1 },
  service: { w: 4.5, rank: 1 },
};
const baseKind = (hw: string): string => hw.replace(/_link$/, '');
interface Road {
  id: string;
  name?: string;
  hw: string;
  w: number;
  oneway: 0 | 1;
  pts: P[];
}
const roads: Road[] = [];
// 도로망 그래프: 노드 = OSM 노드(상자 경계에서 잘린 점은 새 노드), 간선 = 연속한 점
const netIdx = new Map<string, number>();
const netNodes: P[] = [];
const netEdges: [number, number, 0 | 1][] = [];
const nodeOf = (key: string, p: P): number => {
  let i = netIdx.get(key);
  if (i === undefined) {
    i = netNodes.length;
    netNodes.push([r1(p[0]), r1(p[1])]);
    netIdx.set(key, i);
  }
  return i;
};
for (const w of ways.values()) {
  const hw = w.tags.highway;
  if (!hw) continue;
  const def = DRIVE[baseKind(hw)];
  if (!def) continue;
  if (w.tags.access === 'no' || w.tags.area === 'yes' || w.tags.tunnel === 'yes') continue;
  const lanes = Number(w.tags.lanes);
  const wtag = Number(String(w.tags.width ?? '').replace(/m$/, ''));
  const width = Number.isFinite(wtag) && wtag > 2 ? wtag : Number.isFinite(lanes) && lanes > 0 ? Math.max(def.w * 0.55, lanes * 3.25) : def.w * (hw.endsWith('_link') ? 0.5 : 1);
  const oneway: 0 | 1 = w.tags.oneway === 'yes' || w.tags.oneway === '1' || w.tags.junction === 'roundabout' || hw.endsWith('_link') && w.tags.oneway !== 'no' ? 1 : 0;
  let cur: P[] = [];
  let piece = 0;
  const flush = (): void => {
    if (cur.length >= 2) roads.push({ id: `w${w.id}${piece ? `-${piece}` : ''}`, name: w.tags.name, hw: baseKind(hw), w: r1(width), oneway, pts: cur.map(([x, z]) => [r1(x), r1(z)]) });
    cur = [];
    piece++;
  };
  for (let i = 1; i < w.refs.length; i++) {
    const a = nodes.get(w.refs[i - 1]);
    const b = nodes.get(w.refs[i]);
    if (!a || !b) continue;
    const c = clipSeg(a, b);
    if (!c) {
      flush();
      continue;
    }
    const ka = inBox(a) ? w.refs[i - 1] : `c${w.id}:${i}:a`;
    const kb = inBox(b) ? w.refs[i] : `c${w.id}:${i}:b`;
    const ia = nodeOf(ka, c[0]);
    const ib = nodeOf(kb, c[1]);
    if (ia !== ib) netEdges.push([ia, ib, oneway]);
    if (!cur.length) cur.push(c[0]);
    cur.push(c[1]);
    if (!inBox(b)) flush();
  }
  flush();
}

// ---------------------------------------------------------------- 면(주차장/녹지/물)
interface Area {
  id: string;
  kind: 'parking' | 'grass' | 'water' | 'pitch';
  name?: string;
  pts: P[];
}
const areas: Area[] = [];
for (const w of ways.values()) {
  const t = w.tags;
  const kind: Area['kind'] | null = t.amenity === 'parking' ? 'parking' : t.leisure === 'pitch' ? 'pitch' : t.leisure === 'park' || t.leisure === 'playground' || t.landuse === 'grass' || t.landuse === 'recreation_ground' || t.landuse === 'forest' || t.natural === 'wood' ? 'grass' : t.natural === 'water' ? 'water' : null;
  if (!kind || t.building) continue;
  const ring = ringOf(w);
  if (!ring) continue;
  let pts = tidy(clipPoly(ring));
  if (pts.length < 3 || Math.abs(area(pts)) < 20) continue;
  if (area(pts) < 0) pts = pts.reverse();
  areas.push({ id: `w${w.id}`, kind, name: t.name, pts: pts.map(([x, z]) => [r1(x), r1(z)]) });
}

// ---------------------------------------------------------------- (선택) 절차 생성 건물: OSM 에 건물이 없는 블록 채우기
const genCount = { tried: 0, placed: 0 };
if (fill) {
  // 결정적 난수
  let seed = 20261114;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const segDist = (x: number, z: number, a: P, b: P): number => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    return Math.hypot(x - (a[0] + dx * u), z - (a[1] + dz * u));
  };
  const nearestRoad = (x: number, z: number): { d: number; dir: number; half: number } => {
    let best = { d: Infinity, dir: 0, half: 3 };
    for (const r of roads)
      for (let i = 1; i < r.pts.length; i++) {
        const d = segDist(x, z, r.pts[i - 1], r.pts[i]) - r.w / 2;
        if (d < best.d) best = { d, dir: Math.atan2(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]), half: r.w / 2 };
      }
    return best;
  };
  const inside = (pts: P[], x: number, z: number): boolean => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, zi] = pts[i];
      const [xj, zj] = pts[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const occupied: { x: number; z: number; r: number }[] = buildings.map((b) => {
    const cx = b.pts.reduce((a, p) => a + p[0], 0) / b.pts.length;
    const cz = b.pts.reduce((a, p) => a + p[1], 0) / b.pts.length;
    return { x: cx, z: cz, r: Math.max(...b.pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz))) };
  });
  const STEP = 15;
  for (let gx = -H + 10; gx <= H - 10; gx += STEP)
    for (let gz = -H + 10; gz <= H - 10; gz += STEP) {
      genCount.tried++;
      const x = gx + (rnd() - 0.5) * 4;
      const z = gz + (rnd() - 0.5) * 4;
      const nr = nearestRoad(x, z);
      // 도로에서 4.5m(보도/대지 경계) 이상, 40m 이내(블록 안쪽 깊은 곳은 비워 둔다 — 산지/학교 운동장 등)
      if (nr.d < 4.5 + 5 || nr.d > 40) continue;
      if (areas.some((a) => inside(a.pts, x, z))) continue;
      if (buildings.some((b) => inside(b.pts, x, z))) continue;
      const w = 8 + rnd() * 5;
      const d = 9 + rnd() * 5;
      const rad = Math.hypot(w, d) / 2;
      if (occupied.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + rad + 1.5)) continue;
      if (nr.d < rad + 4.5) continue;
      // 가까운 도로와 나란히
      const a = nr.dir;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const corners: P[] = [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ].map(([lx, lz]) => [r1(x + lx * c + lz * s), r1(z - lx * s + lz * c)] as P);
      const pts = area(corners) < 0 ? corners.reverse() : corners;
      const levels = 2 + Math.floor(rnd() * 4); // 2~5층 (괴정동 저층 주거지 가정)
      buildings.push({ id: `gen${genCount.placed}`, kind: 'gen', levels, h: r1(levels * 3 + 0.8), pts, gen: 1 });
      occupied.push({ x, z, r: rad });
      genCount.placed++;
    }
}

const out = {
  source: 'OpenStreetMap',
  license: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  osmBase: timestamp,
  center: { lat: LAT0, lon: LON0 },
  half: H,
  axes: '+x=east, +z=south (meters)',
  generatedFill: fill ? { note: 'gen:1 건물은 OSM 에 건물이 없는 블록을 채운 절차 생성 건물(실제 건물 아님)', count: genCount.placed } : null,
  buildings,
  roads,
  areas,
  roadNet: { nodes: netNodes, edges: netEdges },
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`건물 ${buildings.length}(OSM ${buildings.filter((b) => !b.gen).length} + 생성 ${genCount.placed}) · 도로 ${roads.length} · 면 ${areas.length} · 도로망 노드 ${netNodes.length}/간선 ${netEdges.length} · ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB`);
