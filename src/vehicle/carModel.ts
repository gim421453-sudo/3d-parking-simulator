import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LightingOutput } from './lighting';
import type { VehicleSpec } from './spec';
import { disposeObject } from '../core/dispose';
import { KR_PLATE, makeKrPlateMaterial } from './plate';

/** 차량 시각 모델. 충돌체(OBB)/센서 좌표는 VehicleSpec 에 별도로 있으며 이 모델과 독립적이다. */
/** 실내 화면: 캔버스에 그리고 텍스처로 쓴다 */
export interface CabinScreen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh;
}

export interface MirrorPlanes {
  left: THREE.Mesh;
  right: THREE.Mesh;
  room: THREE.Mesh;
}

export interface CarModel {
  /** 1인칭 사이드미러/룸미러 표시면 (실제 장면 렌더링 텍스처가 붙는다) */
  mirrors: MirrorPlanes | null;
  /** 1인칭 실내의 센터 디스플레이/계기판 (lite 모델에는 없음) */
  cabin: { center: CabinScreen; cluster: CabinScreen } | null;
  root: THREE.Group; // 원점 = 차체 중심의 지면 투영점, +z = 앞, +x = 왼쪽
  bodyGroup: THREE.Group; // 1인칭 시점에서는 숨긴다
  cockpit: THREE.Group; // 1인칭 시점 전용 (대시보드, 핸들)
  steeringWheel: THREE.Object3D | null;
  frontPivots: THREE.Object3D[];
  rollers: THREE.Object3D[];
  headSpot: THREE.SpotLight | null; // 하향등
  highSpot: THREE.SpotLight | null; // 상향등
  lights: LightMaterials | null;
  setState(s: CarVisualState): void;
  dispose(): void;
}

export interface CarVisualState {
  steer: number;
  roll: number;
  lighting: LightingOutput;
  /** AUTO Leveling 보정 각도(rad, 아래 −). 가속도 기반 근사 */
  levelPitch: number;
  brake: boolean;
  reverse: boolean;
  signalLeft: boolean; // 현재 깜빡임 켜짐 상태
  signalRight: boolean;
}

interface LightMaterials {
  head: THREE.MeshStandardMaterial;
  drl: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  rev: THREE.MeshStandardMaterial;
  sigL: THREE.MeshStandardMaterial;
  sigR: THREE.MeshStandardMaterial;
}

interface BodyShape {
  belt: number;
  hood: number; // 앞 오버행 ~ 캐빈 시작
  trunk: number; // 뒤 ~ 캐빈 시작
  topRearInset: number;
  topFrontInset: number;
}

const SHAPES: Record<'hatch' | 'sedan' | 'suv', BodyShape> = {
  sedan: { belt: 0.86, hood: 1.15, trunk: 0.95, topRearInset: 0.55, topFrontInset: 0.45 },
  hatch: { belt: 0.84, hood: 0.85, trunk: 0.0, topRearInset: 0.25, topFrontInset: 0.4 },
  suv: { belt: 1.0, hood: 1.0, trunk: 0.15, topRearInset: 0.12, topFrontInset: 0.4 },
};

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.Material>();

function extrudeProfile(key: string, pts: [number, number][], width: number): THREE.BufferGeometry {
  const hit = geoCache.get(key);
  if (hit) return hit;
  const shape = new THREE.Shape();
  pts.forEach(([z, y], i) => (i === 0 ? shape.moveTo(z, y) : shape.lineTo(z, y)));
  shape.closePath();
  const bevel = 0.035;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, width - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2); // 프로파일의 x → 차량 z, 압출 방향 → 차량 x
  geoCache.set(key, g);
  return g;
}

function box(key: string, w: number, h: number, d: number): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(key, g);
  }
  return g;
}

function cyl(key: string, rt: number, rb: number, h: number, seg: number): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rt, rb, h, seg);
    g.rotateZ(Math.PI / 2);
    geoCache.set(key, g);
  }
  return g;
}

/** 번호판 두께와 차체 외곽에서 띄우는 간격(m) */
export const PLATE_DEPTH = 0.02;
export const PLATE_STANDOFF = 0.012;

