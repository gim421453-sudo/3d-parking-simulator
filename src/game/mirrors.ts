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

  textures(): Record<'left' | 'right' | 'room', THREE.Texture> {
    return { left: this.rts.left.texture, right: this.rts.right.texture, room: this.rts.room.texture };
  }

  dispose(): void {
    for (const rt of Object.values(this.rts)) rt.dispose();
  }
}

/**
 * 3인칭 미러 오버레이: MirrorSystem 이 실제 3D 장면을 렌더한 텍스처(좌/룸/우)를 화면 하단 중앙(계기판 바로 위)에 작게 그린다.
 * 가짜 이미지가 아니라 같은 렌더 타깃이며, OFF 이면 호출하지 않으므로 거울 렌더도 일어나지 않는다.
 */
export class MirrorOverlay {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private planes: Record<'left' | 'right' | 'room', THREE.Mesh>;
  private mats: THREE.MeshBasicMaterial[] = [];
  /** 마지막으로 그린 영역(CSS px, 좌하단 기준) — 테스트/디버그 */
  lastRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
  draws = 0;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0.5, 0.5, 0);
    const mk = (): THREE.Mesh => {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false });
      this.mats.push(m);
      const mesh = new THREE.Mesh(geo, m);
      this.scene.add(mesh);
      return mesh;
    };
    this.planes = { left: mk(), room: mk(), right: mk() };
  }

  /** 레이아웃 계산(순수): 화면 폭에 맞춘 좌/룸/우 미러 영역 */
  static layout(w: number, h: number): Record<'left' | 'room' | 'right', { x: number; y: number; w: number; h: number }> {
    const strip = Math.max(260, Math.min(620, w * 0.46, h * 1.1));
    const side = strip * 0.31;
    const room = strip * 0.34;
    const gap = strip * 0.02;
    const total = side * 2 + room + gap * 2;
    const x0 = (w - total) / 2;
    const y = 104; // 하단 계기판(#cluster) 바로 위
    const sh = side / 2;
    const rh = room / (320 / 96);
    return {
      left: { x: x0, y, w: side, h: sh },
      room: { x: x0 + side + gap, y, w: room, h: rh },
      right: { x: x0 + side + gap + room + gap, y, w: side, h: sh },
    };
  }

  draw(renderer: THREE.WebGLRenderer, tex: Record<'left' | 'right' | 'room', THREE.Texture>, w: number, h: number): void {
    const lay = MirrorOverlay.layout(w, h);
    const prevAuto = renderer.autoClear;
    const prevScissor = renderer.getScissorTest();
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    for (const k of ['left', 'room', 'right'] as const) {
      const r = lay[k];
      (this.planes[k].material as THREE.MeshBasicMaterial).map = tex[k];
      (this.planes[k].material as THREE.MeshBasicMaterial).needsUpdate = true;
      for (const o of Object.keys(this.planes) as ('left' | 'room' | 'right')[]) this.planes[o].visible = o === k;
      renderer.setViewport(r.x, r.y, r.w, r.h);
      renderer.setScissor(r.x, r.y, r.w, r.h);
      renderer.clearDepth();
      renderer.render(this.scene, this.cam);
      this.lastRects[k] = r;
    }
    this.draws++;
    renderer.setScissorTest(prevScissor);
    renderer.setViewport(0, 0, w, h);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.planes.left.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}
