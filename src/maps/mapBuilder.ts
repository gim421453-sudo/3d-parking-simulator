import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCarModel } from '../vehicle/carModel';
import { parkedSpec } from '../vehicle/spec';
import { createTextures, type TextureSet } from './textures';
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
  animate(t: number): void;
  dispose(): void;
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
  if (!indoor) {
    const g = track(new THREE.PlaneGeometry(600, 600));
    scaleUV(g, 150, 150);
    const outer = new THREE.Mesh(g, mats.grass);
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    group.add(outer);
  }
  let yOff = 0;
  for (const s of map.surfaces) {
    yOff += 0.0008;
    const raised = s.kind === 'sidewalk';
    const geo = raised ? new THREE.BoxGeometry(s.w, 0.12, s.d) : new THREE.PlaneGeometry(s.w, s.d);
    track(geo);
    scaleUV(geo, s.w / 4, s.d / 4);
    const m = new THREE.Mesh(geo, mats[s.kind]);
    if (raised) {
      m.position.set(s.x, 0.06 + yOff, s.z);
    } else {
      m.rotation.x = -Math.PI / 2;
      m.position.set(s.x, yOff + (s.kind === 'grass' ? 0 : 0.004), s.z);
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

  const cones: ObstacleDef[] = [];
  const drums: ObstacleDef[] = [];

  for (const o of map.obstacles) {
    switch (o.tag) {
      case 'cone':
        cones.push(o);
        break;
      case 'drum':
        drums.push(o);
        break;
      case 'lamp': {
        const pole = new THREE.Mesh(poleGeo, lampMat);
        pole.position.set(o.x, 0, o.z);
        pole.castShadow = true;
        const head = new THREE.Mesh(lampHeadGeo, lampGlow);
        head.position.set(o.x + 0.45, 6.45, o.z);
        group.add(pole, head);
        break;
      }
      case 'tree': {
        const t = new THREE.Mesh(trunkGeo, matFor(0x5a3d26));
        t.position.set(o.x, 0, o.z);
        t.castShadow = true;
        const c = new THREE.Mesh(crownGeo, crownMat);
        c.position.set(o.x, 0, o.z);
        c.castShadow = true;
        group.add(t, c);
        break;
      }
      case 'car': {
        const spec = parkedSpec(o.carSpec ?? 0);
        const car = createCarModel(spec, { lite: true, color: o.color, blobTexture: tex.blob });
        car.root.position.set(o.x, o.y0 ?? 0, o.z);
        car.root.rotation.y = o.rot ?? 0;
        group.add(car.root);
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
        break;
      }
      default: {
        // wall, pillar, barrier, planter, curb
        if (o.shape === 'cyl') break;
        const mat = o.tag === 'barrier' ? bandMat : matFor(o.color ?? 0x999999, o.tag === 'wall' || o.tag === 'pillar' ? 0.95 : 0.8);
        const m = new THREE.Mesh(boxGeo, mat);
        m.scale.set(o.w ?? 1, o.h, o.d ?? 1);
        m.position.set(o.x, (o.y0 ?? 0) + o.h / 2, o.z);
        m.rotation.y = o.rot ?? 0;
        m.castShadow = o.h > 0.3;
        m.receiveShadow = true;
        group.add(m);
        if (o.tag === 'pillar') {
          // 하단 경고 띠
          const band = new THREE.Mesh(boxGeo, bandMat);
          band.scale.set((o.w ?? 1) + 0.02, 0.7, (o.d ?? 1) + 0.02);
          band.position.set(o.x, (o.y0 ?? 0) + 0.35, o.z);
          group.add(band);
        }
      }
    }
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
  makeInstances(cones, coneGeo, coneMat);
  makeInstances(cones, coneBaseGeo, coneBaseMat);
  makeInstances(drums, drumGeo, drumMat);

  // ---- 조명 ----
  let sun: THREE.DirectionalLight | null = null;
  const sky = new THREE.Color(map.env.sky);
  if (indoor) {
    group.add(new THREE.HemisphereLight(0xa9b8cc, 0x3a3d42, 0.8));
    const ch = map.env.ceilingHeight ?? 2.9;
    const ceilGeo = track(new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ));
    const ceil = new THREE.Mesh(ceilGeo, matFor(0x55585c, 0.95));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set((b.minX + b.maxX) / 2, ch, (b.minZ + b.maxZ) / 2);
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
    group.add(new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, map.env.ambient + 0.35));
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

  const result: BuiltMap = {
    group,
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
      targetMesh.position.set(slot.x, 0.03, slot.z);
      targetMesh.rotation.set(-Math.PI / 2, 0, -slot.dir, 'YXZ');
      // 평면 회전: Y축(heading) 기준으로 먼저 회전 후 눕힘
      targetMesh.rotation.order = 'YXZ';
      targetMesh.rotation.y = slot.dir;
      targetMesh.rotation.x = -Math.PI / 2;
      targetMesh.rotation.z = 0;
      beam.visible = true;
      beam.position.set(slot.x, 3, slot.z);
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
