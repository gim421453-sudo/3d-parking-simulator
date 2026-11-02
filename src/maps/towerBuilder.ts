import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { disposeObject } from '../core/dispose';
import type { CircleHole, DeckSurface, RampSurface, Rect2, SpiralSurface, Terrain } from './terrain';
import type { MapData } from './types';

/**
 * 다층 주차타워의 3D 에셋(바닥 슬래브, 직선/나선 경사로, 층별 도색). 맵 데이터(terrain/obstacles)만 읽는다.
 * 기둥/벽/주차 차량은 기존 mapBuilder 가 y0 를 반영해 만든다. 충돌/센서는 이 메시와 무관(데이터 기반).
 */
export interface TowerVisual {
  group: THREE.Group;
  /** 층 바닥 슬래브 (보조 카메라 패스에서 현재 층보다 위의 것을 숨길 때 사용) */
  decks: { mesh: THREE.Mesh; y: number }[];
  dispose(): void;
}

const isCircle = (h: Rect2 | CircleHole): h is CircleHole => (h as CircleHole).r !== undefined;

function deckGeometry(d: DeckSurface): THREE.BufferGeometry {
  const r = d.rect;
  const hw = r.w / 2;
  const hd = r.d / 2;
  // Shape 의 (x, y) → 월드 (x, -z) (rotateX(-90°) 후)
  const shape = new THREE.Shape();
  shape.moveTo(r.x - hw, -(r.z - hd));
  shape.lineTo(r.x + hw, -(r.z - hd));
  shape.lineTo(r.x + hw, -(r.z + hd));
  shape.lineTo(r.x - hw, -(r.z + hd));
  shape.closePath();
  for (const h of d.holes ?? []) {
    const path = new THREE.Path();
    if (isCircle(h)) path.absarc(h.cx, -h.cz, h.r, 0, Math.PI * 2, true);
    else {
      path.moveTo(h.x - h.w / 2, -(h.z - h.d / 2));
      path.lineTo(h.x + h.w / 2, -(h.z - h.d / 2));
      path.lineTo(h.x + h.w / 2, -(h.z + h.d / 2));
      path.lineTo(h.x - h.w / 2, -(h.z + h.d / 2));
      path.closePath();
    }
    shape.holes.push(path);
  }
  const t = d.thickness ?? 0.3;
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 32 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, d.y - t, 0);
  return g;
}

function rampMesh(s: RampSurface, mat: THREE.Material): THREE.Object3D {
  const rise = s.y1 - s.y0;
  const len = Math.hypot(s.length, rise);
  const th = 0.35;
  const g = new THREE.BoxGeometry(len, th, s.width);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  m.rotation.z = Math.atan2(rise, s.length);
  const outer = new THREE.Group();
  outer.add(m);
  // 윗면이 경사면을 지나도록 두께의 절반만큼 아래로
  m.position.y = -th / 2;
  outer.rotation.y = s.rot - Math.PI / 2;
  const fx = Math.sin(s.rot);
  const fz = Math.cos(s.rot);
  outer.position.set(s.x + (fx * s.length) / 2, (s.y0 + s.y1) / 2, s.z + (fz * s.length) / 2);
  return outer;
}

function spiralMesh(s: SpiralSurface, mat: THREE.Material): THREE.Mesh {
  const n = Math.max(24, Math.ceil(Math.abs(s.th1 - s.th0) / 0.1));
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = s.th0 + (s.th1 - s.th0) * t;
    const y = s.y0 + (s.y1 - s.y0) * t;
    for (const r of [s.r0, s.r1]) pos.push(s.cx + r * Math.cos(th), y, s.cz + r * Math.sin(th));
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

export function buildTowerVisual(map: MapData, terrain: Terrain): TowerVisual {
  const group = new THREE.Group();
  group.name = 'Tower';
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8d8e8c, roughness: 0.92 });
  const ramp = new THREE.MeshStandardMaterial({ color: 0x74777a, roughness: 0.9, side: THREE.DoubleSide });
  const decks: TowerVisual['decks'] = [];
  for (const s of terrain.surfaces) {
    if (s.kind === 'deck') {
      if (s.y <= 0.001) continue; // 1F 는 맵의 지면(surfaces)이 담당
      const m = new THREE.Mesh(deckGeometry(s), concrete);
      m.receiveShadow = true;
      m.castShadow = true;
      m.name = `Deck_${s.id}`;
      group.add(m);
      decks.push({ mesh: m, y: s.y });
    } else if (s.kind === 'ramp') {
      const o = rampMesh(s, ramp);
      o.name = `Ramp_${s.id}`;
      group.add(o);
    } else {
      const m = spiralMesh(s, ramp);
      m.name = `Spiral_${s.id}`;
      group.add(m);
    }
  }
  // 상층 주차선/도색 (하나의 지오메트리로 병합)
  const geos: THREE.BufferGeometry[] = [];
  for (const p of map.levelPaint ?? []) {
    const g = new THREE.PlaneGeometry(p.w, p.d).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.rotateY(p.rot ?? 0);
    g.translate(p.x, p.y + 0.02, p.z);
    const c = new THREE.Color(p.color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    geos.push(g);
  }
  if (geos.length) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (merged) {
      merged.computeVertexNormals();
      const pm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const mesh = new THREE.Mesh(merged, pm);
      mesh.name = 'LevelPaint';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return { group, decks, dispose: () => disposeObject(group) };
}
