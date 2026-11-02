import * as THREE from 'three';
import type { CarModel } from '../vehicle/carModel';
import type { VehicleSpec } from '../vehicle/spec';
import { localToWorld } from '../core/math';

/**
 * 사이드미러 2개 + 룸미러: 실제 3D 장면을 후방 가상 카메라로 렌더링해 거울면에 붙인다.
 * 부하 관리: 1인칭에서만, 설정 FPS 로만, 작은 해상도(배율 조절 가능)로 렌더링한다.
 */
export class MirrorSystem {
  private rts: Record<'left' | 'right' | 'room', THREE.WebGLRenderTarget>;
  private cams: Record<'left' | 'right' | 'room', THREE.PerspectiveCamera>;
  private acc = 0;
  private bound: CarModel | null = null;
  renders = 0;

  constructor() {
    const mk = (w: number, h: number): THREE.WebGLRenderTarget => {
      const rt = new THREE.WebGLRenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
      rt.texture.wrapS = THREE.RepeatWrapping;
      rt.texture.repeat.x = -1; // 거울상
      rt.texture.offset.x = 1;
      return rt;
    };
    this.rts = { left: mk(256, 128), right: mk(256, 128), room: mk(320, 96) };
    this.cams = {
      left: new THREE.PerspectiveCamera(42, 2, 0.1, 160),
      right: new THREE.PerspectiveCamera(42, 2, 0.1, 160),
      room: new THREE.PerspectiveCamera(38, 320 / 96, 0.1, 160),
    };
  }

  bind(model: CarModel | null): void {
    if (this.bound === model) return;
    this.bound = model;
    if (!model?.mirrors) return;
    for (const k of ['left', 'right', 'room'] as const) {
      const mat = model.mirrors[k].material as THREE.MeshBasicMaterial;
      mat.map = this.rts[k].texture;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    }
  }

  private aim(cam: THREE.PerspectiveCamera, pose: { x: number; z: number; heading: number; y?: number }, lx: number, ly: number, lz: number, yaw: number): void {
    const p = localToWorld(pose.x, pose.z, pose.heading, lx, lz);
    const gy = pose.y ?? 0; // 다층 맵: 차량 지면 높이
    ly += gy;
    cam.position.set(p.x, ly, p.z);
    // 차량 뒤쪽(-z)을 향하고, yaw 만큼 바깥쪽으로 틀어 사각지대를 보여 준다 (좌측 +x)
    const d = localToWorld(0, 0, pose.heading, Math.sin(yaw), -Math.cos(yaw));
    cam.lookAt(p.x + d.x * 10, ly - 0.2, p.z + d.z * 10);
    cam.updateMatrixWorld();
  }

  /** 설정 FPS 에 맞춰 3개 거울을 다시 렌더링한다. 렌더한 경우 true. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, model: CarModel, pose: { x: number; z: number; heading: number; y?: number }, spec: VehicleSpec, dt: number, fps: number): boolean {
    if (fps <= 0 || !model.mirrors) return false;
    this.bind(model);
    this.acc += dt;
    if (this.acc < 1 / fps) return false;
    this.acc = 0;
    const hw = spec.width / 2;
    const belt = spec.height * 0.58;
    const zf = spec.length / 2 - 1.0;
    this.aim(this.cams.left, pose, hw + 0.12, belt + 0.12, zf, 0.2);
    this.aim(this.cams.right, pose, -(hw + 0.12), belt + 0.12, zf, -0.2);
    this.aim(this.cams.room, pose, 0.1, spec.height - 0.15, spec.length * 0.1, 0);
    const prevBody = model.bodyGroup.visible;
    const prevCockpit = model.cockpit.visible;
    // 거울에 비치는 장면에서는 실내(대시보드/화면)는 숨기고 외부 차체는 보이게 한다
    model.cockpit.visible = false;
    model.bodyGroup.visible = true;
    const prevRT = renderer.getRenderTarget();
    const prevScissor = renderer.getScissorTest();
    renderer.setScissorTest(false);
    for (const k of ['left', 'right', 'room'] as const) {
      renderer.setRenderTarget(this.rts[k]);
      renderer.render(scene, this.cams[k]);
    }
    renderer.setRenderTarget(prevRT);
    renderer.setScissorTest(prevScissor);
    model.bodyGroup.visible = prevBody;
    model.cockpit.visible = prevCockpit;
    this.renders++;
    return true;
  }

  dispose(): void {
    for (const rt of Object.values(this.rts)) rt.dispose();
  }
}
