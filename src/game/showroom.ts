import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { applyGlbVisual, createCarModel, type CarModel } from '../vehicle/carModel';
import type { VehicleSpec } from '../vehicle/spec';

/**
 * 메뉴 뒤에 보이는 차량 쇼룸. 실제 게임과 같은 차량 모델을 천천히 회전시켜 "차량 미리보기"로 쓴다.
 * 게임 장면과 별개의 Scene 이라 게임 상태에 영향을 주지 않는다.
 */
export class Showroom {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
  private model: CarModel | null = null;
  private t = 0;
  private blob: THREE.CanvasTexture;
  private w = 16;
  private h = 9;
  private spec: VehicleSpec | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.scene.background = new THREE.Color(0x06080c);
    const pm = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();

    this.scene.add(new THREE.HemisphereLight(0xa9bdd8, 0x0b0f15, 0.5));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
    key.position.set(-5, 6, 6);
    const rim = new THREE.DirectionalLight(0x6f9bff, 2.2);
    rim.position.set(6, 3, -6);
    this.scene.add(key, rim);

    // 스포트라이트 풀 + 얇은 링 (바닥)
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(128, 128, 6, 128, 128, 128);
    grd.addColorStop(0, 'rgba(70,92,125,0.55)');
    grd.addColorStop(0.55, 'rgba(30,42,60,0.28)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const floorTex = new THREE.CanvasTexture(c);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.005;
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 3.43, 96), new THREE.MeshBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);

    const bc = document.createElement('canvas');
    bc.width = bc.height = 64;
    const bg = bc.getContext('2d')!;
    const bgr = bg.createRadialGradient(32, 32, 2, 32, 32, 32);
    bgr.addColorStop(0, 'rgba(0,0,0,0.7)');
    bgr.addColorStop(1, 'rgba(0,0,0,0)');
    bg.fillStyle = bgr;
    bg.fillRect(0, 0, 64, 64);
    this.blob = new THREE.CanvasTexture(bc);
    this.camera.position.set(6.7, 2.0, 7.6);
    this.camera.lookAt(0, 0.7, 0);
  }

  setVehicle(spec: VehicleSpec): void {
    if (this.spec?.id === spec.id && this.model) return;
    this.spec = spec;
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.model = createCarModel(spec, { blobTexture: this.blob });
    this.model.root.rotation.y = 0.6 + this.t * 0.3;
    this.scene.add(this.model.root);
    // 조명은 켠 상태로 보여 준다 (GLB 차량은 로드가 끝난 뒤에도 같은 상태를 다시 적용)
    const model = this.model;
    const apply = (): void =>
      model.setState({
        steer: 0,
        roll: 0,
        lighting: { effective: 'position', drl: 1, tail: 1, low: false, high: false },
        levelPitch: 0,
        brake: false,
        reverse: false,
        signalLeft: false,
        signalRight: false,
      });
    apply();
    if (spec.visual.kind === 'glb') void applyGlbVisual(model, spec).then((ok) => ok && apply());
  }

  setAspect(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    // 좌측 메뉴 패널 뒤로 가려지지 않도록 차량을 화면 오른쪽으로 치우친다 (좁은 화면에서는 덜 치우침)
    const shift = w > 900 ? 0.17 : w > 600 ? 0.14 : 0.06;
    this.camera.setViewOffset(w, h, -w * shift, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    this.t += dt;
    if (this.model) this.model.root.rotation.y += dt * 0.32;
    void this.w;
    void this.h;
  }
}
