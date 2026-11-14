/**
 * 실제 지도 표시 레이어(geo) 3D 생성 (v0.6.0). 순수 데이터(MapData.geo)에서 메시를 만든다 — 충돌/센서와 무관.
 *  - 면(주차장/녹지/물/운동장): 다각형 삼각분할, 종류별 1개 메시
 *  - 도로: 폴리라인 → 리본(구간 사각형 + 꺾이는 점의 원판), 타일(48m)별로 합친 메시
 *  - 건물: 바닥 다각형 돌출(벽 = 둘레를 따라 창문 텍스처 u=둘레/5m, v=높이/4m, 지붕 = 삼각분할), 건물별 색(정점 색), 타일별로 합침
 * 높이 순서(겹침 방지): 바닥(0) < 면 0.012~0.018 < 도로 0.024 < 도색 0.02→(도로 위로 올림) — 깊이 충돌은 polygonOffset 으로도 보정
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldGrid } from '../world/tiles';
import type { GeoLayer } from './types';
import type { TextureSet } from './textures';

export interface GeoBuildCtx {
  geo: GeoLayer;
  tex: TextureSet;
  mats: { asphalt: THREE.Material; grass: THREE.Material; concrete: THREE.Material };
  grid: WorldGrid;
  /** 항상 보이는 그룹(타일 스트리밍 밖) */
  root: THREE.Group;
  /** 타일 그룹에 넣기 */
  addAt(x: number, z: number, ...objs: THREE.Object3D[]): void;
  track<T extends { dispose(): void }>(d: T): T;
}

export interface GeoStats {
  buildings: number;
  roadMeshes: number;
  buildingMeshes: number;
  triangles: number;
}

type Pt = [number, number];

