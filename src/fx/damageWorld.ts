/**
 * 충돌 파손 관리자 (v0.6.0). 순수 물리(physics/impact·bodies·debris)의 결과를 게임 월드에 적용한다.
 *  - 충돌체 목록 변경: 부서진 물체 제거, 벽은 구멍 양쪽 조각으로 분할, 밀린 물체는 동적 목록으로 옮김
 *    (충돌체 배열은 **제자리 splice/push** — Game 의 공간 인덱스가 길이 변화로 다시 만들어진다)
 *  - 시각: 맵 빌더의 `extract` 로 떼어 낸 피벗을 이동/쓰러뜨림/숨김, 균열 자국, 파편·연기·불꽃 입자
 *  - 내 차 손상 누적(부위별)과 외형 변형
 * 그리지 못하는(빌더가 extract 할 수 없는) 장애물은 제거/이동하지 않는다 — 보이는 것과 충돌체가 어긋나지 않게.
 */
import * as THREE from 'three';
import { obbOverlap, type BoxCollider, type Collider } from '../core/geometry';
import type { BuiltMap, ExtractedVisual } from '../maps/mapBuilder';
import type { ObstacleDef } from '../maps/types';
import { kick, makeBody, stepBody, type Body } from '../physics/bodies';
import { burst, displayScale, newDebris, stepDebris, type DebrisSim } from '../physics/debris';
import { applyCarDamage, carDamageEffects, materialOf, newCarDamage, resolveImpact, vehicleMassKg, type CarDamage, type CarDamageEffects, type ImpactResult } from '../physics/impact';
import { centerOf, obbOf, type VehicleState } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';

export interface DamageHooks {
  /** 게임의 정적 충돌체 배열 (제자리로 수정한다) */
  colliders: Collider[];
  /** id → 충돌체 사전 (같이 갱신) */
  byId: Map<string, Collider>;
  /** (x,z) 주변 정적 충돌체 조회 */
  query(x: number, z: number, r: number): Collider[];
  /** 지면 높이 (없으면 0) */
  groundAt(x: number, z: number, y: number): number;
}

export interface ImpactLog {
  id: string;
  tag: string;
  kmh: number;
  energy: number;
  action: 'block' | 'pass';
  broke: boolean;
  mode: string;
  carDamage: number;
}

const DEBRIS_COLOR: Record<string, number> = { wall: 0x9a9a95, pillar: 0xa4a49e, building: 0xb8b2a8, barrier: 0xd9dde0, planter: 0x7d6e5c, cone: 0xff6a1a, drum: 0x2a6bd0, lamp: 0x3a3f46, tree: 0x5a3d26, bollard: 0x9aa3ab, car: 0x2a2f36 };
const METAL = new Set(['car', 'bollard', 'lamp', 'drum']);
const MAX_SCARS = 140;

export class DamageWorld {
  readonly carDamage: CarDamage = newCarDamage();
  /** 장애물 누적 손상(J) */
  readonly obstacleDamage = new Map<string, number>();
  /** 밀려난 물체(동적) — 충돌체는 이쪽 목록에만 있다 */
  readonly bodies = new Map<string, Body>();
  readonly dynamicColliders: Collider[] = [];
  readonly debris: DebrisSim = newDebris(420);
  readonly log: ImpactLog[] = [];
  stats = { impacts: 0, broken: 0, pushed: 0, holes: 0, scars: 0, maxKmh: 0 };
  /** 충돌 직후 표시용(HUD 토스트) — Game 이 읽고 비운다 */
  lastEvent: ImpactLog | null = null;

