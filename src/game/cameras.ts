import * as THREE from 'three';
import { clamp, forwardOf, localToWorld } from '../core/math';
import type { Collider } from '../core/geometry';
import { freeFraction } from '../pdc/visibility';
import type { AssistView } from '../pdc/viewPolicy';
import type { VehicleSpec } from '../vehicle/spec';

export type CameraMode = 'chase' | 'driver' | 'top' | 'rear' | 'front' | 'free';
export const CAMERA_ORDER: CameraMode[] = ['chase', 'driver', 'top', 'rear', 'front', 'free'];
export const CAMERA_NAMES: Record<CameraMode, string> = {
  chase: '3인칭 추적',
  driver: '운전석 1인칭',
  top: '탑뷰',
  rear: '후방 카메라',
  front: '전방 카메라',
  free: '자유 시점',
};

export interface CarPose {
  x: number; // 차체 중심
  z: number;
  heading: number;
  /** 차체 중심의 지면 높이 (다층 맵). 없으면 0 */
  y?: number;
  /** 차체 피치(rad, 앞이 높으면 +). 차체에 고정된 카메라(후방/전방)가 경사로에서 차체와 함께 기울도록 사용. 없으면 0 */
  pitch?: number;
}

/**
 * 차체에 "고정 장착"된 카메라(후방/전방)의 월드 자세. 차량 모델 root 와 똑같은 변환(YXZ: heading, -pitch)을 로컬 장착점/시선에 적용하므로
 * 차량 메시와 카메라의 상대 좌표는 속도·가속·경사와 무관하게 항상 같다.
 */
export function mountedCamera(pose: CarPose, m: { x: number; y: number; z: number; pitch: number }, dir: 1 | -1): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(pose.pitch ?? 0), pose.heading, 0, 'YXZ'));
  const origin = new THREE.Vector3(pose.x, pose.y ?? 0, pose.z);
  const pos = new THREE.Vector3(m.x, m.y, m.z).applyQuaternion(q).add(origin);
  const look = new THREE.Vector3(0, -Math.sin(m.pitch), dir * Math.cos(m.pitch)).applyQuaternion(q).add(pos);
  return { pos, look };
}

