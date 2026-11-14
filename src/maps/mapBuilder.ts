import * as THREE from 'three';
import { TileStreamer, WorldGrid } from '../world/tiles';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCarModel } from '../vehicle/carModel';
import { parkedSpec } from '../vehicle/spec';
import { createTextures, type TextureSet } from './textures';
import { buildGeoLayer, type GeoStats } from './geoBuilder';
import type { MapData, ObstacleDef } from './types';
import type { ParkingSlot } from '../mission/parking';

export interface QualityOptions {
  textureSize: number;
  anisotropy: number;
  shadows: boolean;
}

export interface BuiltMap {
  group: THREE.Group;
  sun: THREE.DirectionalLight | null;
  textures: TextureSet;
  setTarget(slot: ParkingSlot | null): void;
  /** 다층 맵 성능: 플레이어 높이에서 ±maxDy 밖 층의 주차 차량 모델을 그리지 않는다(충돌/센서는 데이터 기반이라 무관). 반환: 숨긴 개수 */
  /** 타일 그룹 수 / 현재 보이는 수 (대형 맵이 아니면 0/0) */
  tileStats(): { tiles: number; visible: number; batchedBoxes: number; batchMeshes: number; geo: GeoStats | null };
  /** 0 = 야외, 1 = 실내 구역(지하층) 안. 주변광/태양광을 줄인다 */
  setIndoorFactor(f: number): void;
  setLevelVisibility(playerY: number, maxDy?: number): number;
  /** 통합 맵 성능: 플레이어 (x,z) 에서 반경 밖의 주차 차량 모델을 그리지 않는다(충돌/센서는 데이터 기반이라 무관). 숨긴 개수 반환 */
  setViewCenter(x: number, z: number, radius: number): number;
  animate(t: number): void;
  /**
   * v0.6.0 파손: 장애물 id 의 시각 객체를 원래 자리(합친 메시/인스턴스 포함)에서 떼어 내 독립 그룹(피벗)으로 돌려준다.
   * 피벗 원점 = 장애물 바닥 중심(x, y0, z), 회전 0 — 이후 이동/회전/숨김은 피벗으로 한다. 두 번째 호출부터는 같은 피벗.
   * 그 장애물을 이 빌더가 그리지 않으면(기계식 시설 모델 등) null → 파손(제거/이동) 대상에서 빼야 한다.
   */
  extract(id: string): ExtractedVisual | null;
  /** 이 빌더가 그리는 장애물인가 (extract 가능 여부) */
  canExtract(id: string): boolean;
  dispose(): void;
}

export interface ExtractedVisual {
  pivot: THREE.Group;
  /** 대표 재질(벽 조각을 새로 만들 때 같은 재질을 쓴다) */
  material: THREE.Material | null;
  def: ObstacleDef;
}