  private readonly root = new THREE.Group();
  private readonly own = new Map<string, ExtractedVisual>();
  private readonly rot0 = new Map<string, number>();
  private readonly toppling: { pivot: THREE.Group; axis: THREE.Vector3; t: number }[] = [];
  private readonly scarMeshes: THREE.Mesh[] = [];
  private readonly chipMesh: THREE.InstancedMesh;
  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly scarMat: THREE.MeshStandardMaterial;
  private readonly scarGeo: THREE.BoxGeometry;
  private readonly pieceGeo: THREE.BoxGeometry;
  private smokeAcc = 0;
  private carBase: { pz: number; sz: number } | null = null;

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly built: BuiltMap,
    private readonly hooks: DamageHooks,
  ) {
    this.root.name = 'DamageWorld';
    scene.add(this.root);
    const t = <T extends { dispose(): void }>(d: T): T => {
      this.disposables.push(d);
      return d;
    };
    const cap = this.debris.cap;
    this.chipMesh = new THREE.InstancedMesh(t(new THREE.BoxGeometry(1, 1, 1)), t(new THREE.MeshStandardMaterial({ roughness: 0.9 })), cap);
    this.chipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.smokeMesh = new THREE.InstancedMesh(t(new THREE.IcosahedronGeometry(1, 0)), t(new THREE.MeshStandardMaterial({ color: 0x6a6c70, transparent: true, opacity: 0.38, depthWrite: false, roughness: 1 })), 80);
    this.sparkMesh = new THREE.InstancedMesh(t(new THREE.BoxGeometry(1, 1, 1)), t(new THREE.MeshBasicMaterial({ color: 0xffb347 })), 80);
    for (const m of [this.chipMesh, this.smokeMesh, this.sparkMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      this.root.add(m);
    }
    this.chipMesh.castShadow = true;
    this.scarMat = t(new THREE.MeshStandardMaterial({ color: 0x2b2724, roughness: 1, transparent: true, opacity: 0.82 }));
    this.scarGeo = t(new THREE.BoxGeometry(1, 1, 0.04));
    this.pieceGeo = t(new THREE.BoxGeometry(1, 1, 1));
  }

  /** 월드(장애물)가 바뀌었는가 — 재시작 시 맵을 다시 만들어야 한다 */
  get worldChanged(): boolean {
    return this.stats.broken + this.stats.pushed + this.stats.scars + this.stats.holes > 0 || this.obstacleDamage.size > 0;
  }

  get effects(): CarDamageEffects {
    return carDamageEffects(this.carDamage);
  }

  // ---------------------------------------------------------------- 충돌 처리 (worldStep 의 impact 콜백)
  onImpact(hit: Collider, car: VehicleState, spec: VehicleSpec): { action: 'block' | 'pass'; v: number } {
    const c = centerOf(car, spec);
    const body = this.bodies.get(hit.id);
    const r = resolveImpact({
      car: { x: c.x, z: c.z, heading: car.heading, hw: spec.width / 2, hl: spec.length / 2 },
      v: car.v,
      carMass: vehicleMassKg(spec),
      collider: hit,
      damage: this.obstacleDamage.get(hit.id) ?? 0,
      bodyV: body ? { x: body.vx, z: body.vz } : undefined,
    });
    let res: { action: 'block' | 'pass'; v: number } = { action: r.action, v: r.v };
    // 부술 수 없는(그리지 않는) 물체는 제거/이동하지 않는다 → 막힘으로 바꾼다
    const removable = r.mode === 'push' || r.mode === 'shatter' || r.mode === 'topple' || r.mode === 'hole';
    if (removable && r.action === 'pass' && !this.visual(hit.id)) res = { action: 'block', v: 0 };
    const carAdd = r.carEnergy > 0 ? applyCarDamage(this.carDamage, r.zone, r.carEnergy) : 0;
    this.stats.impacts++;
    const kmh = r.vn * 3.6;
    this.stats.maxKmh = Math.max(this.stats.maxKmh, kmh);
    if (r.damage > 0) this.obstacleDamage.set(hit.id, (this.obstacleDamage.get(hit.id) ?? 0) + r.damage);
    const ground = this.hooks.groundAt(r.point.x, r.point.z, car.y);
    const strength = Math.min(1, r.energy / 150000);
    if (r.energy > 300) {
      const tag = hit.tag;
      burst(this.debris, { x: r.point.x, y: ground + Math.min(hit.h, 0.6), z: r.point.z, dirX: r.normal.x, dirZ: r.normal.z, strength, color: DEBRIS_COLOR[tag] ?? 0x8a8a86, ground, count: r.energy > 2500 ? undefined : 3 });
      if (r.energy > 2500 && (METAL.has(tag) || strength > 0.25)) burst(this.debris, { x: r.point.x, y: ground + 0.5, z: r.point.z, dirX: r.normal.x, dirZ: r.normal.z, strength, color: 0xffb347, ground, kind: 'spark' });
      // 내 차 파편(유리/플라스틱)
      if (carAdd > 0.02) burst(this.debris, { x: r.point.x, y: ground + 0.45, z: r.point.z, dirX: r.normal.x, dirZ: r.normal.z, strength: strength * 0.6, color: 0x1f2a33, ground });
    }
    if (res.action === 'pass' && r.mode === 'push') this.push(hit, r, car, spec);
    else if (res.action === 'pass' && r.broke) this.breakObstacle(hit, r, spec);
    else if (r.damage > 0) this.markDamaged(hit, r, ground);
    const ev: ImpactLog = { id: hit.id, tag: hit.tag, kmh, energy: r.energy, action: res.action, broke: r.broke && res.action === 'pass', mode: r.mode, carDamage: carAdd };
    this.log.push(ev);
    if (this.log.length > 60) this.log.shift();
    if (kmh > 1) this.lastEvent = ev;
    return res;
  }

  /** 장애물 시각 객체 (빌더가 그린 것 또는 이 관리자가 만든 벽 조각) */
  private visual(id: string): ExtractedVisual | null {
    return this.own.get(id) ?? (this.built.canExtract(id) ? this.built.extract(id) : null);
  }

  private removeStatic(c: Collider): void {
    const i = this.hooks.colliders.indexOf(c);
    if (i >= 0) this.hooks.colliders.splice(i, 1);
    else {
      const j = this.hooks.colliders.findIndex((q) => q.id === c.id);
      if (j >= 0) this.hooks.colliders.splice(j, 1);
    }
    this.hooks.byId.delete(c.id);
  }

  private push(hit: Collider, r: ImpactResult, car: VehicleState, spec: VehicleSpec): void {
    let b = this.bodies.get(hit.id);
    if (!b) {
      const mat = materialOf(hit);
      b = makeBody(hit, mat.mass, { mu: hit.tag === 'car' ? 0.75 : 0.45, e: mat.e });
      this.removeStatic(hit);
      this.bodies.set(hit.id, b);
      this.dynamicColliders.push(b.collider);
      this.rot0.set(hit.id, hit.kind === 'box' ? hit.rot : 0);
      this.stats.pushed++;
      this.visual(hit.id);
    }
    if (r.push) kick(b, r.push.vx, r.push.vz, r.push.w);
    // 겹침 해소: 차체(새 자세)와 떨어질 때까지 밀어낸 방향으로 조금씩 옮긴다(최대 0.8m)
    const co = obbOf(car, spec);
    const bc = b.collider;
    const dl = Math.hypot(r.push?.vx ?? 0, r.push?.vz ?? 0) || 1;
    const dx = (r.push?.vx ?? -r.normal.x) / dl;
    const dz = (r.push?.vz ?? -r.normal.z) / dl;
    for (let k = 0; k < 16 && obbOverlap(co, bc.kind === 'box' ? { x: bc.x, z: bc.z, rot: bc.rot, hw: bc.w / 2, hl: bc.d / 2 } : { x: bc.x, z: bc.z, rot: 0, hw: bc.r, hl: bc.r }); k++) {
      bc.x += dx * 0.05;
      bc.z += dz * 0.05;
    }
    // 주차 차량은 찌그러짐 표시
    if (hit.tag === 'car') this.dent(hit.id, r);
  }

  private dent(id: string, r: ImpactResult): void {
    const v = this.visual(id);
    if (!v) return;
    const d = Math.min(1, (this.obstacleDamage.get(id) ?? 0) / 160000);
    const p = v.pivot;
    // 찌그러짐: 높이 약간 낮아지고 맞은 쪽으로 기울어짐 (시각 효과 — 충돌체는 그대로)
    p.scale.y = 1 - 0.08 * d;
    p.userData.tilt = (p.userData.tilt ?? 0) + Math.sign(r.normal.x || 1) * 0.02 * d;
    this.darken(p, 0.35 * d);
  }

  private darken(o: THREE.Object3D, k: number): void {
    if (k <= 0) return;
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out = mats.map((mt) => {
        const sm = mt as THREE.MeshStandardMaterial;
        if (!sm.color) return mt;
        let own = sm;
        if (!sm.userData.dmgOwn) {
          own = sm.clone();
          own.userData = { dmgOwn: true, base: sm.color.clone() };
          this.disposables.push(own);
        }
        own.color.copy(own.userData.base as THREE.Color).multiplyScalar(1 - Math.min(0.6, k));
        return own;
      });
      mesh.material = Array.isArray(mesh.material) ? out : out[0];
    });
  }

  private markDamaged(hit: Collider, r: ImpactResult, ground: number): void {
    // 균열/긁힌 자국: 접촉점 표면에 어두운 판 (에너지에 비례한 크기)
    if (r.energy < 4000 || hit.tag === 'car') {
      if (hit.tag === 'car') this.dent(hit.id, r);
      return;
    }
    const k = Math.min(1, r.energy / 120000);
    const m = new THREE.Mesh(this.scarGeo, this.scarMat);
    const s = 0.35 + 1.4 * k;
    m.scale.set(s * (0.8 + 0.4 * Math.random()), s * 0.7, 1);
    m.position.set(r.point.x + r.normal.x * 0.03, ground + Math.min(hit.y0 + hit.h - 0.1, 0.25 + 0.45 * k + hit.y0), r.point.z + r.normal.z * 0.03);
    m.rotation.y = Math.atan2(r.normal.x, r.normal.z);
    m.rotation.z = (Math.random() - 0.5) * 0.8;
    this.root.add(m);
    this.scarMeshes.push(m);
    this.stats.scars++;
    if (this.scarMeshes.length > MAX_SCARS) this.root.remove(this.scarMeshes.shift()!);
  }

  private breakObstacle(hit: Collider, r: ImpactResult, spec: VehicleSpec): void {
    const v = this.visual(hit.id);
    if (!v) return;
    const ground = this.hooks.groundAt(hit.x, hit.z, hit.y0);
    this.stats.broken++;
    this.removeStatic(hit);
    const color = DEBRIS_COLOR[hit.tag] ?? 0x8a8a86;
    if (r.mode === 'shatter') {
      v.pivot.visible = false;
      burst(this.debris, { x: hit.x, y: ground + hit.h * 0.5, z: hit.z, dirX: -r.normal.x, dirZ: -r.normal.z, strength: 1, color, ground, count: 40 });
    } else if (r.mode === 'topple') {
      // 맞은 방향(−n)으로 쓰러진다 — 바닥 축 기준 90° 회전 애니메이션. 충돌체는 제거(쓰러진 모델은 장식)
      const axis = new THREE.Vector3(-r.normal.z, 0, r.normal.x).normalize();
      this.toppling.push({ pivot: v.pivot, axis, t: 0 });
      burst(this.debris, { x: r.point.x, y: ground + 0.4, z: r.point.z, dirX: -r.normal.x, dirZ: -r.normal.z, strength: 0.6, color, ground });
    } else if (r.mode === 'hole' && hit.kind === 'box') {
      this.cutHole(hit, v, r, spec, ground);
    }
  }

  /** 벽 구멍: 접촉점 둘레로 (차폭 + 1.4m) 폭만큼 잘라 양쪽 조각을 새 충돌체/메시로 */
  private cutHole(hit: BoxCollider, v: ExtractedVisual, r: ImpactResult, spec: VehicleSpec, ground: number): void {
    const longX = hit.w >= hit.d;
    const L = longX ? hit.w : hit.d;
    const T = longX ? hit.d : hit.w;
    // 긴 축 방향(월드): 로컬 x = (cos, −sin), 로컬 z = (sin, cos)
    const ax = longX ? Math.cos(hit.rot) : Math.sin(hit.rot);
    const az = longX ? -Math.sin(hit.rot) : Math.cos(hit.rot);
    const u = (r.point.x - hit.x) * ax + (r.point.z - hit.z) * az;
    const half = (spec.width + 1.4) / 2;
    const a = Math.max(-L / 2, u - half);
    const b = Math.min(L / 2, u + half);
    v.pivot.visible = false;
    this.stats.holes++;
    const pieces: [number, number][] = [
      [-L / 2, a],
      [b, L / 2],
    ];
    pieces.forEach(([p0, p1], i) => {
      if (p1 - p0 < 0.3) return;
      const mid = (p0 + p1) / 2;
      const len = p1 - p0;
      const col: BoxCollider = { ...hit, id: `${hit.id}~${i ? 'b' : 'a'}${this.stats.holes}`, x: hit.x + ax * mid, z: hit.z + az * mid, w: longX ? len : T, d: longX ? T : len };
      this.hooks.colliders.push(col);
      this.hooks.byId.set(col.id, col);
      // 조각의 누적 손상은 이어받지 않는다(새 구간)
      const mesh = new THREE.Mesh(this.pieceGeo, v.material ?? this.scarMat);
      mesh.scale.set(col.w, col.h, col.d);
      mesh.position.set(col.x, col.y0 + col.h / 2, col.z);
      mesh.rotation.y = col.rot;
      mesh.castShadow = col.h > 0.3;
      mesh.receiveShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(col.x, col.y0, col.z);
      this.root.add(pivot);
      this.root.add(mesh);
      this.root.updateMatrixWorld(true);
      pivot.attach(mesh);
      const def: ObstacleDef = { id: col.id, tag: 'wall', shape: 'box', x: col.x, z: col.z, w: col.w, d: col.d, rot: col.rot, h: col.h, y0: col.y0 };
      this.own.set(col.id, { pivot, material: v.material, def });
    });
    const cx = hit.x + ax * (a + b) / 2;
    const cz = hit.z + az * (a + b) / 2;
    burst(this.debris, { x: cx, y: ground + hit.h * 0.5, z: cz, dirX: -r.normal.x, dirZ: -r.normal.z, strength: 1, color: DEBRIS_COLOR.wall, ground, count: 46 });
  }

  // ---------------------------------------------------------------- 프레임 갱신
  update(dt: number, car: VehicleState, spec: VehicleSpec, model: { bodyGroup: THREE.Object3D } | null): void {
    // 밀린 물체 이동
    for (const b of this.bodies.values()) {
      if (b.sleeping) continue;
      const others = [...this.hooks.query(b.collider.x, b.collider.z, 8), ...this.dynamicColliders];
      stepBody(b, dt, others);
      const v = this.visual(b.id);
      if (v) {
        v.pivot.position.x = b.collider.x;
        v.pivot.position.z = b.collider.z;
        if (b.collider.kind === 'box') v.pivot.rotation.y = b.collider.rot - (this.rot0.get(b.id) ?? 0);
        if (v.pivot.userData.tilt) v.pivot.rotation.z = v.pivot.userData.tilt;
      }
    }
    // 쓰러지는 물체
    for (let i = this.toppling.length - 1; i >= 0; i--) {
      const t = this.toppling[i];
      t.t = Math.min(1, t.t + dt / 0.7);
      const ang = (Math.PI / 2) * (1 - Math.cos((t.t * Math.PI) / 2)) * 0.97;
      t.pivot.quaternion.setFromAxisAngle(t.axis, ang);
      if (t.t >= 1) this.toppling.splice(i, 1);
    }
    // 내 차 연기
    const fx = this.effects;
    if (fx.smoke) {
      this.smokeAcc += dt;
      if (this.smokeAcc > 0.24) {
        this.smokeAcc = 0;
        const c = centerOf(car, spec);
        const f = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
        const front = this.carDamage.front >= this.carDamage.rear ? 1 : -1;
        const px = c.x + f.x * front * spec.length * 0.36;
        const pz = c.z + f.z * front * spec.length * 0.36;
        burst(this.debris, { x: px, y: car.y + spec.height * 0.62, z: pz, dirX: f.x, dirZ: f.z, strength: 0.4, color: 0x555555, ground: car.y, kind: 'smoke', count: 1 });
      }
    }
    stepDebris(this.debris, dt);
    this.renderParticles();
    if (model) this.applyCarVisual(model.bodyGroup, spec);
  }

  private readonly tmp = new THREE.Object3D();
  private readonly tmpColor = new THREE.Color();
  private renderParticles(): void {
    let nc = 0;
    let ns = 0;
    let np = 0;
    const o = this.tmp;
    for (const p of this.debris.list) {
      const s = displayScale(p);
      o.position.set(p.x, p.y, p.z);
      o.rotation.set(p.rx, p.ry, p.rz);
      if (p.kind === 'smoke') {
        if (ns >= this.smokeMesh.instanceMatrix.count) continue;
        o.scale.setScalar(s);
        o.updateMatrix();
        this.smokeMesh.setMatrixAt(ns++, o.matrix);
      } else if (p.kind === 'spark') {
        if (np >= this.sparkMesh.instanceMatrix.count) continue;
        o.scale.set(s, s, s * 4);
        o.updateMatrix();
        this.sparkMesh.setMatrixAt(np++, o.matrix);
      } else {
        o.scale.set(s, s * 0.6, s * 0.8);
        o.updateMatrix();
        this.chipMesh.setMatrixAt(nc, o.matrix);
        this.chipMesh.setColorAt(nc++, this.tmpColor.setHex(p.color));
      }
    }
    this.chipMesh.count = nc;
    this.smokeMesh.count = ns;
    this.sparkMesh.count = np;
    this.chipMesh.instanceMatrix.needsUpdate = true;
    if (this.chipMesh.instanceColor) this.chipMesh.instanceColor.needsUpdate = true;
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
  }

  /** 내 차 외형 변형: 앞/뒤 손상 → 그쪽 끝이 짧아짐, 좌/우 → 그쪽으로 기울어짐. 충돌체/센서는 그대로(시각 전용) */
  private applyCarVisual(body: THREE.Object3D, spec: VehicleSpec): void {
    if (!this.carBase) this.carBase = { pz: body.position.z, sz: body.scale.z };
    const d = this.carDamage;
    const crush = 0.09;
    body.scale.z = this.carBase.sz * (1 - crush * (d.front + d.rear) / 2);
    body.position.z = this.carBase.pz + (spec.length * crush * (d.rear - d.front)) / 4;
    body.rotation.z = (d.left - d.right) * 0.035;
    body.rotation.x = (d.front - d.rear) * 0.015;
  }

  /** 차량을 새로 시작할 때(새 차/차종 변경): 내 차 손상만 초기화 */
  resetCar(body: THREE.Object3D | null): void {
    Object.assign(this.carDamage, newCarDamage());
    if (body && this.carBase) {
      body.scale.z = this.carBase.sz;
      body.position.z = this.carBase.pz;
      body.rotation.z = 0;
      body.rotation.x = 0;
    }
    this.carBase = null;
  }

  dispose(): void {
    this.scene.remove(this.root);
    for (const d of this.disposables) d.dispose();
    this.root.clear();
  }
}
