import * as THREE from 'three';
import { clamp, forwardOf, localToWorld } from '../core/math';
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
}

export class CameraRig {
  mode: CameraMode = 'chase';
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.12, 600);
  /** 후방 카메라 전용(보조 화면 + 후방 모드) */
  readonly rearCamera = new THREE.PerspectiveCamera(100, 16 / 9, 0.1, 300);
  /** 전방카메라(보조 화면 + 전방 모드) */
  readonly frontCamera = new THREE.PerspectiveCamera(100, 16 / 9, 0.1, 300);

  private chaseDist = 7.5;
  private chaseHeight = 3.1;
  private topHeight = 26;
  private freeYaw = 0;
  private freePitch = 0.5;
  private freeDist = 12;
  private smoothPos = new THREE.Vector3();
  private smoothLook = new THREE.Vector3();
  private needSnap = true;
  private drag: { id: number; x: number; y: number } | null = null;

  setMode(m: CameraMode, pose?: CarPose): void {
    this.mode = m;
    this.needSnap = true;
    if (m === 'free' && pose) this.freeYaw = pose.heading + Math.PI;
  }

  next(pose: CarPose): CameraMode {
    const i = CAMERA_ORDER.indexOf(this.mode);
    this.setMode(CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length], pose);
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
    // 후방 카메라는 항상 갱신 (보조 화면용)
    const rc = spec.rearCam;
    const rp = localToWorld(pose.x, pose.z, pose.heading, rc.x, rc.z);
    this.rearCamera.position.set(rp.x, rc.y, rp.z);
    this.rearCamera.lookAt(rp.x - f.x * Math.cos(rc.pitch), rc.y - Math.sin(rc.pitch), rp.z - f.z * Math.cos(rc.pitch));
    this.rearCamera.updateMatrixWorld();
    const fc = spec.frontCam;
    const fp = localToWorld(pose.x, pose.z, pose.heading, fc.x, fc.z);
    this.frontCamera.position.set(fp.x, fc.y, fp.z);
    this.frontCamera.lookAt(fp.x + f.x * Math.cos(fc.pitch), fc.y - Math.sin(fc.pitch), fp.z + f.z * Math.cos(fc.pitch));
    this.frontCamera.updateMatrixWorld();

    const cam = this.camera;
    cam.up.set(0, 1, 0);
    switch (this.mode) {
      case 'chase': {
        const d = this.chaseDist + (spec.length - 4.6) * 0.5;
        const desired = new THREE.Vector3(pose.x - f.x * d, this.chaseHeight, pose.z - f.z * d);
        const look = new THREE.Vector3(pose.x + f.x * 2.0, 1.0, pose.z + f.z * 2.0);
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
        cam.position.set(p.x, e.y, p.z);
        cam.lookAt(p.x + f.x * 10, e.y - 0.5, p.z + f.z * 10);
        break;
      }
      case 'top': {
        cam.fov = 50;
        cam.position.set(pose.x, this.topHeight, pose.z);
        cam.up.set(f.x, 0, f.z); // 차량 진행 방향이 화면 위쪽
        cam.lookAt(pose.x, 0, pose.z);
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