function scaleUV(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

export function buildMap(map: MapData, q: QualityOptions): BuiltMap {
  const group = new THREE.Group();
  const tex = createTextures(q.textureSize, q.anisotropy);
  const indoor = map.env.indoor;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const mats = {
    asphalt: track(new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.95 })),
    concrete: track(new THREE.MeshStandardMaterial({ map: tex.concrete, roughness: 0.9 })),
    grass: track(new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1 })),
    sidewalk: track(new THREE.MeshStandardMaterial({ map: tex.concrete, color: 0xcfcfc8, roughness: 0.9 })),
  };

  // ---- 지면 ----
  const b = map.bounds;
  // 지면 구멍(지하 진입 경사로 트렌치 등): 구멍과 겹치는 지면은 구멍을 뺀 도형으로 만든다
  const holes = map.groundHoles ?? [];
  const holedPlane = (cx: number, cz: number, w: number, d: number, uvScale: number): THREE.BufferGeometry => {
    const hit = holes.filter((h) => Math.abs(h.x - cx) < (h.w + w) / 2 && Math.abs(h.z - cz) < (h.d + d) / 2);
    if (!hit.length) {
      const g = new THREE.PlaneGeometry(w, d);
      scaleUV(g, w / uvScale, d / uvScale);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, 0, cz);
      return g;
    }
    // Shape 좌표 (x, -z) → rotateX(-90°) 후 월드 (x, 0, z)
    const shape = new THREE.Shape();
    shape.moveTo(cx - w / 2, -(cz - d / 2));
    shape.lineTo(cx + w / 2, -(cz - d / 2));
    shape.lineTo(cx + w / 2, -(cz + d / 2));
    shape.lineTo(cx - w / 2, -(cz + d / 2));
    shape.closePath();
    for (const h of hit) {
      // 구멍을 지면 도형 안으로 자른다(가장자리에 걸친 구멍 대비 약간 안쪽)
      const x0 = Math.max(cx - w / 2 + 0.001, h.x - h.w / 2);
      const x1 = Math.min(cx + w / 2 - 0.001, h.x + h.w / 2);
      const z0 = Math.max(cz - d / 2 + 0.001, h.z - h.d / 2);
      const z1 = Math.min(cz + d / 2 - 0.001, h.z + h.d / 2);
      if (x1 <= x0 || z1 <= z0) continue;
      const path = new THREE.Path();
      path.moveTo(x0, -z0);
      path.lineTo(x0, -z1);
      path.lineTo(x1, -z1);
      path.lineTo(x1, -z0);
      path.closePath();
      shape.holes.push(path);
    }
    const g = new THREE.ShapeGeometry(shape);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / uvScale, pos.getY(i) / uvScale);
    g.rotateX(-Math.PI / 2);
    return g;
  };
  if (!indoor) {
    const og = Math.max(600, 2 * Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) + 300);
    const g = track(holedPlane(0, 0, og, og, 4));
    const outer = new THREE.Mesh(g, mats.grass);
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    group.add(outer);
  }
  let yOff = 0;
  for (const s of map.surfaces) {
    yOff += 0.0008;
    const raised = s.kind === 'sidewalk';
    let m: THREE.Mesh;
    if (raised) {
      const geo = track(new THREE.BoxGeometry(s.w, 0.12, s.d));
      scaleUV(geo, s.w / 4, s.d / 4);
      m = new THREE.Mesh(geo, mats[s.kind]);
      m.position.set(s.x, 0.06 + yOff, s.z);
    } else {
      m = new THREE.Mesh(track(holedPlane(s.x, s.z, s.w, s.d, 4)), mats[s.kind]);
      m.position.y = yOff + (s.kind === 'grass' ? 0 : 0.004);
    }
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- 주차선/도색 (하나의 지오메트리로 병합 → 드로우콜 1회) ----
  const paintGeos: THREE.BufferGeometry[] = [];
  const white = new THREE.Color(0xf4f4f4);
  for (const p of map.paint) {
    const g = new THREE.PlaneGeometry(p.w, p.d).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.rotateY(p.rot ?? 0);
    g.translate(p.x, 0.02, p.z);
    const c = new THREE.Color(p.color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    paintGeos.push(g);
  }
  void white;
  if (paintGeos.length) {
    const merged = mergeGeometries(paintGeos, false);
    paintGeos.forEach((g) => g.dispose());
    if (merged) {
      merged.computeVertexNormals();
      track(merged);
      const pm = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      const mesh = new THREE.Mesh(merged, pm);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  // ---- 장애물 ----
  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const coneGeo = track(new THREE.ConeGeometry(0.2, 0.72, 14));
  coneGeo.translate(0, 0.36, 0);
  const coneBaseGeo = track(new THREE.BoxGeometry(0.46, 0.04, 0.46));
  coneBaseGeo.translate(0, 0.02, 0);
  const drumGeo = track(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16));
  drumGeo.translate(0, 0.45, 0);
  const poleGeo = track(new THREE.CylinderGeometry(0.08, 0.12, 6.5, 8));
  poleGeo.translate(0, 3.25, 0);
  const lampHeadGeo = track(new THREE.BoxGeometry(0.9, 0.12, 0.3));
  const trunkGeo = track(new THREE.CylinderGeometry(0.18, 0.28, 3.2, 8));
  trunkGeo.translate(0, 1.6, 0);
  const crownGeo = track(new THREE.IcosahedronGeometry(1.9, 1));
  crownGeo.translate(0, 4.4, 0);

  const colorMat = new Map<number, THREE.MeshStandardMaterial>();
  const matFor = (c: number, rough = 0.85): THREE.MeshStandardMaterial => {
    const k = c * 10 + Math.round(rough * 10);
    let m = colorMat.get(k);
    if (!m) {
      m = track(new THREE.MeshStandardMaterial({ color: c, roughness: rough }));
      colorMat.set(k, m);
    }
    return m;
  };
  const lampMat = track(new THREE.MeshStandardMaterial({ color: 0x333840, roughness: 0.6 }));
  const lampGlow = track(new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: indoor ? 1.5 : 1.0 }));
  const crownMat = track(new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 1, flatShading: true }));
  const bandMat = track(new THREE.MeshStandardMaterial({ map: tex.stripes, roughness: 0.7 }));
  const coneMat = track(new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 }));
  const coneBaseMat = track(new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }));
  const drumMat = track(new THREE.MeshStandardMaterial({ color: 0x2a6bd0, roughness: 0.5 }));

  const bollardGeo = track(new THREE.CylinderGeometry(0.1, 0.1, 1, 12));
  const bollardMat = track(new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.35, metalness: 0.85 }));
  const bollardBand = track(new THREE.MeshStandardMaterial({ color: 0xfff27a, emissive: 0x6b5a00, roughness: 0.4 }));
  const cones: ObstacleDef[] = [];
  const drums: ObstacleDef[] = [];
  // ---- v0.6.0 파손용 시각 객체 등록부: 장애물 id → 메시들 / 인스턴스 / 합친 메시 안의 상자 ----
  type VisReg = { def: ObstacleDef; objs: THREE.Object3D[]; inst: { im: () => THREE.InstancedMesh | null; i: number }[]; batch: { key: string; idx: number; mat: THREE.Material } | null };
  const vis = new Map<string, VisReg>();
  const reg = (o: ObstacleDef): VisReg => {
    let r = vis.get(o.id);
    if (!r) vis.set(o.id, (r = { def: o, objs: [], inst: [], batch: null }));
    return r;
  };
  const batchMeshByKey = new Map<string, THREE.Mesh>();
  const BOX_VERTS = 24; // BoxGeometry 정점 수(합친 지오메트리 안에서 상자 i 의 정점 범위 = [24i, 24i+24))

  type CarEntry = { obj: THREE.Object3D; y: number; x: number; z: number; lv: boolean; dv: boolean };
  const levelObjects: CarEntry[] = [];
  const allCars: CarEntry[] = [];
  // ---- 타일 그룹(대형 맵): 고정 구조물 메시를 48m 타일별 그룹에 넣고, 차량에서 먼 타일은 통째로 숨긴다(충돌/센서는 데이터 기반이라 무관) ----
  const large = (b.maxX - b.minX) * (b.maxZ - b.minZ) > 40000;
  const wgrid = new WorldGrid(48);
  const tileGroups = new Map<string, THREE.Group>();
  const addAt = (x: number, z: number, ...objs: THREE.Object3D[]): void => {
    if (!large) {
      group.add(...objs);
      return;
    }
    const k = wgrid.keyOf(x, z);
    let tg = tileGroups.get(k);
    if (!tg) {
      tg = new THREE.Group();
      tg.name = `Tile_${k}`;
      tileGroups.set(k, tg);
      group.add(tg);
    }
    tg.add(...objs);
  };
  let streamer: TileStreamer | null = null;
  const batches = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[]; x: number; z: number }>();
  let batchedBoxes = 0;
  let batchMeshes = 0;
  const bm = new THREE.Matrix4();
  const bq = new THREE.Quaternion();
  const batchBox = (tx: number, tz: number, mat: THREE.Material, cast: boolean, sx: number, sy: number, sz: number, px: number, py: number, pz: number, rot: number): { key: string; idx: number } => {
    const k = `${wgrid.keyOf(tx, tz)}|${mat.uuid}|${cast ? 1 : 0}`;
    let bt = batches.get(k);
    if (!bt) batches.set(k, (bt = { mat, cast, geos: [], x: tx, z: tz }));
    bq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    bm.compose(new THREE.Vector3(px, py, pz), bq, new THREE.Vector3(sx, sy, sz));
    bt.geos.push(boxGeo.clone().applyMatrix4(bm));
    return { key: k, idx: bt.geos.length - 1 };
  };
  for (const o of map.obstacles) {
    if (o.hidden) continue; // 충돌/센서 전용(외형은 geo 레이어가 그린다)
    switch (o.tag) {
      case 'cone':
        cones.push(o);
        break;
      case 'drum':
        drums.push(o);
        break;
      case 'bollard': {
        // 기계식 시설 키트의 볼라드(bol-1n 등)는 시설 모델(mech/mechBuilder)이 그린다. 그 밖의 볼라드(지하 경사로 입구, 정비소, 골목)는 여기서 그린다
        if (/(^|:)bol-\d[ns]$/.test(o.id)) break;
        const r = o.r ?? 0.1;
        const post = new THREE.Mesh(bollardGeo, bollardMat);
        post.scale.set(r / 0.1, o.h, r / 0.1);
        post.position.set(o.x, (o.y0 ?? 0) + o.h / 2, o.z);
        post.castShadow = true;
        const band = new THREE.Mesh(bollardGeo, bollardBand);
        band.scale.set((r / 0.1) * 1.04, 0.12, (r / 0.1) * 1.04);
        band.position.set(o.x, (o.y0 ?? 0) + o.h * 0.78, o.z);
        addAt(o.x, o.z, post, band);
        reg(o).objs.push(post, band);
        break;
      }
      case 'guide':
        break; // 팔레트 가이드는 이동하는 팔레트 모델(mech/mechBuilder)이 그린다
      case 'lamp': {
        const pole = new THREE.Mesh(poleGeo, lampMat);
        pole.position.set(o.x, 0, o.z);
        pole.castShadow = true;
        const head = new THREE.Mesh(lampHeadGeo, lampGlow);
        head.position.set(o.x + 0.45, 6.45, o.z);
        addAt(o.x, o.z, pole, head);
        reg(o).objs.push(pole, head);
        break;
      }
      case 'tree': {
        const t = new THREE.Mesh(trunkGeo, matFor(0x5a3d26));
        t.position.set(o.x, 0, o.z);
        t.castShadow = true;
        const c = new THREE.Mesh(crownGeo, crownMat);
        c.position.set(o.x, 0, o.z);
        c.castShadow = true;
        addAt(o.x, o.z, t, c);
        reg(o).objs.push(t, c);
        break;
      }
      case 'car': {
        const spec = parkedSpec(o.carSpec ?? 0);
        const car = createCarModel(spec, { lite: true, color: o.color, blobTexture: tex.blob });
        car.root.position.set(o.x, o.y0 ?? 0, o.z);
        car.root.rotation.y = o.rot ?? 0;
        group.add(car.root);
        reg(o).objs.push(car.root);
        const entry: CarEntry = { obj: car.root, y: o.y0 ?? 0, x: o.x, z: o.z, lv: true, dv: true };
        allCars.push(entry);
        if ((o.y0 ?? 0) !== 0 || map.terrain) levelObjects.push(entry);
        break;
      }
      case 'building': {
        const w = o.w ?? 1;
        const d = o.d ?? 1;
        const fx = tex.facade.clone();
        fx.needsUpdate = true;
        fx.repeat.set(Math.max(1, Math.round(d / 5)), Math.max(1, Math.round(o.h / 4)));
        const fz = tex.facade.clone();
        fz.needsUpdate = true;
        fz.repeat.set(Math.max(1, Math.round(w / 5)), Math.max(1, Math.round(o.h / 4)));
        const tint = o.color ?? 0xffffff;
        const mx = track(new THREE.MeshStandardMaterial({ map: fx, color: tint, roughness: 0.9 }));
        const mz = track(new THREE.MeshStandardMaterial({ map: fz, color: tint, roughness: 0.9 }));
        track(fx);
        track(fz);
        const roof = matFor(0x777a7c);
        const m = new THREE.Mesh(boxGeo, [mx, mx, roof, roof, mz, mz]);
        m.scale.set(w, o.h, d);
        m.position.set(o.x, o.h / 2, o.z);
        m.rotation.y = o.rot ?? 0;
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
        reg(o).objs.push(m);
        break;
      }
      default: {
        // wall, pillar, barrier, planter, curb
        if (o.shape === 'cyl') break;
        const mat = o.tag === 'barrier' ? bandMat : matFor(o.color ?? 0x999999, o.tag === 'wall' || o.tag === 'pillar' ? 0.95 : 0.8);
        if (large) {
          // 대형 맵: 타일 × 재질별로 상자를 하나의 지오메트리로 합친다(드로우콜 감소). 충돌/센서는 데이터 기반이라 무관
          const bb = batchBox(o.x, o.z, mat, o.h > 0.3, o.w ?? 1, o.h, o.d ?? 1, o.x, (o.y0 ?? 0) + o.h / 2, o.z, o.rot ?? 0);
          reg(o).batch = { ...bb, mat };
          if (o.tag === 'pillar') batchBox(o.x, o.z, bandMat, false, (o.w ?? 1) + 0.02, 0.7, (o.d ?? 1) + 0.02, o.x, (o.y0 ?? 0) + 0.35, o.z, 0);
          break;
        }
        const m = new THREE.Mesh(boxGeo, mat);
        m.scale.set(o.w ?? 1, o.h, o.d ?? 1);
        m.position.set(o.x, (o.y0 ?? 0) + o.h / 2, o.z);
        m.rotation.y = o.rot ?? 0;
        m.castShadow = o.h > 0.3;
        m.receiveShadow = true;
        addAt(o.x, o.z, m);
        reg(o).objs.push(m);
        if (o.tag === 'pillar') {
          // 하단 경고 띠
          const band = new THREE.Mesh(boxGeo, bandMat);
          band.scale.set((o.w ?? 1) + 0.02, 0.7, (o.d ?? 1) + 0.02);
          band.position.set(o.x, (o.y0 ?? 0) + 0.35, o.z);
          addAt(o.x, o.z, band);
        }
      }
    }
  }
  // ---- v0.6.0 실제 지도 표시 레이어 ----
  let geoStats: GeoStats | null = null;
  if (map.geo) geoStats = buildGeoLayer({ geo: map.geo, tex, mats: { asphalt: mats.asphalt, grass: mats.grass, concrete: mats.concrete }, grid: wgrid, root: group, addAt, track });
  // 합치기: 타일 × 재질 × 그림자 여부마다 메시 1개
  for (const [bkey, bt] of batches) {
    const merged = mergeGeometries(bt.geos, false);
    bt.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    track(merged);
    const mesh = new THREE.Mesh(merged, bt.mat);
    mesh.castShadow = bt.cast;
    mesh.receiveShadow = true;
    addAt(bt.x, bt.z, mesh);
    batchMeshByKey.set(bkey, mesh);
    batchedBoxes += bt.geos.length;
    batchMeshes++;
  }

  // 반복 객체: 인스턴싱 (콘, 드럼)
  const tmp = new THREE.Object3D();
  const makeInstances = (list: ObstacleDef[], geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh | null => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((o, i) => {
      tmp.position.set(o.x, 0, o.z);
      tmp.updateMatrix();
      im.setMatrixAt(i, tmp.matrix);
    });
    im.castShadow = true;
    group.add(im);
    return im;
  };
  const coneIm = makeInstances(cones, coneGeo, coneMat);
  const coneBaseIm = makeInstances(cones, coneBaseGeo, coneBaseMat);
  const drumIm = makeInstances(drums, drumGeo, drumMat);
  cones.forEach((o, i) => reg(o).inst.push({ im: () => coneIm, i }, { im: () => coneBaseIm, i }));
  drums.forEach((o, i) => reg(o).inst.push({ im: () => drumIm, i }));

  // ---- 조명 ----
  let sun: THREE.DirectionalLight | null = null;
  let hemi: THREE.HemisphereLight | null = null;
  const zoneLights: THREE.PointLight[] = [];
  const baseAmbient = map.env.ambient + 0.35;
  const sky = new THREE.Color(map.env.sky);
  if (indoor) {
    group.add(new THREE.HemisphereLight(0xa9b8cc, 0x3a3d42, 0.8));
    const ch = map.env.ceilingHeight ?? 2.9;
    const cr = map.env.ceilingRect ?? b;
    const ceilGeo = track(new THREE.PlaneGeometry(cr.maxX - cr.minX, cr.maxZ - cr.minZ));
    const ceil = new THREE.Mesh(ceilGeo, matFor(0x55585c, 0.95));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set((cr.minX + cr.maxX) / 2, ch, (cr.minZ + cr.maxZ) / 2);
    group.add(ceil);
    const panels = map.ceilingLights ?? [];
    const panelGeo = track(new THREE.BoxGeometry(1.6, 0.05, 0.3));
    const panelMat = track(new THREE.MeshBasicMaterial({ color: 0xf2f6ff }));
    const im = new THREE.InstancedMesh(panelGeo, panelMat, panels.length);
    panels.forEach((p, i) => {
      tmp.position.set(p.x, ch - 0.04, p.z);
      tmp.updateMatrix();
      im.setMatrixAt(i, tmp.matrix);
    });
    group.add(im);
    // 실제 광원은 일부만 (성능)
    for (const p of panels.filter((p) => p.z === 0 && Math.abs(Math.abs(p.x) - 18) < 0.01 || (p.z === 0 && Math.abs(Math.abs(p.x) - 6) < 0.01))) {
      const pl = new THREE.PointLight(0xe6eeff, 55, 24, 1.2);
      pl.position.set(p.x, ch - 0.3, p.z);
      group.add(pl);
    }
  } else {
    hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, map.env.ambient + 0.35);
    group.add(hemi);
    // 야외 맵 안의 실내 구역(지하층): 천장 조명 패널(발광) + 일부만 실제 광원
    const zl = (map.ceilingLights ?? []).filter((p) => p.y !== undefined);
    if (zl.length) {
      const panelGeo = track(new THREE.BoxGeometry(1.6, 0.05, 0.3));
      const panelMat = track(new THREE.MeshBasicMaterial({ color: 0xf2f6ff }));
      const im = new THREE.InstancedMesh(panelGeo, panelMat, zl.length);
      zl.forEach((p, i) => {
        tmp.position.set(p.x, (p.y as number) - 0.36, p.z);
        tmp.updateMatrix();
        im.setMatrixAt(i, tmp.matrix);
      });
      group.add(im);
      const every = Math.max(1, Math.ceil(zl.length / 6));
      zl.forEach((p, i) => {
        if (i % every !== 0) return;
        const pl = new THREE.PointLight(0xe6eeff, 9, 20, 1.4);
        pl.visible = false; // 실내 구역에 들어갔을 때만 켠다 (setIndoorFactor)
        pl.position.set(p.x, (p.y as number) - 0.7, p.z);
        group.add(pl);
        zoneLights.push(pl);
      });
    }
    sun = new THREE.DirectionalLight(0xfff3dc, 2.4);
    sun.position.set(30, 50, 20);
    sun.castShadow = q.shadows;
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    group.add(sun, sun.target);
  }

  // ---- 목표 주차 구획 표시 ----
  const targetMat = track(new THREE.MeshBasicMaterial({ color: 0x35e07a, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  const targetMesh = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), targetMat);
  targetMesh.rotation.x = -Math.PI / 2;
  targetMesh.position.y = 0.03;
  targetMesh.visible = false;
  targetMesh.renderOrder = 2;
  group.add(targetMesh);
  const beamMat = track(new THREE.MeshBasicMaterial({ color: 0x35e07a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
  const beam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.35, 0.35, 6, 12, 1, true)), beamMat);
  beam.visible = false;
  group.add(beam);

  const extracted = new Map<string, ExtractedVisual>();
  const result: BuiltMap = {
    group,
    tileStats() {
      return { tiles: tileGroups.size, visible: [...tileGroups.values()].filter((g) => g.visible).length, batchedBoxes, batchMeshes, geo: geoStats };
    },
    setIndoorFactor(f) {
      // 지하/실내 구역 안: 하늘빛과 태양광을 줄이고(지붕이 가린다) 천장 조명만 남긴다
      const k = Math.min(1, Math.max(0, f));
      if (hemi) hemi.intensity = baseAmbient * (1 - 0.8 * k);
      if (sun) sun.intensity = 2.4 * (1 - 0.95 * k);
      for (const l of zoneLights) l.visible = k > 0.02;
    },
    setLevelVisibility(playerY, maxDy = 1.7) {
      let hidden = 0;
      for (const l of levelObjects) {
        l.lv = Math.abs(l.y - playerY) <= maxDy;
        const vis = l.lv && l.dv;
        if (l.obj.visible !== vis) l.obj.visible = vis;
        if (!vis) hidden++;
      }
      return hidden;
    },
    setViewCenter(x, z, radius) {
      let hidden = 0;
      // 타일 스트리밍: 로드 반경 = radius, 언로드 반경 = radius + 25m (경계에서 깜박이지 않게)
      if (large) {
        if (!streamer || streamer.loadRadius !== radius) {
          streamer = new TileStreamer(wgrid, radius, radius + 25, new Set(tileGroups.keys()));
          for (const tg of tileGroups.values()) tg.visible = false;
        }
        const u = streamer.update(x, z);
        for (const k of u.loaded) tileGroups.get(k)!.visible = true;
        for (const k of u.unloaded) tileGroups.get(k)!.visible = false;
      }
      const r2 = radius * radius;
      for (const l of allCars) {
        l.dv = (l.x - x) ** 2 + (l.z - z) ** 2 <= r2;
        const vis = l.lv && l.dv;
        if (l.obj.visible !== vis) l.obj.visible = vis;
        if (!vis) hidden++;
      }
      return hidden;
    },
    sun,
    textures: tex,
    setTarget(slot) {
      if (!slot) {
        targetMesh.visible = false;
        beam.visible = false;
        return;
      }
      targetMesh.visible = true;
      targetMesh.scale.set(slot.w - 0.12, slot.l - 0.12, 1);
      targetMesh.position.set(slot.x, (slot.y ?? 0) + 0.05, slot.z); // 다층: 해당 층 바닥 위
      targetMesh.rotation.set(-Math.PI / 2, 0, -slot.dir, 'YXZ');
      // 평면 회전: Y축(heading) 기준으로 먼저 회전 후 눕힘
      targetMesh.rotation.order = 'YXZ';
      targetMesh.rotation.y = slot.dir;
      targetMesh.rotation.x = -Math.PI / 2;
      targetMesh.rotation.z = 0;
      beam.visible = true;
      beam.position.set(slot.x, (slot.y ?? 0) + 3, slot.z);
    },
    canExtract(id) {
      const r = vis.get(id);
      return !!r && (r.objs.length > 0 || r.inst.length > 0 || r.batch !== null);
    },
    extract(id) {
      const r = vis.get(id);
      if (!r) return null;
      const done = extracted.get(id);
      if (done) return done;
      const o = r.def;
      const pivot = new THREE.Group();
      pivot.name = `Damage_${id}`;
      pivot.position.set(o.x, o.y0 ?? 0, o.z);
      group.add(pivot);
      group.updateMatrixWorld(true);
      let material: THREE.Material | null = null;
      for (const obj of r.objs) {
        pivot.attach(obj); // 월드 변환 유지
        const m = obj as THREE.Mesh;
        if (!material && m.isMesh) material = Array.isArray(m.material) ? m.material[0] : m.material;
      }
      const mtx = new THREE.Matrix4();
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const it of r.inst) {
        const im = it.im();
        if (!im) continue;
        im.getMatrixAt(it.i, mtx);
        const m = new THREE.Mesh(im.geometry, im.material as THREE.Material);
        mtx.decompose(m.position, m.quaternion, m.scale);
        m.castShadow = true;
        group.add(m);
        pivot.attach(m);
        im.setMatrixAt(it.i, zero); // 원래 인스턴스는 숨긴다
        im.instanceMatrix.needsUpdate = true;
        material = material ?? (im.material as THREE.Material);
      }
      if (r.batch) {
        const bmesh = batchMeshByKey.get(r.batch.key);
        if (bmesh) {
          // 합친 지오메트리 안의 이 상자 정점을 한 점으로 모아 숨긴다(삼각형 면적 0)
          const pos = bmesh.geometry.getAttribute('position') as THREE.BufferAttribute;
          const a = r.batch.idx * BOX_VERTS;
          const x0 = pos.getX(a);
          const y0 = pos.getY(a);
          const z0 = pos.getZ(a);
          for (let v = a; v < a + BOX_VERTS && v < pos.count; v++) pos.setXYZ(v, x0, y0, z0);
          pos.needsUpdate = true;
        }
        const m = new THREE.Mesh(boxGeo, r.batch.mat);
        m.scale.set(o.w ?? 1, o.h, o.d ?? 1);
        m.position.set(o.x, (o.y0 ?? 0) + o.h / 2, o.z);
        m.rotation.y = o.rot ?? 0;
        m.castShadow = o.h > 0.3;
        m.receiveShadow = true;
        group.add(m);
        group.updateMatrixWorld(true);
        pivot.attach(m);
        material = material ?? r.batch.mat;
      }
      const ev: ExtractedVisual = { pivot, material, def: o };
      extracted.set(id, ev);
      return ev;
    },
    animate(t) {
      const p = 0.28 + 0.12 * Math.sin(t * 3);
      targetMat.opacity = p;
      beamMat.opacity = 0.14 + 0.1 * Math.sin(t * 3);
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) m.geometry.dispose();
      });
      for (const d of disposables) d.dispose();
      for (const t of Object.values(tex)) (t as THREE.Texture).dispose();
    },
  };
  void sky;
  return result;
}