export class CameraRig {
  mode: CameraMode = 'chase';
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.12, 600);
  /** 후방 카메라 전용(보조 화면 + 후방 모드) */
  readonly rearCamera = new THREE.PerspectiveCamera(100, 16 / 9, 0.05, 300);
  /** 전방카메라(보조 화면 + 전방 모드) */
  readonly frontCamera = new THREE.PerspectiveCamera(100, 16 / 9, 0.05, 300);

  /** 주차 보조 디스플레이용 가상 카메라 (실제 3D 장면을 렌더링: 후방/전방 카메라, 좌·우 3D 측면뷰, 3D 탑뷰, 3D 사선뷰) */
  readonly assistCamera = new THREE.PerspectiveCamera(100, 16 / 9, 0.1, 300);
  /** 오른쪽 3D 서라운드뷰 전용 카메라 (차량 중심 위에 고정, 메인 보조 카메라와 독립) */
  readonly surroundCamera = new THREE.PerspectiveCamera(42, 0.8, 0.3, 200);
  private aPos = new THREE.Vector3();
  private aLook = new THREE.Vector3();
  private aUp = new THREE.Vector3(0, 1, 0);
  private aFov = 100;
  private aView: AssistView | null = null;

  private chaseDist = 7.5;
  private chaseHeight = 3.1;
  private topHeight = 26;
  private freeYaw = 0;
  private freePitch = 0.5;
  private freeDist = 12;
  private smoothPos = new THREE.Vector3();
  private smoothLook = new THREE.Vector3();
  private needSnap = true;
  /** 추적 카메라 가림 보정에 쓰는 충돌체 (맵 로드 시 설정) */
  colliders: readonly Collider[] = [];
  /** 다층: (x,z,y) 위쪽 천장 아랫면 높이 (없으면 Infinity). 추적 카메라가 천장을 뚫지 않게 한다 */
  ceilingFn: ((x: number, z: number, y: number) => number) | null = null;
  /** 마지막 추적 카메라 가림 보정 비율 (1 = 보정 없음) — 테스트/디버그용 */
  chaseFree = 1;
  /** 현재 선택된 추적 카메라 후보 (0 = 기본 뒤쪽 위치) */
  chaseCand = 0;
  private chaseBackT = 0;
  private drag: { id: number; x: number; y: number } | null = null;

  /** 시점별 목표 자세 (월드 좌표) */
  static assistTarget(view: AssistView, pose: CarPose, spec: VehicleSpec): { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number } {
    const f = forwardOf(pose.heading);
    const L = spec.length;
    const W = spec.width;
    const wp = (lx: number, y: number, lz: number): THREE.Vector3 => {
      const w = localToWorld(pose.x, pose.z, pose.heading, lx, lz);
      return new THREE.Vector3(w.x, y + (pose.y ?? 0), w.z);
    };
    const gy = pose.y ?? 0;
    const up = new THREE.Vector3(0, 1, 0);
    switch (view) {
      case 'rear': {
        const { pos, look } = mountedCamera(pose, spec.rearCam, -1);
        return { pos, look, up, fov: 100 };
      }
      case 'front': {
        const { pos, look } = mountedCamera(pose, spec.frontCam, 1);
        return { pos, look, up, fov: 100 };
      }
      case 'left':
      case 'right': {
        const sx = view === 'left' ? 1 : -1; // 로컬 +x = 왼쪽
        return { pos: wp(sx * (W / 2 + 2.3), 2.3, -L * 0.62), look: wp(sx * 0.1, 0.45, L * 0.12), up, fov: 64 };
      }
      case 'topFront':
      case 'topRear':
      case 'topZoom':
        return { pos: new THREE.Vector3(pose.x, gy + 7, pose.z), look: new THREE.Vector3(pose.x, gy, pose.z), up: new THREE.Vector3(f.x, 0, f.z), fov: 52 };
      case 'top':
        return { pos: new THREE.Vector3(pose.x, gy + 12.5, pose.z), look: new THREE.Vector3(pose.x, gy, pose.z), up: new THREE.Vector3(f.x, 0, f.z), fov: 52 };
      case 'oblique':
        return { pos: wp(0, 4.8, -(L * 0.5 + 4.4)), look: wp(0, 0.5, L * 0.3), up, fov: 58 };
    }
  }

  /** 시점 전환은 부드럽게 보간한다 (후방↔전방은 실제 카메라가 서로 반대편이라 컷 전환) */
  updateAssistCamera(dt: number, view: AssistView, pose: CarPose, spec: VehicleSpec, frame: { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; fov: number } | null = null): void {
    // frame: 실제 장애물 경계로 계산한 프레이밍(측면/탑/확대 탑). 없으면 차량 제원 기반 기본 자세
    const t = frame
      ? { pos: new THREE.Vector3(frame.pos.x, frame.pos.y, frame.pos.z), look: new THREE.Vector3(frame.look.x, frame.look.y, frame.look.z), up: new THREE.Vector3(frame.up.x, frame.up.y, frame.up.z), fov: frame.fov }
      : CameraRig.assistTarget(view, pose, spec);
    if (this.aView !== view) this.aT = 0;
    this.aT += dt;
    // 후방/전방 카메라는 차체에 고정된 장비다: 전환 직후(0.45초)를 제외하면 보간 없이 차체에 그대로 붙는다.
    // (예전에는 매 프레임 지수 보간해서 속도 v 에 비례(v/7 m)해 카메라가 차체보다 늦게 따라와 영상 속 범퍼/차체가 움직여 보였다)
    const rigid = !frame && (view === 'rear' || view === 'front') && this.aT >= 0.45;
    const cut = rigid || this.aView === null || (this.aView === 'rear' && view === 'front') || (this.aView === 'front' && view === 'rear');
    if (cut) {
      this.aPos.copy(t.pos);
      this.aLook.copy(t.look);
      this.aUp.copy(t.up);
      this.aFov = t.fov;
    } else if (frame && this.aT >= 0.7) {
      // 전환 완료: 구도 고정. 차량 기준 좌표로 저장된 구도이므로 보간 없이 그대로(= 차량만 정확히 따라감)
      this.aPos.copy(t.pos);
      this.aLook.copy(t.look);
      this.aUp.copy(t.up);
      this.aFov = t.fov;
    } else {
      // 시점 변경 직후 약 0.7초 동안만 부드럽게 이동
      const k = 1 - Math.exp(-(frame ? 6 : 7) * dt);
      this.aPos.lerp(t.pos, k);
      this.aLook.lerp(t.look, k);
      this.aUp.lerp(t.up, k).normalize();
      this.aFov += (t.fov - this.aFov) * k;
    }
    this.aView = view;
    const c = this.assistCamera;
    c.up.copy(this.aUp);
    c.position.copy(this.aPos);
    c.fov = this.aFov;
    c.lookAt(this.aLook);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  private aT = 99;
  /** 시점 전환/구도 재구성 직후의 짧은 전환 애니메이션을 시작한다 */
  beginTransition(): void {
    this.aT = 0;
  }
  /** 전환 애니메이션이 끝나 구도가 고정(차량만 추적)된 상태인가 */
  get assistSettled(): boolean {
    return this.aT >= 0.7;
  }

  /** 보간이 거의 끝났는가 (테스트/로그용) */
  get assistCurrentView(): AssistView | null {
    return this.aView;
  }

  setMode(m: CameraMode, pose?: CarPose): void {
    this.mode = m;
    this.needSnap = true;
    if (m === 'free' && pose) this.freeYaw = pose.heading + Math.PI;
  }

  /** 다음 카메라. 전방카메라가 없는 차량(hasFront=false)은 'front' 모드를 건너뛴다 */
  next(pose: CarPose, hasFront = true): CameraMode {
    let i = CAMERA_ORDER.indexOf(this.mode);
    let n: CameraMode;
    do {
      i = (i + 1) % CAMERA_ORDER.length;
      n = CAMERA_ORDER[i];
    } while (n === 'front' && !hasFront);
    this.setMode(n, pose);
    return this.mode;
  }

  snap(): void {
    this.needSnap = true;
  }

  private viewW = 16;
  private viewH = 9;
  /** HUD(하단 계기판)에 차가 가리지 않도록 장면을 위로 올리는 비율 */
  private static readonly SHIFT = 0.26;

  setAspect(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    const a = w / h;
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
    this.rearCamera.aspect = a;
    this.rearCamera.updateProjectionMatrix();
    this.frontCamera.aspect = a;
    this.frontCamera.updateProjectionMatrix();
  }

  /** 렌더에 사용할 카메라 (후방 모드는 후방 카메라) */
  get active(): THREE.PerspectiveCamera {
    return this.mode === 'rear' ? this.rearCamera : this.mode === 'front' ? this.frontCamera : this.camera;
  }

  bind(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'free' && this.mode !== 'top' && this.mode !== 'chase') return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.mode === 'free') {
        this.freeYaw -= dx * 0.008;
        this.freePitch = clamp(this.freePitch + dy * 0.006, 0.05, 1.45);
      }
    });
    const up = (e: PointerEvent): void => {
      if (this.drag && this.drag.id === e.pointerId) this.drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        const k = 1 + Math.sign(e.deltaY) * 0.1;
        if (this.mode === 'free') this.freeDist = clamp(this.freeDist * k, 3, 60);
        else if (this.mode === 'top') this.topHeight = clamp(this.topHeight * k, 10, 60);
        else if (this.mode === 'chase') {
          this.chaseDist = clamp(this.chaseDist * k, 4.5, 16);
          this.chaseHeight = clamp(this.chaseHeight * k, 1.8, 8);
        }
      },
      { passive: true },
    );
  }

  update(dt: number, pose: CarPose, spec: VehicleSpec): void {
    const f = forwardOf(pose.heading);
    const gy = pose.y ?? 0;
    // 후방 카메라는 항상 갱신 (보조 화면용)
    const rm = mountedCamera(pose, spec.rearCam, -1);
    this.rearCamera.position.copy(rm.pos);
    this.rearCamera.lookAt(rm.look);
    this.rearCamera.updateMatrixWorld();
    const fm = mountedCamera(pose, spec.frontCam, 1);
    this.frontCamera.position.copy(fm.pos);
    this.frontCamera.lookAt(fm.look);
    this.frontCamera.updateMatrixWorld();

    const cam = this.camera;
    cam.up.set(0, 1, 0);
    switch (this.mode) {
      case 'chase': {
        const d = this.chaseDist + (spec.length - 4.6) * 0.5;
        const ceil = this.ceilingFn ? this.ceilingFn(pose.x, pose.z, gy) : Infinity;
        const look = new THREE.Vector3(pose.x + f.x * 2.0, gy + 1.0, pose.z + f.z * 2.0);
        // 가림 보정: 기둥/벽/차량이 카메라와 차 사이에 있으면 (1) 좌우로 돌거나 높이를 올린 후보 위치 중 시야가 트인 곳을 고르고,
        // (2) 모두 막히면 차체 바로 뒤(차 길이/2+1.6m)까지만 당긴다. 직전에 고른 후보가 계속 트여 있으면 유지해 흔들리지 않는다.
        const probe = (yaw: number, hm: number, back = 1): { pos: THREE.Vector3; free: number } => {
          const dx = Math.sin(pose.heading + yaw);
          const dz = Math.cos(pose.heading + yaw);
          const pos = new THREE.Vector3(pose.x - dx * d * back, Math.min(gy + this.chaseHeight * hm, ceil - 0.25), pose.z - dz * d * back);
          return { pos, free: freeFraction({ x: pose.x, y: gy + 1.2, z: pose.z }, pos, this.colliders, 0.6, 0.05) };
        };
        // [좌우 회전(rad), 높이 배율, 뒤쪽 거리 배율] — 마지막은 차 바로 위쪽에서 내려다보는 최후 후보
        const CAND: [number, number, number][] = [[0, 1, 1], [0.5, 1, 1], [-0.5, 1, 1], [0, 1.7, 1], [0.8, 1.35, 1], [-0.8, 1.35, 1], [0, 2.3, 1], [0, 2.1, 0.3]];
        let pick = this.chaseCand;
        let pr = probe(CAND[pick][0], CAND[pick][1], CAND[pick][2]);
        if (pr.free < 0.99) {
          pick = -1;
          for (let i = 0; i < CAND.length; i++) {
            const q = probe(CAND[i][0], CAND[i][1], CAND[i][2]);
            if (q.free >= 0.99) {
              pick = i;
              pr = q;
              break;
            }
          }
          if (pick < 0) {
            pick = 0;
            pr = probe(0, 1);
          }
        } else if (pick !== 0) {
          // 원래 위치(0)가 다시 트였으면 복귀 (히스테리시스: 0.6초 이상 트여 있을 때)
          const base = probe(0, 1);
          this.chaseBackT = base.free >= 0.99 ? this.chaseBackT + dt : 0;
          if (this.chaseBackT > 0.6) {
            pick = 0;
            pr = base;
            this.chaseBackT = 0;
          }
        }
        this.chaseCand = pick;
        const minT = Math.min(1, (spec.length / 2 + 1.6) / d);
        const tgt = pr.free >= 0.99 ? 1 : Math.max(minT, pr.free);
        this.chaseFree += (tgt - this.chaseFree) * (this.needSnap ? 1 : 1 - Math.exp(-6 * dt));
        const desired = new THREE.Vector3(pose.x + (pr.pos.x - pose.x) * this.chaseFree, gy + 1.2 + (pr.pos.y - gy - 1.2) * (0.55 + 0.45 * this.chaseFree), pose.z + (pr.pos.z - pose.z) * this.chaseFree);
        if (this.needSnap) {
          this.smoothPos.copy(desired);
          this.smoothLook.copy(look);
        } else {
          const k = 1 - Math.exp(-7 * dt);
          this.smoothPos.lerp(desired, k);
          this.smoothLook.lerp(look, 1 - Math.exp(-10 * dt));
        }
        cam.fov = 62;
        cam.position.copy(this.smoothPos);
        cam.lookAt(this.smoothLook);
        break;
      }
      case 'driver': {
        const e = spec.driverEye;
        const p = localToWorld(pose.x, pose.z, pose.heading, e.x, e.z);
        cam.fov = 78;
        cam.position.set(p.x, gy + e.y, p.z);
        cam.lookAt(p.x + f.x * 10, gy + e.y - 0.5, p.z + f.z * 10);
        break;
      }
      case 'top': {
        cam.fov = 50;
        cam.position.set(pose.x, gy + this.topHeight, pose.z);
        cam.up.set(f.x, 0, f.z); // 차량 진행 방향이 화면 위쪽
        cam.lookAt(pose.x, gy, pose.z);
        break;
      }
      case 'rear':
      case 'front': {
        // 후방/전방 카메라: active 로 해당 카메라를 직접 사용
        break;
      }
      case 'free': {
        cam.fov = 60;
        const cp = Math.cos(this.freePitch);
        cam.position.set(
          pose.x + Math.sin(this.freeYaw) * cp * this.freeDist,
          Math.max(0.4, Math.sin(this.freePitch) * this.freeDist),
          pose.z + Math.cos(this.freeYaw) * cp * this.freeDist,
        );
        cam.lookAt(pose.x, 0.8, pose.z);
        break;
      }
    }
    if (this.mode === 'driver' || this.mode === 'rear' || this.mode === 'front') {
      cam.clearViewOffset();
    } else {
      const k = CameraRig.SHIFT;
      cam.setViewOffset(this.viewW, this.viewH * (1 + k), 0, this.viewH * k, this.viewW, this.viewH);
    }
    cam.updateProjectionMatrix();
    this.needSnap = false;
  }
}