/** 다각형(맵 x,z) → 수평 삼각형 지오메트리(y 위, 위를 향함), 평면 UV = 좌표/uvScale */
function flatPoly(pts: readonly Pt[], y: number, uvScale: number): THREE.BufferGeometry | null {
  const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!tris.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const t of tris) {
    // 위에서 보았을 때 반시계(법선 +y): (x,z) 평면에서 z 축이 아래로 가므로 순서를 뒤집는다
    for (const i of [t[0], t[2], t[1]]) {
      const v = contour[i];
      pos.push(v.x, y, v.y);
      uv.push(v.x / uvScale, v.y / uvScale);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** 도로 리본: 구간 사각형 (이음매 원판은 roadDisc) */
function roadRibbon(pts: readonly Pt[], w: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (x: number, z: number): void => {
    pos.push(x, y, z);
    uv.push(x / 4, z / 4);
  };
  const h = w / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const nx = ((bz - az) / len) * h;
    const nz = (-(bx - ax) / len) * h;
    // 두 삼각형 (위를 향하도록 감는 순서)
    const p1: Pt = [ax + nx, az + nz];
    const p2: Pt = [ax - nx, az - nz];
    const p3: Pt = [bx - nx, bz - nz];
    const p4: Pt = [bx + nx, bz + nz];
    for (const [x, z] of [p1, p2, p3, p1, p3, p4]) push(x, z); // 위를 향하는 감김(아래에서 보면 컬링)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // 감는 순서가 섞일 수 있으므로 법선은 위로 고정(평면)
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

/** 꺾이는 점을 메우는 원판(위를 향함) */
function roadDisc(p: Pt, r: number, y: number): THREE.BufferGeometry {
  const SEG = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (x: number, z: number): void => {
    pos.push(x, y, z);
    uv.push(x / 4, z / 4);
  };
  for (let k = 0; k < SEG; k++) {
    const a0 = (k / SEG) * Math.PI * 2;
    const a1 = ((k + 1) / SEG) * Math.PI * 2;
    push(p[0], p[1]);
    push(p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r);
    push(p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

/** 건물 벽 + 지붕 (정점 색 = 건물 색) */
function buildingGeo(pts: readonly Pt[], h: number, color: THREE.Color): { walls: THREE.BufferGeometry; roof: THREE.BufferGeometry | null } {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const ring = pts.slice();
  // 바깥을 향하도록: (x,z) 평면 면적이 + 이면(위에서 보면 시계 방향) 그대로
  let per = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = per / 5;
    const u1 = (per + len) / 5;
    per += len;
    const v1 = h / 4;
    // 바깥을 향하는 감김: 다각형은 (x,z) 면적 + (반시계) → 바깥 법선 = 진행 방향 오른쪽 (dz, −dx)
    const quad: [number, number, number, number, number][] = [
      [ax, 0, az, u0, 0],
      [bx, h, bz, u1, v1],
      [bx, 0, bz, u1, 0],
      [ax, 0, az, u0, 0],
      [ax, h, az, u0, v1],
      [bx, h, bz, u1, v1],
    ];
    for (const [x, y, z, u, v] of quad) {
      pos.push(x, y, z);
      uv.push(u, v);
      col.push(color.r, color.g, color.b);
    }
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  walls.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  walls.computeVertexNormals();
  const roof = flatPoly(pts, h, 6);
  if (roof) {
    const n = roof.getAttribute('position').count;
    const rc = new Float32Array(n * 3);
    const dark = color.clone().multiplyScalar(0.62);
    for (let i = 0; i < n; i++) rc.set([dark.r, dark.g, dark.b], i * 3);
    roof.setAttribute('color', new THREE.BufferAttribute(rc, 3));
  }
  return { walls, roof };
}

export function buildGeoLayer(c: GeoBuildCtx): GeoStats {
  const { geo, tex, track } = c;
  const stats: GeoStats = { buildings: 0, roadMeshes: 0, buildingMeshes: 0, triangles: 0 };
  // ---- 면 ----
  const waterMat = track(new THREE.MeshStandardMaterial({ color: 0x3f6f99, roughness: 0.25, metalness: 0.1 }));
  const pitchMat = track(new THREE.MeshStandardMaterial({ color: 0x4f8a4a, roughness: 1 }));
  const byKind: Record<string, THREE.BufferGeometry[]> = { parking: [], grass: [], water: [], pitch: [] };
  const Y: Record<string, number> = { grass: 0.012, pitch: 0.014, water: 0.01, parking: 0.018 };
  for (const a of geo.areas) {
    const g = flatPoly(a.pts, Y[a.kind] ?? 0.012, 4);
    if (g) byKind[a.kind].push(g);
  }
  const areaMat: Record<string, THREE.Material> = { parking: c.mats.asphalt, grass: c.mats.grass, water: waterMat, pitch: pitchMat };
  for (const [k, list] of Object.entries(byKind)) {
    if (!list.length) continue;
    const m = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    if (!m) continue;
    track(m);
    const mesh = new THREE.Mesh(m, areaMat[k]);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    c.root.add(mesh); // 면은 개수가 적다 — 타일 스트리밍과 무관하게 항상 그린다
  }
  // ---- 도로 (타일별) ----
  const roadMat = track(new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const roadTiles = new Map<string, { x: number; z: number; geos: THREE.BufferGeometry[] }>();
  const tileOf = (x: number, z: number): { x: number; z: number; geos: THREE.BufferGeometry[] } => {
    const k = c.grid.keyOf(x, z);
    let t = roadTiles.get(k);
    if (!t) roadTiles.set(k, (t = { x, z, geos: [] }));
    return t;
  };
  for (const r of geo.roads) {
    // 구간 사각형은 구간 중점의 타일, 꺾이는 점의 원판은 그 점의 타일에 넣는다(타일 경계에서 끊기지 않음)
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      tileOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2).geos.push(roadRibbon([a, b], r.w, 0.024));
    }
    for (let i = 1; i < r.pts.length - 1; i++) tileOf(r.pts[i][0], r.pts[i][1]).geos.push(roadDisc(r.pts[i], r.w / 2, 0.024));
  }
  for (const t of roadTiles.values()) {
    const m = mergeGeometries(t.geos, false);
    t.geos.forEach((g) => g.dispose());
    if (!m) continue;
    track(m);
    const mesh = new THREE.Mesh(m, roadMat);
    mesh.receiveShadow = true;
    c.addAt(t.x, t.z, mesh);
    stats.roadMeshes++;
    stats.triangles += m.getAttribute('position').count / 3;
  }
  // ---- 건물 (타일별, 벽/지붕) ----
  const facade = tex.facade.clone();
  facade.needsUpdate = true;
  facade.repeat.set(1, 1);
  track(facade);
  const wallMat = track(new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.9 }));
  const roofMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  const bt = new Map<string, { x: number; z: number; walls: THREE.BufferGeometry[]; roofs: THREE.BufferGeometry[] }>();
  const colr = new THREE.Color();
  for (const b of geo.buildings) {
    const [cx, cz] = b.pts.reduce((a, p) => [a[0] + p[0] / b.pts.length, a[1] + p[1] / b.pts.length], [0, 0]);
    const k = c.grid.keyOf(cx, cz);
    let t = bt.get(k);
    if (!t) bt.set(k, (t = { x: cx, z: cz, walls: [], roofs: [] }));
    const { walls, roof } = buildingGeo(b.pts, b.h, colr.setHex(b.color));
    t.walls.push(walls);
    if (roof) t.roofs.push(roof);
    stats.buildings++;
  }
  for (const t of bt.values()) {
    for (const [list, mat, cast] of [
      [t.walls, wallMat, true],
      [t.roofs, roofMat, false],
    ] as const) {
      if (!list.length) continue;
      const m = mergeGeometries(list as THREE.BufferGeometry[], false);
      (list as THREE.BufferGeometry[]).forEach((g) => g.dispose());
      if (!m) continue;
      track(m);
      const mesh = new THREE.Mesh(m, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      c.addAt(t.x, t.z, mesh);
      stats.buildingMeshes++;
      stats.triangles += m.getAttribute('position').count / 3;
    }
  }
  return stats;
}
