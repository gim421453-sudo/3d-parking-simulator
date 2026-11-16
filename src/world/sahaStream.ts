/**
 * v0.6.2 사하구 타일 스트리밍 렌더러 + 건물 충돌체 붙이기/떼기.
 *  - 먼 지형: 사하구 전체 높이장을 4칸(80m) 간격으로 한 메시(1.5m 아래로 — 가까운 고해상 지형과 겹쳐도 가려진다), 바다 평면.
 *  - 가까운 타일(반경 R): 고해상 지형 조각(20m, 물리와 같은 삼각형), 도로 리본·차선, 건물 돌출(바닥 = 실제 지형), 주차장 면, 교량 난간/상판, 터널 박스.
 *  - 건물 충돌체(외곽 → 회전 상자 분해)는 타일이 붙을 때 Game.colliders 에 push, 떨어질 때 splice — 배열 참조는 유지(카메라/센서 공유).
 *  - 렌더에 쓰는 높이는 모두 데이터(노면 y·지형 높이장)에서 온다. 화면용으로 임의 높이를 만들지 않는다.
 * 차량이 다른 구역으로 가도 게임 상태는 그대로이고, 도로망(내비)은 전역 데이터라 먼 타일이 내려가도 경로가 유지된다.
 */
import * as THREE from 'three';
import type { Collider } from '../core/geometry';
import { fieldHeight } from '../maps/terrain';
import { disposeObject } from '../core/dispose';
import { applyFacadeAtlas, createFacadeAtlas, type FacadeAtlas } from './facadeAtlas';
import { cellOffset, facadeStyleOf, hipRoof, FACADE_CELLS } from './facadeTypes';
import { buildingColliders, tilesWithin, TUNNEL_ROOF, type SahaMark, type SahaBase, type SahaBuilding, type SahaRoad, type SahaSource, type SahaTile } from '../maps/saha/data';
import type { MapSlot } from '../maps/types';