function sharedMat(key: string, make: () => THREE.Material): THREE.Material {
  let m = matCache.get(key);
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}

export interface CarOptions {
  lite?: boolean; // 주차된 장애물 차량: 조명/콕핏/미러 생략
  color?: number;
  blobTexture?: THREE.Texture;
}

export function createCarModel(spec: VehicleSpec, opts: CarOptions = {}): CarModel {
  const lite = !!opts.lite;
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const hl = L / 2;
  const sh = SHAPES[spec.visual.body];
  const color = opts.color ?? spec.color;
  const clearance = 0.24;

  const root = new THREE.Group();
  root.userData.hl = hl;
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'Body';
  root.add(bodyGroup);

  const bodyMat = sharedMat(`body:${color}`, () => new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.35 })) as THREE.MeshStandardMaterial;
  const glassMat = sharedMat('glass', () => new THREE.MeshStandardMaterial({ color: 0x16222e, metalness: 0.7, roughness: 0.08 }));
  const darkMat = sharedMat('dark', () => new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 }));
  const tireMat = sharedMat('tire', () => new THREE.MeshStandardMaterial({ color: 0x0e0f10, roughness: 0.95 }));
  const rimMat = sharedMat('rim', () => new THREE.MeshStandardMaterial({ color: 0xb9bec5, metalness: 0.9, roughness: 0.25 }));
  const plateMat = sharedMat('plate', () => new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));

  const belt = sh.belt * (H / 1.45);
  const z0 = -hl + sh.trunk;
  const z1 = hl - sh.hood;
  const z0t = z0 + sh.topRearInset;
  const z1t = z1 - sh.topFrontInset;
  const bodyW = W * 0.96;
  const key = `${spec.id}`;

  // 하부 차체(사이드 프로파일 압출)
  const lower = extrudeProfile(`${key}:lower`, [
    [-hl, clearance],
    [hl, clearance],
    [hl, belt - 0.26],
    [hl - 0.22, belt - 0.03],
    [z1, belt],
    [z0, belt],
    [-hl, belt - 0.04],
  ], bodyW);
  const lowerMesh = new THREE.Mesh(lower, bodyMat);
  lowerMesh.castShadow = true;
  bodyGroup.add(lowerMesh);

  // 캐빈(유리) + 지붕
  const cabin = extrudeProfile(`${key}:cabin`, [
    [z0 + 0.02, belt - 0.02],
    [z1, belt - 0.02],
    [z1t, H - 0.05],
    [z0t, H - 0.05],
  ], W * 0.88);
  const cabinMesh = new THREE.Mesh(cabin, glassMat);
  cabinMesh.castShadow = true;
  bodyGroup.add(cabinMesh);
  const roof = new THREE.Mesh(box(`${key}:roof`, W * 0.84, 0.06, Math.max(0.2, z1t - z0t + 0.1)), bodyMat);
  roof.position.set(0, H - 0.04, (z0t + z1t) / 2);
  roof.castShadow = true;
  bodyGroup.add(roof);

  // 범퍼
  for (const s of [1, -1]) {
    const b = new THREE.Mesh(box(`${key}:bumper`, W * 0.97, 0.2, 0.1), darkMat);
    b.position.set(0, clearance + 0.12, s * (hl - 0.03));
    bodyGroup.add(b);
  }
  // 번호판: 차체 "실제 외곽"(lowerMesh 범위: 베벨 포함)에서 일정 간격만큼 띄워 부착한다.
  // (hl 기준 고정 좌표는 차종별 베벨/오버행 때문에 차체 면과 거의 같은 평면이 되어 깜빡임/뜬 것처럼 보일 수 있었다)
  lower.computeBoundingBox();
  const zExtent = Math.max(Math.abs(lower.boundingBox!.min.z), Math.abs(lower.boundingBox!.max.z));
  const plateMatKr = spec.plate ? makeKrPlateMaterial(spec.plate) : null;
  for (const s of [1, -1]) {
    const plate = new THREE.Mesh(box(`${key}:plate`, KR_PLATE.widthM, KR_PLATE.heightM, PLATE_DEPTH), plateMatKr ?? plateMat);
    plate.name = s > 0 ? 'Plate_Front' : 'Plate_Rear';
    plate.position.set(0, clearance + 0.3, s * (zExtent + PLATE_STANDOFF + PLATE_DEPTH / 2));
    bodyGroup.add(plate);
  }

  // 바퀴
  const rearZ = -hl + spec.rearOverhang;
  const frontZ = rearZ + spec.wheelbase;
  const r = spec.wheelRadius;
  const tw = 0.22;
  const frontPivots: THREE.Object3D[] = [];
  const rollers: THREE.Object3D[] = [];
  for (const [wz, front] of [
    [frontZ, true],
    [rearZ, false],
  ] as [number, boolean][]) {
    for (const sx of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.name = `Wheel_${front ? 'F' : 'R'}${sx > 0 ? 'L' : 'R'}`; // GLB 규약: 원점 = 바퀴 회전 중심
      pivot.position.set(sx * (W / 2 - tw / 2), r, wz);
      const roll = new THREE.Group();
      const tire = new THREE.Mesh(cyl(`${key}:tire`, r, r, tw, 18), tireMat);
      tire.castShadow = true;
      const rim = new THREE.Mesh(cyl(`${key}:rim`, r * 0.62, r * 0.62, tw + 0.01, 10), rimMat);
      roll.add(tire, rim);
      // 림에 방향 표시용 스포크(회전이 눈에 보이도록)
      const spoke = new THREE.Mesh(box(`${key}:spoke`, tw + 0.02, r * 1.05, 0.05), rimMat);
      roll.add(spoke);
      pivot.add(roll);
      bodyGroup.add(pivot);
      rollers.push(roll);
      if (front) frontPivots.push(pivot);
    }
  }

  // 지면 블롭 그림자(그림자 맵을 끈 저사양/실내에서도 접지감 제공)
  if (opts.blobTexture) {
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(L * 1.25, W * 1.5),
      new THREE.MeshBasicMaterial({ map: opts.blobTexture, transparent: true, depthWrite: false, opacity: 0.8 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.rotation.z = Math.PI / 2;
    blob.position.y = 0.02;
    blob.renderOrder = 1;
    root.add(blob);
  }

  let lights: LightMaterials | null = null;
  let headSpot: THREE.SpotLight | null = null;
  let highSpot: THREE.SpotLight | null = null;
  const cockpit = new THREE.Group();
  let steeringWheel: THREE.Object3D | null = null;
  let cabinScreens: { center: CabinScreen; cluster: CabinScreen } | null = null;
  let mirrorPlanes: MirrorPlanes | null = null;

  const ownMaterials: THREE.Material[] = [];

  if (!lite) {
    // 거울
    for (const sx of [1, -1]) {
      const m = new THREE.Mesh(box(`${key}:mirror`, 0.13, 0.1, 0.2), bodyMat);
      m.position.set(sx * (W / 2 + 0.05), belt + 0.08, z1 - 0.08);
      bodyGroup.add(m);
    }
    // 등화류 (차량별 재질: 켜짐/꺼짐 갱신)
    const mk = (c: number, e: number): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color: c, emissive: e, emissiveIntensity: 0, roughness: 0.3 });
      ownMaterials.push(m);
      return m;
    };
    lights = {
      head: mk(0xfff4d6, 0xfff0c0),
      drl: mk(0xe4eeff, 0xd2e4ff),
      tail: mk(0x7a0d12, 0xff1a1a),
      rev: mk(0xdddddd, 0xffffff),
      sigL: mk(0xb87400, 0xffa200),
      sigR: mk(0xb87400, 0xffa200),
    };
    lights.head.name = 'Lamp_Head';
    lights.drl.name = 'Lamp_DRL';
    lights.tail.name = 'Lamp_Tail';
    lights.rev.name = 'Lamp_Rev';
    lights.sigL.name = 'Lamp_SigL';
    lights.sigR.name = 'Lamp_SigR';
    const hy = belt - 0.2;
    for (const sx of [1, -1]) {
      const hlm = new THREE.Mesh(box(`${key}:head`, W * 0.2, 0.1, 0.06), lights.head);
      hlm.position.set(sx * W * 0.33, hy, hl - 0.04);
      const tlm = new THREE.Mesh(box(`${key}:tail`, W * 0.22, 0.09, 0.05), lights.tail);
      tlm.position.set(sx * W * 0.34, hy, -hl + 0.03);
      const rvm = new THREE.Mesh(box(`${key}:rev`, W * 0.1, 0.06, 0.05), lights.rev);
      rvm.position.set(sx * W * 0.19, hy - 0.04, -hl + 0.03);
      const sig = sx > 0 ? lights.sigL : lights.sigR;
      const sf = new THREE.Mesh(box(`${key}:sigf`, 0.12, 0.06, 0.05), sig);
      sf.position.set(sx * (W / 2 - 0.1), hy - 0.1, hl - 0.03);
      const sr = new THREE.Mesh(box(`${key}:sigr`, 0.12, 0.06, 0.05), sig);
      sr.position.set(sx * (W / 2 - 0.1), hy - 0.1, -hl + 0.03);
      const drlStrip = new THREE.Mesh(box(`${key}:drl`, W * 0.22, 0.022, 0.04), lights.drl);
      drlStrip.position.set(sx * W * 0.33, hy + 0.075, hl - 0.035);
      bodyGroup.add(hlm, tlm, rvm, sf, sr, drlStrip);
    }
    headSpot = new THREE.SpotLight(0xfff2d0, 0, 26, 0.55, 0.5, 1.6);
    headSpot.position.set(0, 0.7, hl - 0.2);
    headSpot.target.position.set(0, 0, hl + 8);
    root.add(headSpot, headSpot.target);
    highSpot = new THREE.SpotLight(0xf4f7ff, 0, 48, 0.32, 0.4, 1.3);
    highSpot.position.set(0, 0.72, hl - 0.2);
    highSpot.target.position.set(0, 0.4, hl + 18);
    root.add(highSpot, highSpot.target);

    // 1인칭 콕핏 (차체는 숨기고 대시보드/후드/필러/지붕 안쪽만 표시)
    const dashMat = sharedMat('dash', () => new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.7 }));
    const eye = spec.driverEye;
    const dash = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.2, 0.42), dashMat);
    dash.position.set(0, belt - 0.07, z1 - 0.22);
    cockpit.add(dash);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, 0.05, sh.hood + 0.05), bodyMat);
    hood.position.set(0, belt - 0.03, (z1 + hl) / 2);
    cockpit.add(hood);
    const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): THREE.Mesh => {
      const a = new THREE.Vector3(ax, ay, az);
      const b = new THREE.Vector3(bx, by, bz);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.BoxGeometry(t, t, len), dashMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
      return m;
    };
    for (const sx of [1, -1]) {
      cockpit.add(beam(sx * W * 0.45, belt, z1 - 0.02, sx * W * 0.42, H - 0.06, z1t, 0.05)); // A필러
      cockpit.add(beam(sx * W * 0.45, belt, z0 + 0.02, sx * W * 0.42, H - 0.06, z0t, 0.06)); // C필러
    }
    const headlinerLen = z1t - z0t + 0.1;
    const headliner = new THREE.Mesh(new THREE.BoxGeometry(W * 0.84, 0.03, headlinerLen), dashMat);
    headliner.position.set(0, H - 0.075, (z0t + z1t) / 2);
    cockpit.add(headliner);
    const wheel = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 8, 20), dashMat);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), dashMat);
    hub.rotation.x = Math.PI / 2;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.02), dashMat);
    wheel.add(ring, hub, bar);
    wheel.position.set(eye.x, eye.y - 0.2, eye.z + 0.5);
    wheel.rotation.x = -0.9; // 운전자 쪽으로 기울임
    cockpit.add(wheel);
    steeringWheel = wheel;
    // 실내 화면 (센터 디스플레이 + 디지털 계기판): 3인칭 플로팅 패널과 같은 상태를 그린다
    const mkScreen = (cw: number, ch: number, mw: number, mh: number, pos: THREE.Vector3): CabinScreen => {
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#05080c';
      ctx.fillRect(0, 0, cw, ch);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mw, mh), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
      mesh.position.copy(pos);
      mesh.lookAt(new THREE.Vector3(eye.x, eye.y, eye.z)); // 운전자 쪽을 향함
      cockpit.add(mesh);
      ownMaterials.push(mesh.material as THREE.Material);
      return { canvas, ctx, texture, mesh };
    };
    const mkMirror = (mw: number, mh: number, pos: THREE.Vector3, yaw: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(mw, mh), new THREE.MeshBasicMaterial({ color: 0x1a2430, toneMapped: false }));
      m.position.copy(pos);
      m.lookAt(new THREE.Vector3(eye.x, eye.y, eye.z));
      m.rotateY(yaw);
      cockpit.add(m);
      ownMaterials.push(m.material as THREE.Material);
      return m;
    };
    mirrorPlanes = {
      left: mkMirror(0.2, 0.1, new THREE.Vector3(W / 2 + 0.1, belt + 0.1, z1 - 0.08), 0),
      right: mkMirror(0.2, 0.1, new THREE.Vector3(-(W / 2 + 0.1), belt + 0.1, z1 - 0.08), 0),
      room: mkMirror(0.24, 0.07, new THREE.Vector3(0.12, H - 0.17, z1t - 0.1), 0),
    };
    cabinScreens = {
      center: mkScreen(768, 336, 0.58, 0.254, new THREE.Vector3(0.02, belt + 0.2, z1 - 0.2)),
      cluster: mkScreen(512, 196, 0.42, 0.161, new THREE.Vector3(eye.x, eye.y - 0.16, eye.z + 0.72)),
    };
    cockpit.visible = false;
    root.add(cockpit);
  }

  const model: CarModel = {
    mirrors: mirrorPlanes,
    cabin: cabinScreens,
    root,
    bodyGroup,
    cockpit,
    steeringWheel,
    frontPivots,
    rollers,
    headSpot,
    highSpot,
    lights,
    setState(s) {
      for (const p of model.frontPivots) p.rotation.y = s.steer;
      for (const rl of model.rollers) rl.rotation.x = s.roll;
      if (model.steeringWheel) model.steeringWheel.userData.steer = s.steer;
      if (model.steeringWheel) {
        // 핸들 회전: 로컬 z축 기준 (기울어진 상태에서 자연스럽게)
        const sw = model.steeringWheel;
        sw.rotation.set(-0.9, 0, 0);
        sw.rotateZ((s.steer / spec.maxSteer) * (540 * Math.PI) / 180); // 실제 핸들 회전(바퀴 최대 조향 = 핸들 540°)
      }
      const l = model.lights;
      if (!l) return;
      const L = s.lighting;
      l.head.emissiveIntensity = L.high ? 2.6 : L.low ? 1.6 : 0;
      l.drl.emissiveIntensity = L.drl * 2.2;
      l.tail.emissiveIntensity = s.brake ? 2.4 : L.tail > 0 ? 0.8 : 0.06; // 브레이크등은 미등보다 더 밝다
      l.rev.emissiveIntensity = s.reverse ? 2.0 : 0;
      l.sigL.emissiveIntensity = s.signalLeft ? 2.4 : 0;
      l.sigR.emissiveIntensity = s.signalRight ? 2.4 : 0;
      // 실제 광원: 하향등/상향등이 노면과 장애물을 비춘다. 조사각은 AUTO Leveling 보정(가속도 기반 근사)을 반영
      if (model.headSpot) {
        model.headSpot.intensity = L.low ? 60 : 0;
        model.headSpot.target.position.set(0, Math.tan(s.levelPitch) * 8, model.root.userData.hl + 8);
      }
      if (model.highSpot) {
        model.highSpot.intensity = L.high ? 120 : 0;
        model.highSpot.target.position.set(0, 0.4 + Math.tan(s.levelPitch) * 18, model.root.userData.hl + 18);
      }
    },
    dispose() {
      // 공유 캐시(geoCache/matCache)와 맵 공용 그림자 텍스처는 제외하고 이 모델이 만든 자원만 해제 (GLB 로 붙은 장면 포함)
      disposeObject(root, {
        geometries: new Set(geoCache.values()),
        materials: new Set(matCache.values()),
        textures: opts.blobTexture ? new Set([opts.blobTexture]) : undefined,
      });
      for (const m of ownMaterials) m.dispose();
      headSpot?.dispose();
      highSpot?.dispose();
    },
  };
  void opts;
  return model;
}