export interface SahaStreamOpts {
  /** 고해상 타일 반경(m) */
  radius: number;
  colliders: Collider[];
  byId: Map<string, Collider>;
  /** 미션 주차칸(도색) */
  slots: MapSlot[];
  /** 차선 그리기 */
  lanes: boolean;
  /** 생성 건물(g:1, 실제 아님) 표시·충돌 — 기본 true */
  genFill?: boolean;
  /** v0.6.3 외벽 아틀라스 칸 크기(px): low 64 · medium 128 · high 256 */
  atlasCell?: number;
}
interface Loaded {
  key: string;
  group: THREE.Group;
  colliderIds: string[];
  tris: number;
}
const COVER_COL = [new THREE.Color(0x9a978d), new THREE.Color(0x7d9a5a), new THREE.Color(0x4f6f3e), new THREE.Color(0x3d6a85), new THREE.Color(0xd8c9a0)];
const B_PAL: Record<string, number[]> = {
  apartments: [0xe9e6de, 0xdcd8cc, 0xe3ddd0],
  industrial: [0xb8bcc0, 0xa8adb2, 0xc4c2b8],
  warehouse: [0xb8bcc0, 0xa8adb2],
  school: [0xd9b9a0, 0xd0ad92],
  gen: [0xa9b2bc, 0xa1abb6, 0xb2b9c1],
  default: [0xe6e0d4, 0xd9d4c8, 0xeae6dc, 0xcfc9bc, 0xe0d8c8, 0xc9bfae],
};
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export class SahaStream {
  readonly group = new THREE.Group();
  private loaded = new Map<string, Loaded>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private cache = new Map<string, SahaTile>();
  private mats: { terrain: THREE.MeshStandardMaterial; road: THREE.MeshStandardMaterial; paint: THREE.MeshBasicMaterial; bld: THREE.MeshStandardMaterial; bldGen: THREE.MeshStandardMaterial; roof: THREE.MeshStandardMaterial; lot: THREE.MeshStandardMaterial; struct: THREE.MeshStandardMaterial; water: THREE.MeshStandardMaterial };
  private atlas: FacadeAtlas;
  private lastCx = Infinity;
  private lastCz = Infinity;
  private disposed = false;
  readonly stats = { loads: 0, unloads: 0, lastLoadMs: 0, maxLoadMs: 0, buildMs: 0, colliders: 0, failed: 0 };

  constructor(
    private base: SahaBase,
    private src: SahaSource,
    private opts: SahaStreamOpts,
    facadeTex: THREE.Texture | null,
  ) {
    const po = (m: THREE.Material, f: number): THREE.Material => {
      m.polygonOffset = true;
      m.polygonOffsetFactor = f;
      m.polygonOffsetUnits = f;
      return m;
    };
    this.mats = {
      terrain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
      road: po(new THREE.MeshStandardMaterial({ color: 0x45484d, roughness: 0.95, side: THREE.DoubleSide }), -2) as THREE.MeshStandardMaterial,
      paint: po(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), -4) as THREE.MeshBasicMaterial,
      // v0.6.3: 건물 유형별 PBR 외벽 아틀라스(facadeAtlas.ts) — 실제 건물은 유리 반사 있음
      bld: new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      // 생성 건물(실제 아님): 회청 패널 칸(창문·반사 없음) — 실제 건물과 한눈에 구분
      bldGen: new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }),
      lot: po(new THREE.MeshStandardMaterial({ color: 0x6b6e72, roughness: 0.95, side: THREE.DoubleSide }), -1) as THREE.MeshStandardMaterial,
      struct: new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 }),
      water: new THREE.MeshStandardMaterial({ color: 0x2f5f7c, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.92 }),
    };
    this.group.name = 'SahaStream';
    void facadeTex; // v0.6.2 공용 외벽 텍스처 대신 아틀라스(이 스트림 소유 — dispose 에서 해제)
    this.atlas = createFacadeAtlas(opts.atlasCell ?? 128, 4);
    applyFacadeAtlas(this.mats.bld, this.atlas, { glass: true });
    applyFacadeAtlas(this.mats.bldGen, this.atlas, { glass: false });
    // v0.6.3: 터널 위 지형 칸을 지우지 않는다(이전: 터널 전 구간 위 산에 긴 홈이 보였다). 입구는 build.ts 가 높이장을 절토했고
    // 갱문(콘크리트 입구 면)은 manifest.portals 로 한 번만 만든다.
    this.buildPortals();
    this.buildFar();
  }

  /** 먼 지형(전체, 80m 간격) + 바다 */
  private buildFar(): void {
    const f = this.base.field;
    const S = 4;
    const W = Math.floor((f.w - 1) / S) + 1;
    const H = Math.floor((f.h - 1) / S) + 1;
    const pos = new Float32Array(W * H * 3);
    const col = new Float32Array(W * H * 3);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * S * f.w + i * S;
        const o = (j * W + i) * 3;
        pos[o] = f.x0 + i * S * f.cell;
        pos[o + 1] = f.data[k] - 1.5;
        pos[o + 2] = f.z0 + j * S * f.cell;
        const c = COVER_COL[this.base.cover[k]] ?? COVER_COL[0];
        col[o] = c.r;
        col[o + 1] = c.g;
        col[o + 2] = c.b;
      }
    const idx: number[] = [];
    for (let j = 0; j < H - 1; j++)
      for (let i = 0; i < W - 1; i++) {
        const a = j * W + i;
        idx.push(a, a + W + 1, a + 1, a, a + W, a + W + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const far = new THREE.Mesh(g, this.mats.terrain);
    far.name = 'SahaFarTerrain';
    far.receiveShadow = true;
    this.group.add(far);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(f.w * f.cell + 4000, f.h * f.cell + 4000), this.mats.water);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(f.x0 + (f.w * f.cell) / 2, this.base.manifest.seaLevelY, f.z0 + (f.h * f.cell) / 2);
    sea.name = 'SahaSea';
    this.group.add(sea);
  }

  /** 차량 위치로 타일 붙이기/떼기 — 매 프레임 불러도 된다(20m 이상 움직였을 때만 다시 계산) */
  update(x: number, z: number): void {
    if (this.disposed) return;
    if (Math.hypot(x - this.lastCx, z - this.lastCz) < 20) return;
    this.lastCx = x;
    this.lastCz = z;
    const R = this.opts.radius;
    const want = new Set(tilesWithin(this.base.manifest, x, z, R));
    const keep = new Set(tilesWithin(this.base.manifest, x, z, R + this.base.manifest.tileSize));
    for (const [k] of this.loaded) if (!keep.has(k)) this.unload(k);
    // 가까운 타일부터
    const order = [...want].filter((k) => !this.loaded.has(k) && !this.pending.has(k) && !this.failed.has(k));
    const ts = this.base.manifest.tileSize;
    order.sort((a, b) => {
      const [ax, az] = a.split('_').map(Number);
      const [bx, bz] = b.split('_').map(Number);
      return Math.hypot((ax + 0.5) * ts - x, (az + 0.5) * ts - z) - Math.hypot((bx + 0.5) * ts - x, (bz + 0.5) * ts - z);
    });
    for (const k of order) void this.load(k);
  }

  /** 시작 전에 미리 받은 타일 데이터(같은 객체를 다시 받지 않는다) */
  prime(tiles: Map<string, SahaTile>): void {
    for (const [k, t] of tiles) this.cache.set(k, t);
  }

  /** 지금 반경 안 타일이 모두 붙었는가(테스트/로딩 화면) */
  ready(x: number, z: number): boolean {
    return tilesWithin(this.base.manifest, x, z, Math.min(this.opts.radius, 250)).every((k) => this.loaded.has(k) || this.failed.has(k));
  }

  private async load(key: string): Promise<void> {
    this.pending.add(key);
    const t0 = performance.now();
    try {
      let tile = this.cache.get(key);
      if (!tile) {
        if (this.base.manifest.tiles.includes(key)) tile = await this.src.json<SahaTile>(`tiles/${key}.json`);
        else tile = { roads: [], buildings: [], lots: [] }; // 데이터 없는 타일(산지/바다): 지형만
        this.cache.set(key, tile);
      }
      if (this.disposed) return;
      const tb = performance.now();
      this.attach(key, tile);
      this.stats.buildMs += performance.now() - tb;
      this.stats.loads++;
      this.stats.lastLoadMs = performance.now() - t0;
      this.stats.maxLoadMs = Math.max(this.stats.maxLoadMs, this.stats.lastLoadMs);
    } catch {
      this.failed.add(key);
      this.stats.failed++;
    } finally {
      this.pending.delete(key);
    }
    // 캐시는 최근 120 타일만(메모리)
    if (this.cache.size > 120) for (const k of [...this.cache.keys()].slice(0, this.cache.size - 120)) if (!this.loaded.has(k)) this.cache.delete(k);
  }

  private attach(key: string, tile: SahaTile): void {
    if (this.loaded.has(key)) return;
    const g = new THREE.Group();
    g.name = `SahaTile_${key}`;
    let tris = 0;
    const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, name: string, shadow = false): void => {
      if (!geo) return;
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.receiveShadow = true;
      m.castShadow = shadow;
      g.add(m);
      tris += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
    };
    const [ix, iz] = key.split('_').map(Number);
    add(this.terrainPatch(ix, iz), this.mats.terrain, 'terrain');
    const roads = tile.roads;
    add(this.roadGeo(roads), this.mats.road, 'roads');
    if (this.opts.lanes) add(this.paintGeo(roads, ix, iz, tile.marks ?? []), this.mats.paint, 'lanes');
    add(this.lotGeo(tile), this.mats.lot, 'lots');
    const tunnelDecks: THREE.BufferGeometry[] = [];
    add(this.structGeo(roads, tunnelDecks), this.mats.struct, 'bridges-tunnels', true);
    if (tunnelDecks.length) {
      const m = THREE_UTILS.mergeGeometries(tunnelDecks.map((g) => g.toNonIndexed()));
      tunnelDecks.forEach((g) => g.dispose());
      add(m, this.mats.road, 'tunnel-road', false);
    }
    const blds = this.opts.genFill === false ? tile.buildings.filter((b) => !b.g) : tile.buildings;
    const bg = this.buildingGeo(blds.filter((b) => !b.g));
    add(bg.walls, this.mats.bld, 'buildings', true);
    add(bg.roofs, this.mats.roof, 'roofs', true);
    const gg = this.buildingGeo(blds.filter((b) => b.g));
    add(gg.walls, this.mats.bldGen, 'buildings-generated', true);
    add(gg.roofs, this.mats.roof, 'roofs-generated', true);
    // 충돌체
    const ids: string[] = [];
    for (const b of blds) {
      buildingColliders(b).forEach((c) => {
        this.opts.colliders.push(c);
        this.opts.byId.set(c.id, c);
        ids.push(c.id);
      });
    }
    this.stats.colliders += ids.length;
    this.group.add(g);
    this.loaded.set(key, { key, group: g, colliderIds: ids, tris });
  }

  private unload(key: string): void {
    const l = this.loaded.get(key);
    if (!l) return;
    this.group.remove(l.group);
    disposeObject(l.group, { materials: new Set<THREE.Material>(Object.values(this.mats)), textures: new Set<THREE.Texture>(this.mats.bld.map ? [this.mats.bld.map] : []) });
    if (l.colliderIds.length) {
      const drop = new Set(l.colliderIds);
      const cs = this.opts.colliders;
      // 제자리 압축(배열 참조 유지 — 길이가 바뀌므로 공간 색인이 다시 만들어진다)
      let w = 0;
      for (let r = 0; r < cs.length; r++) if (!drop.has(cs[r].id)) cs[w++] = cs[r];
      cs.length = w;
      for (const id of l.colliderIds) this.opts.byId.delete(id);
      this.stats.colliders -= l.colliderIds.length;
    }
    this.loaded.delete(key);
    this.stats.unloads++;
  }

  // ------------------------------------------------------------------ 메시 생성
  private terrainPatch(ix: number, iz: number): THREE.BufferGeometry | null {
    const f = this.base.field;
    const ts = this.base.manifest.tileSize;
    const i0 = Math.round((ix * ts - f.x0) / f.cell);
    const j0 = Math.round((iz * ts - f.z0) / f.cell);
    const n = Math.round(ts / f.cell);
    const sea = this.base.manifest.seaLevelY - 1;
    const pos: number[] = [];
    const col: number[] = [];
    const push = (i: number, j: number): void => {
      const k = j * f.w + i;
      pos.push(f.x0 + i * f.cell, f.data[k], f.z0 + j * f.cell);
      const c = COVER_COL[this.base.cover[k]] ?? COVER_COL[0];
      // 단색 사막처럼 보이지 않게 격자점마다 결정적 밝기 변화(±7%) — 높이·물리와 무관(색만)
      const n = 0.93 + ((Math.imul(i * 73856093 ^ j * 19349663, 2654435761) >>> 0) % 1000) / 1000 * 0.14;
      col.push(c.r * n, c.g * n, c.b * n);
    };
    for (let j = j0; j < j0 + n; j++)
      for (let i = i0; i < i0 + n; i++) {
        if (i < 0 || j < 0 || i >= f.w - 1 || j >= f.h - 1) continue;
        const h = [f.data[j * f.w + i], f.data[j * f.w + i + 1], f.data[(j + 1) * f.w + i], f.data[(j + 1) * f.w + i + 1]];
        if (h.every((v) => v < sea)) continue; // 바다 밑
        // fieldHeight 와 같은 분할: (i,j)-(i+1,j+1) 대각선. 위에서 볼 때 법선 +y 가 되도록 감기 순서
        push(i, j);
        push(i + 1, j + 1);
        push(i + 1, j);
        push(i, j);
        push(i, j + 1);
        push(i + 1, j + 1);
      }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  /**
   * 폴리라인을 좌우 오프셋(a..b)으로 띠 사각형들로. 각 구간을 ≤2m 로 더 나눈다.
   * drape=true(일반 도로): 꼭짓점마다 **지형 높이장**(물리와 같은 삼각형 보간) + dy — 데이터 점(8m 간격)을 직선으로 이으면
   *   20m 지형 삼각형의 꺾임에 도로가 묻히거나 옆 경사가 도로 위로 튀어나온다. drape=false(교량/터널 상판): 노면 y 직선 보간.
   */
  private strip(p: [number, number, number][], a: number, b: number, dy: number, pos: number[], dash?: { on: number; off: number }, col?: number[], c?: THREE.Color, drape = false): void {
    const f = this.base.field;
    let s = 0;
    for (let q = 1; q < p.length; q++) {
      const [x0, z0, y0] = p[q - 1];
      const [x1, z1, y1] = p[q];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.05) continue;
      const nx = (z1 - z0) / L;
      const nz = -(x1 - x0) / L;
      const segs: [number, number][] = [];
      if (!dash) segs.push([0, L]);
      else {
        const per = dash.on + dash.off;
        for (let t = -(s % per); t < L; t += per) {
          const u0 = Math.max(0, t);
          const u1 = Math.min(L, t + dash.on);
          if (u1 > u0 + 0.05) segs.push([u0, u1]);
        }
      }
      const at = (u: number, off: number): [number, number, number] => {
        const x = x0 + ((x1 - x0) * u) / L + nx * off;
        const z = z0 + ((z1 - z0) * u) / L + nz * off;
        const y = drape ? (fieldHeight(f, x, z) ?? y0 + ((y1 - y0) * u) / L) : y0 + ((y1 - y0) * u) / L;
        return [x, y + dy, z];
      };
      for (const [u0, u1] of segs) {
        const n = Math.max(1, Math.ceil((u1 - u0) / 2));
        for (let k = 0; k < n; k++) {
          const ua = u0 + ((u1 - u0) * k) / n;
          const ub = u0 + ((u1 - u0) * (k + 1)) / n;
          const P = [at(ua, a), at(ua, b), at(ub, b), at(ub, a)];
          for (const i of [0, 1, 2, 0, 2, 3]) pos.push(...P[i]);
          if (col && c) for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
        }
      }
      s += L;
    }
  }

  private roadGeo(roads: SahaRoad[]): THREE.BufferGeometry | null {
    const pos: number[] = [];
    for (const r of roads) {
      if (r.tn) continue; // 터널 노면은 structGeo
      const dy = r.br ? 0.03 : 0.04; // 지형과 같은 삼각형 위에 4cm (차체는 지형 높이에 놓인다 — 시각 차이 4cm)
      this.strip(r.p, -r.w / 2, r.w / 2, dy, pos, undefined, undefined, undefined, !r.br);
      // 이음매 원판(꺾이는 점·끝점) — 교차로 빈틈 방지
      for (const [x, z, y] of [r.p[0], r.p[r.p.length - 1]]) {
        const R = r.w / 2;
        const N = 10;
        const hy = (px: number, pz: number): number => (r.br ? y : (fieldHeight(this.base.field, px, pz) ?? y)) + dy - 0.005;
        for (let k = 0; k < N; k++) {
          const a0 = (k / N) * Math.PI * 2;
          const a1 = ((k + 1) / N) * Math.PI * 2;
          const p1x = x + Math.cos(a1) * R;
          const p1z = z + Math.sin(a1) * R;
          const p0x = x + Math.cos(a0) * R;
          const p0z = z + Math.sin(a0) * R;
          pos.push(x, hy(x, z), z, p1x, hy(p1x, p1z), p1z, p0x, hy(p0x, p0z), p0z);
        }
      }
    }
    return this.geo(pos);
  }

  /** 차선: 중앙선(황색), 차로 경계(백색 점선), 바깥선 — 차로 수는 OSM 태그(ls=1) 또는 등급 추정(ls=0) */
  private paintGeo(roads: SahaRoad[], ix: number, iz: number, marks: SahaMark[]): THREE.BufferGeometry | null {
    const pos: number[] = [];
    const col: number[] = [];
    this.slotPaint(ix, iz, pos, col);
    this.markPaint(marks, pos, col);
    // 교차점: 이 타일 안에서 도로 팔이 3개 이상 모이는 꼭짓점(끝점 = 팔 1, 중간점 = 팔 2). 차선은 교차점 안까지 그리지 않는다
    const arms = new Map<string, { n: number; w: number }>();
    const key = (x: number, z: number): string => `${Math.round(x * 2)},${Math.round(z * 2)}`;
    for (const r of roads) {
      if (r.tn) continue;
      r.p.forEach(([x, z], i) => {
        const k = key(x, z);
        const a = arms.get(k) ?? { n: 0, w: 0 };
        a.n += i === 0 || i === r.p.length - 1 ? 1 : 2;
        a.w = Math.max(a.w, r.w);
        arms.set(k, a);
      });
    }
    const trim = (p: [number, number, number][]): [number, number, number][][] => {
      // 교차점 반경(가장 넓은 도로 폭/2 + 1m) 안을 잘라 낸 조각들
      const cut: { s: number; r: number }[] = [];
      const sAt: number[] = [0];
      for (let i = 1; i < p.length; i++) sAt.push(sAt[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
      p.forEach(([x, z], i) => {
        const a = arms.get(key(x, z));
        if (a && a.n >= 3) cut.push({ s: sAt[i], r: a.w / 2 + 1 });
      });
      if (!cut.length) return [p];
      const L = sAt[sAt.length - 1];
      const keep: [number, number][] = [];
      let s0 = 0;
      for (const c of cut.sort((a, b) => a.s - b.s)) {
        if (c.s - c.r > s0) keep.push([s0, c.s - c.r]);
        s0 = Math.max(s0, c.s + c.r);
      }
      if (s0 < L) keep.push([s0, L]);
      const at = (s: number): [number, number, number] => {
        let i = 1;
        while (i < sAt.length - 1 && sAt[i] < s) i++;
        const t = (s - sAt[i - 1]) / Math.max(1e-6, sAt[i] - sAt[i - 1]);
        return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t, p[i - 1][2] + (p[i][2] - p[i - 1][2]) * t];
      };
      return keep.filter(([a, b]) => b - a > 1).map(([a, b]) => {
        const out: [number, number, number][] = [at(a)];
        for (let i = 0; i < p.length; i++) if (sAt[i] > a && sAt[i] < b) out.push(p[i]);
        out.push(at(b));
        return out;
      });
    };
    const Y = new THREE.Color(0xf2c200);
    const Wt = new THREE.Color(0xf4f4f4);
    for (const r of roads) {
      if (r.tn || r.c >= 7) continue; // 생활도로/서비스도로는 차선 없음
      const [total, fw, bw] = r.l;
      if (total < 1 || r.w < 4.5) continue;
      const lw = Math.min(3.5, (r.w - 0.6) / Math.max(1, total));
      const dy = r.br ? 0.05 : 0.06;
      const parts = trim(r.p);
      const line = (off: number, w: number, c: THREE.Color, dash?: { on: number; off: number }): void => {
        for (const pp of parts) this.strip(pp, off - w / 2, off + w / 2, dy, pos, dash, col, c, !r.br);
      };
      if (!r.o) {
        // 중앙선: 오른쪽(+법선 쪽이 아닌) — strip 의 법선은 진행 방향 기준 한쪽, 중앙선은 정/역 차로 경계(오프셋 = (bw − fw)/2 · lw)
        const center = ((bw - fw) / 2) * lw;
        if (total >= 2 && r.c <= 4) {
          line(center - 0.12, 0.12, Y);
          line(center + 0.12, 0.12, Y);
        } else if (total >= 2) line(center, 0.12, Y, { on: 3, off: 3 });
        for (let k = 1; k < fw; k++) line(center - k * lw, 0.12, Wt, { on: 3, off: 5 });
        for (let k = 1; k < bw; k++) line(center + k * lw, 0.12, Wt, { on: 3, off: 5 });
      } else {
        for (let k = 1; k < total; k++) line(-((total / 2) * lw) + k * lw, 0.12, Wt, { on: 3, off: 5 });
      }
      if (r.c <= 3 && r.w >= 7) {
        line(-r.w / 2 + 0.35, 0.12, Wt);
        line(r.w / 2 - 0.35, 0.12, Wt);
      }
    }
    return this.geo(pos, col);
  }

  private lotGeo(tile: SahaTile): THREE.BufferGeometry | null {
    const pos: number[] = [];
    const f = this.base.field;
    for (const l of tile.lots) {
      const contour = l.p.map(([x, z]) => new THREE.Vector2(x, z));
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      // 큰 삼각형을 6m 이하로 쪼개 꼭짓점마다 지형 높이 — 경사진 주차장이 지형에 묻히거나 뜨지 않게
      const put = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, depth: number): void => {
        const e = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz));
        if (e > 6 && depth < 6) {
          const abx = (ax + bx) / 2, abz = (az + bz) / 2, bcx = (bx + cx) / 2, bcz = (bz + cz) / 2, cax = (cx + ax) / 2, caz = (cz + az) / 2;
          put(ax, az, abx, abz, cax, caz, depth + 1);
          put(abx, abz, bx, bz, bcx, bcz, depth + 1);
          put(cax, caz, bcx, bcz, cx, cz, depth + 1);
          put(abx, abz, bcx, bcz, cax, caz, depth + 1);
          return;
        }
        for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) pos.push(x, (fieldHeight(f, x, z) ?? l.y) + 0.07, z);
      };
      for (const t of tris) {
        const a = contour[t[0]], b = contour[t[2]], c = contour[t[1]];
        put(a.x, a.y, b.x, b.y, c.x, c.y, 0);
      }
    }
    return this.geo(pos);
  }

  /**
   * 횡단보도(지브라: 진행 방향과 나란한 흰 막대 0.45m, 간격 0.45m, 길이 3m)와 신호 교차 정지선(노드 8m 앞, 진행 차로 쪽 절반).
   * 위치는 실제 OSM 노드(횡단보도/신호), 모양·간격은 일반 규격 근사.
   */
  private markPaint(marks: SahaMark[], pos: number[], col: number[]): void {
    const W = new THREE.Color(0xf4f4f4);
    for (const m of marks) {
      const fx = Math.sin(m.h);
      const fz = Math.cos(m.h);
      const along = (d: number, len: number): [number, number, number][] => [
        [m.x + fx * (d - len / 2), m.z + fz * (d - len / 2), 0],
        [m.x + fx * (d + len / 2), m.z + fz * (d + len / 2), 0],
      ];
      const half = m.w / 2 - 0.3;
      if (m.k === 'cw') {
        for (let o = -half + 0.225; o <= half - 0.225; o += 0.9) this.strip(along(0, 3), o - 0.225, o + 0.225, 0.07, pos, undefined, col, W, true);
      } else {
        const [fw, bw] = m.l;
        const tot = Math.max(1, fw + bw);
        const center = m.o ? -half : ((bw - fw) / tot) * half; // 정/역 차로 경계(왼쪽 +)
        // 정방향 접근: 노드 8m 앞, 오른쪽(음수 오프셋) 차로
        this.strip(along(-8, 0.45), m.o ? -half : -half, m.o ? half : center, 0.07, pos, undefined, col, W, true);
        if (!m.o) this.strip(along(8, 0.45), center, half, 0.07, pos, undefined, col, W, true);
      }
    }
  }

  /** 미션 주차칸 U자 도색(자동 배치 — 실제 칸 배치 아님). 칸 바닥 높이(slot.y) 기준 */
  private slotPaint(ix: number, iz: number, pos: number[], col: number[]): void {
    const ts = this.base.manifest.tileSize;
    const W = new THREE.Color(0xf4f4f4);
    for (const s of this.opts.slots) {
      if (Math.floor(s.x / ts) !== ix || Math.floor(s.z / ts) !== iz || s.y === undefined) continue;
      if (s.id.startsWith('saha-mech:')) continue;
      const fx = Math.sin(s.dir);
      const fz = Math.cos(s.dir);
      const lx = Math.cos(s.dir);
      const lz = -Math.sin(s.dir);
      const P = (u: number, v: number): [number, number, number] => [s.x + lx * u + fx * v, s.z + lz * u + fz * v, s.y! + 0.02];
      const hw = s.w / 2;
      const hl = s.l / 2;
      for (const seg of [
        [P(-hw, -hl), P(-hw, hl)],
        [P(hw, -hl), P(hw, hl)],
        [P(-hw, -hl), P(hw, -hl)],
      ])
        this.strip(seg, -0.06, 0.06, 0.06, pos, undefined, col, W, true);
    }
  }

  private tunnelWalls: Collider[] | null = null;
  /**
   * v0.6.3 터널 벽(덮인 구간)의 카메라 전용 가림 상자 — 추적 카메라가 터널 벽을 뚫고 산 속으로 나가지 않게.
   * 충돌체가 아니다(차량 제약은 상판 가장자리·천장). (x,z) 반경 r 안의 것만 돌려준다.
   */
  tunnelOccluders(x: number, z: number, r: number): Collider[] {
    if (!this.tunnelWalls) {
      this.tunnelWalls = [];
      for (const d of this.base.manifest.decks) {
        if (!d.tunnel) continue;
        const fx = Math.sin(d.rot);
        const fz = Math.cos(d.rot);
        const mx = d.x + (fx * d.length) / 2;
        const mz = d.z + (fz * d.length) / 2;
        const my = (d.y0 + d.y1) / 2;
        const g = fieldHeight(this.base.field, mx, mz);
        if (g === null || g - my < TUNNEL_ROOF + 0.5) continue; // 진입부(지붕 없음)
        for (const side of [1, -1]) {
          const off = side * (d.width / 2 + 0.45);
          this.tunnelWalls.push({ kind: 'box', id: `tw-${d.id}-${side}`, tag: 'wall', x: mx + fz * off, z: mz - fx * off, w: 0.6, d: d.length + 0.4, rot: d.rot, y0: Math.min(d.y0, d.y1) - 0.5, h: TUNNEL_ROOF + 1.5 + Math.abs(d.y1 - d.y0) });
        }
      }
    }
    return this.tunnelWalls.filter((c) => Math.abs(c.x - x) < r && Math.abs(c.z - z) < r);
  }

  /** 갱문: 터널 입구 위·옆 콘크리트 면(입구 구멍 테두리). 시각 전용 — 차량 제약은 상판 가장자리·천장(roof)이 한다 */
  private buildPortals(): void {
    const ps = this.base.manifest.portals ?? [];
    if (!ps.length) return;
    const geos: THREE.BufferGeometry[] = [];
    for (const p of ps) {
      const W = p.w + 1.4; // 터널 벽 바깥 폭(구조 모델과 같은 값)
      const top = Math.max(p.top + 1.0, p.y + TUNNEL_ROOF + 2.5);
      const box = (w: number, h: number, d: number, ox: number, oy: number): void => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(ox, oy, -d / 2); // 입구 면이 갱문 위치에서 바깥쪽으로
        g.rotateY(p.rot);
        g.translate(p.x, 0, p.z);
        geos.push(g);
      };
      box(W + 6, top - (p.y + TUNNEL_ROOF), 1.2, 0, (p.y + TUNNEL_ROOF + top) / 2); // 상부 면
      box(3, top - p.y + 0.5, 1.2, -(W / 2 + 1.5), (p.y - 0.5 + top) / 2); // 좌우 날개벽
      box(3, top - p.y + 0.5, 1.2, W / 2 + 1.5, (p.y - 0.5 + top) / 2);
    }
    const { mergeGeometries } = THREE_UTILS;
    const m = mergeGeometries(geos.map((g) => g.toNonIndexed()));
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(m, this.mats.struct);
    mesh.name = 'tunnel-portals';
    this.group.add(mesh);
  }

  /** 교량: 상판 측면·난간(시각 — 낙하 방지는 지형 '가장자리' 판정이 한다), 터널: 바닥·벽·천장 */
  private structGeo(roads: SahaRoad[], deckOut?: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    const geos: THREE.BufferGeometry[] = [];
    for (const r of roads) {
      if (!r.br && !r.tn) continue;
      for (let q = 1; q < r.p.length; q++) {
        const [ax, az, ay] = r.p[q - 1];
        const [bx, bz, by] = r.p[q];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.2) continue;
        const rot = Math.atan2(bx - ax, bz - az);
        const mid = new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
        const pitch = Math.atan2(by - ay, L);
        const mk = (w: number, h: number, ox: number, oy: number, into = geos): void => {
          const g = new THREE.BoxGeometry(w, h, L + 0.05);
          g.translate(ox, oy, 0);
          g.rotateX(-pitch);
          g.rotateY(rot);
          g.translate(mid.x, mid.y, mid.z);
          into.push(g);
        };
        if (r.br) {
          mk(r.w + 0.6, 0.9, 0, -0.42); // 상판
          mk(0.3, 1.0, -(r.w / 2 + 0.15), 0.5); // 난간
          mk(0.3, 1.0, r.w / 2 + 0.15, 0.5);
        } else {
          mk(r.w + 0.4, 0.3, 0, -0.1, deckOut ?? geos); // 터널 노면(아스팔트 — 구조물 콘크리트와 구분)
          // v0.6.3: 덮인 구간(지면이 천장 + 0.5m 보다 위)만 벽·천장, 입구 진입부(절토)는 낮은 옹벽만 — 진입부 천장이 지면 위로 드러나지 않게
          const g = fieldHeight(this.base.field, mid.x, mid.z);
          if (g !== null && g - mid.y >= TUNNEL_ROOF + 0.5) {
            mk(0.5, TUNNEL_ROOF, -(r.w / 2 + 0.45), TUNNEL_ROOF / 2);
            mk(0.5, TUNNEL_ROOF, r.w / 2 + 0.45, TUNNEL_ROOF / 2);
            mk(r.w + 1.4, 0.5, 0, TUNNEL_ROOF + 0.25); // 천장(아랫면 = 노면 + TUNNEL_ROOF, 물리 천장과 같은 값)
          } else {
            mk(0.5, 1.1, -(r.w / 2 + 0.45), 0.55);
            mk(0.5, 1.1, r.w / 2 + 0.45, 0.55);
          }
        }
      }
    }
    if (!geos.length) return null;
    const { mergeGeometries } = THREE_UTILS;
    const m = mergeGeometries(geos.map((g) => g.toNonIndexed()));
    geos.forEach((g) => g.dispose());
    return m;
  }

  private buildingGeo(bs: SahaBuilding[]): { walls: THREE.BufferGeometry | null; roofs: THREE.BufferGeometry | null } {
    const wp: number[] = [];
    const wc: number[] = [];
    const wu: number[] = [];
    const wa: number[] = [];
    const rp: number[] = [];
    const rc: number[] = [];
    const white = new THREE.Color(1, 1, 1);
    const roofTri = (a: number[], b: number[], c: number[], col: THREE.Color): void => {
      for (const v of [a, c, b]) {
        rp.push(v[0], v[1], v[2]);
        rc.push(col.r, col.g, col.b);
      }
    };
    for (const b of bs) {
      const area = Math.abs(b.o.reduce((acc, p, i) => acc + p[0] * b.o[(i + 1) % b.o.length][1] - b.o[(i + 1) % b.o.length][0] * p[1], 0)) / 2;
      const st = facadeStyleOf(b, area);
      const pal = b.g ? B_PAL.gen : B_PAL[b.k] ?? B_PAL.default;
      // 아틀라스가 색을 갖고 있으므로 팔레트는 약한 색조(건물마다 조금씩 다르게)만
      const c = new THREE.Color(pal[hash(b.id) % pal.length]).lerp(white, b.g ? 0.45 : 0.6);
      const [mx, my] = cellOffset(st.main);
      const [gx, gy] = cellOffset(st.ground);
      const y0 = b.y - 3; // 경사 대지: 가장 낮은 꼭짓점보다 3m 아래부터(기초 — 외곽 안쪽 지면이 더 낮아도 뜬 건물이 보이지 않게)
      const y1 = b.y + b.h;
      const rings = [b.o, ...(b.hl ?? [])];
      for (const ring of rings) {
        let u = 0;
        for (let i = 0; i < ring.length; i++) {
          const [x0, z0] = ring[i];
          const [x1, z1] = ring[(i + 1) % ring.length];
          const L = Math.hypot(x1 - x0, z1 - z0);
          // 외곽은 반시계(+면적) → 바깥을 보는 감기
          const P = [
            [x0, y0, z0],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z0],
          ];
          // UV: u = 벽을 따라 모듈 수, v = 지면(b.y)부터 층 수 → 층고마다 창이 반복된다(1층 v<1 은 1층 칸)
          const UV = [
            [u / st.module, (y0 - b.y) / st.floor],
            [(u + L) / st.module, (y0 - b.y) / st.floor],
            [(u + L) / st.module, (y1 - b.y) / st.floor],
            [u / st.module, (y1 - b.y) / st.floor],
          ];
          for (const k of [0, 2, 1, 0, 3, 2]) {
            wp.push(...P[k]);
            wc.push(c.r, c.g, c.b);
            wu.push(UV[k][0], UV[k][1]);
            wa.push(mx, my, gx, gy);
          }
          u += L;
        }
      }
      // 지붕: 작은 주택은 모임지붕(기와색), 그 외 평지붕(콘크리트 또는 녹색 방수 도장 — 일반적인 모습, 실제 지붕 자료 아님)
      const h = hash(b.id + 'r');
      const hip = st.roof === 'hip' ? hipRoof(b.o as [number, number][], y1) : null;
      if (hip) {
        const tile = new THREE.Color(b.g ? 0x8f99a4 : [0x6b4a3a, 0x4d5257, 0x7a5a40, 0x55616b][h % 4]);
        for (const t of hip) roofTri(t[0], t[1], t[2], tile);
      } else {
        const contour = b.o.map(([x, z]) => new THREE.Vector2(x, z));
        const holes = (b.hl ?? []).map((ho) => ho.map(([x, z]) => new THREE.Vector2(x, z)));
        if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
        for (const ho of holes) if (!THREE.ShapeUtils.isClockWise(ho)) ho.reverse();
        const all = [...contour, ...holes.flat()];
        const flat = b.g ? c.clone().multiplyScalar(0.85) : new THREE.Color(st.main === 'villa' || st.main === 'apartment' || st.main === 'house' ? (h % 5 < 2 ? 0x5f8a6a : 0xa8a59c) : 0x9d9b95);
        for (const t of THREE.ShapeUtils.triangulateShape(contour, holes)) roofTri([all[t[0]].x, y1, all[t[0]].y], [all[t[1]].x, y1, all[t[1]].y], [all[t[2]].x, y1, all[t[2]].y], flat);
        // 옥상 계단실/기계실(면적 200m² 이상 — 중심이 외곽 안일 때만)
        if (st.rooftop && area > 200) {
          const cx = b.o.reduce((a2, p) => a2 + p[0], 0) / b.o.length;
          const cz = b.o.reduce((a2, p) => a2 + p[1], 0) / b.o.length;
          let inside = false;
          for (let i = 0, j = b.o.length - 1; i < b.o.length; j = i++) {
            const [xi, zi] = b.o[i];
            const [xj, zj] = b.o[j];
            if (zi > cz !== zj > cz && cx < ((xj - xi) * (cz - zi)) / (zj - zi) + xi) inside = !inside;
          }
          if (inside) {
            const s = 1.8;
            const top = y1 + 2.6;
            const box = new THREE.Color(0xb7b3aa);
            const q = [
              [cx - s, cz - s],
              [cx + s, cz - s],
              [cx + s, cz + s],
              [cx - s, cz + s],
            ];
            for (let i = 0; i < 4; i++) {
              const [ax, az] = q[i];
              const [bx, bz] = q[(i + 1) % 4];
              roofTri([ax, y1, az], [bx, y1, bz], [bx, top, bz], box.clone().multiplyScalar(0.9));
              roofTri([ax, y1, az], [bx, top, bz], [ax, top, az], box.clone().multiplyScalar(0.9));
            }
            roofTri([q[0][0], top, q[0][1]], [q[2][0], top, q[2][1]], [q[1][0], top, q[1][1]], box);
            roofTri([q[0][0], top, q[0][1]], [q[3][0], top, q[3][1]], [q[2][0], top, q[2][1]], box);
          }
        }
      }
    }
    const walls = wp.length ? this.geo(wp, wc, wu) : null;
    if (walls) walls.setAttribute('aCell', new THREE.Float32BufferAttribute(wa, 4));
    const roofs = rp.length ? this.geo(rp, rc) : null;
    return { walls, roofs };
  }

  private geo(pos: number[], col?: number[], uv?: number[]): THREE.BufferGeometry | null {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  info(): { loaded: number; pending: number; failed: number; triangles: number; colliders: number; keys: string[] } {
    let tris = 0;
    for (const l of this.loaded.values()) tris += l.tris;
    return { loaded: this.loaded.size, pending: this.pending.size, failed: this.failed.size, triangles: tris, colliders: this.stats.colliders, keys: [...this.loaded.keys()] };
  }

  dispose(): void {
    this.disposed = true;
    for (const k of [...this.loaded.keys()]) this.unload(k);
    disposeObject(this.group, { textures: new Set<THREE.Texture>([this.atlas.map, this.atlas.normalMap, this.atlas.ormMap]) });
    for (const m of Object.values(this.mats)) m.dispose();
    this.atlas.dispose();
  }
}

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
const THREE_UTILS = { mergeGeometries };
void FACADE_CELLS;