/** GLB 차량 교체: spec.visual.kind === 'glb' 일 때 사용. 실패하면 false (프로시저럴 모델 유지). 규칙은 docs/CAR_MODEL_GUIDE.md 참고. */
export async function applyGlbVisual(model: CarModel, spec: VehicleSpec): Promise<boolean> {
  const v = spec.visual;
  if (v.kind !== 'glb' || !v.url) return false;
  try {
    const gltf = await new GLTFLoader().loadAsync(v.url);
    return attachGlbScene(model, gltf.scene, v.scale ?? 1, v.offset ?? { x: 0, y: 0, z: 0 }, v.rotY ?? 0);
  } catch (e) {
    console.warn('[GLB] 차량 모델 로드 실패, 기본 모델 사용:', e);
    return false;
  }
}

export function attachGlbScene(
  model: CarModel,
  scene: THREE.Object3D,
  scale: number,
  offset: { x: number; y: number; z: number },
  rotY: number,
): boolean {
  const node = scene;
  node.scale.setScalar(scale);
  node.position.set(offset.x, offset.y, offset.z);
  node.rotation.y = rotY;
  const rollers: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  const lampSeen = new Set<string>();
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const w = node.getObjectByName(`Wheel_${k}`);
    if (!w || !w.parent) continue;
    const pivot = new THREE.Group();
    pivot.position.copy(w.position);
    w.position.set(0, 0, 0);
    w.parent.add(pivot);
    pivot.add(w);
    rollers.push(w);
    if (k[0] === 'F') pivots.push(pivot);
  }
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    o.castShadow = true;
    // 램프 재질 이름 규약(Lamp_Head/DRL/Tail/Rev/SigL/SigR)이 있으면 점등 시스템에 연결
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const l = model.lights;
    if (!l || !mat?.name) return;
    const map: Record<string, keyof typeof l> = { Lamp_Head: 'head', Lamp_DRL: 'drl', Lamp_Tail: 'tail', Lamp_Rev: 'rev', Lamp_SigL: 'sigL', Lamp_SigR: 'sigR' };
    const key = map[mat.name];
    if (key) {
      if (!lampSeen.has(key)) {
        lampSeen.add(key);
        l[key] = mat;
      } else mesh.material = l[key]; // 같은 이름의 재질은 하나로 공유
    }
  });
  // 기존 프로시저럴 차체 제거 (번호판은 보존해 GLB 외곽에 다시 부착)
  const plates = model.bodyGroup.children.filter((c) => c.name === 'Plate_Front' || c.name === 'Plate_Rear');
  for (const c of [...model.bodyGroup.children]) model.bodyGroup.remove(c);
  model.bodyGroup.add(node);
  const glbHasPlates = !!(node.getObjectByName('Plate_Front') && node.getObjectByName('Plate_Rear'));
  if (!glbHasPlates) {
    node.updateMatrixWorld(true);
    model.root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(node).applyMatrix4(model.root.matrixWorld.clone().invert());
    for (const p of plates) {
      const sgn = p.name === 'Plate_Front' ? 1 : -1;
      const ext = sgn > 0 ? bb.max.z : -bb.min.z;
      p.position.z = sgn * (ext + PLATE_STANDOFF + PLATE_DEPTH / 2);
      model.bodyGroup.add(p);
    }
  }
  model.rollers.length = 0;
  model.rollers.push(...rollers);
  model.frontPivots.length = 0;
  model.frontPivots.push(...pivots);
  return true;
}
