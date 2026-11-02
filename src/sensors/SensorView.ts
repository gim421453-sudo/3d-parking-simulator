import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import type { Collider } from '../core/geometry';
import { localToWorld, worldToLocal } from '../core/math';
import type { SensorGroup, VehicleSpec } from '../vehicle/spec';
import { LEVEL_COLORS, proximityLevel, type ProximityLevel, type SensorSnapshot } from './sensorSystem';

export type SensorViewSize = 'hidden' | 'small' | 'large';

export interface SensorViewPose {
  x: number;
  z: number;
  heading: number;
}

export interface SensorViewOptions {
  enabled: boolean;
  debug: boolean;
  range: number;
  critical: number;
  activeGroups: SensorGroup[];
  gear: string;
}

const GROUPS: SensorGroup[] = ['front', 'rear', 'left', 'right'];
const GROUP_NAME: Record<SensorGroup, string> = { front: '앞', rear: '뒤', left: '왼쪽', right: '오른쪽' };
const MAX_HITS = 256;
const MAX_SHAPES = 14;

/**
 * 차량을 중심으로 한 3D 주차 센서 화면.
 * - 차량 기준 좌표(앞=+z, 왼쪽=+x)로 그려서, 차가 회전해도 센서 방향이 차량과 함께 표시된다.
 * - 센서가 실제로 맞힌 지점(히트)만 점으로 찍고, 장애물 형상은 "측정된 범위"만 얇게 그린다.
 * - 색 부채꼴: 연한 부채꼴 = 센서 감지 가능 범위, 진한 부채꼴 = 측정 거리.
 */
export class SensorView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  private labels = new Map<SensorGroup, HTMLDivElement>();
  private info: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private debugEl: HTMLDivElement;
  private legendEl: HTMLDivElement;

  private carGroup = new THREE.Group();
  private fanCover: THREE.Mesh[] = [];
  private fanMeasure: THREE.Mesh[] = [];
  private fanEdge: THREE.Line[] = [];
  private dirArrows: THREE.Line[] = [];
  private hits: THREE.InstancedMesh;
  private rayLines: THREE.LineSegments;
  private shapeBoxes: THREE.Mesh[] = [];
  private shapeCyls: THREE.Mesh[] = [];
  private mountDots: THREE.Mesh[] = [];
  private spec: VehicleSpec | null = null;
  private disposables: { dispose(): void }[] = [];

  private yaw = Math.PI;
  private pitch = 1.0;
  private dist = 10;
  private size: SensorViewSize = 'small';
  private dragging = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private w = 0;
  private h = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'sensor-view small';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'sv-status';
    this.info = document.createElement('div');
    this.info.className = 'sv-info';
    this.debugEl = document.createElement('div');
    this.debugEl.className = 'sv-debug';
    this.legendEl = document.createElement('div');
    this.legendEl.className = 'sv-legend';
    this.el.append(this.statusEl, this.info, this.debugEl, this.legendEl);
    for (const g of GROUPS) {
      const d = document.createElement('div');
      d.className = 'sv-label';
      d.style.display = 'none';
      this.el.appendChild(d);
      this.labels.set(g, d);
    }
    parent.appendChild(this.el);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0b1622, 0.9);
    this.scene.add(this.carGroup);
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x223344, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(3, 8, -4);
    this.scene.add(dl);

    // 바닥 격자 (1m 간격)
    const grid = new THREE.GridHelper(16, 16, 0x2f4a66, 0x1b2c3e);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);
    this.disposables.push(grid.geometry, grid.material as THREE.Material);

    const hitGeo = new THREE.SphereGeometry(0.07, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.hits = new THREE.InstancedMesh(hitGeo, hitMat, MAX_HITS);
    this.hits.count = 0;
    this.hits.frustumCulled = false;
    this.hits.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HITS * 3), 3);
    this.scene.add(this.hits);
    this.disposables.push(hitGeo, hitMat);

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_HITS * 6), 3));
    rg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_HITS * 6), 3));
    rg.setDrawRange(0, 0);
    this.rayLines = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.rayLines.frustumCulled = false;
    this.rayLines.visible = false;
    this.scene.add(this.rayLines);
    this.disposables.push(rg, this.rayLines.material as THREE.Material);

    const shapeMat = new THREE.MeshStandardMaterial({ color: 0xffb04a, transparent: true, opacity: 0.55, roughness: 0.6 });
    const bg = new THREE.BoxGeometry(1, 1, 1);
    const cg = new THREE.CylinderGeometry(1, 1, 1, 18);
    this.disposables.push(shapeMat, bg, cg);
    for (let i = 0; i < MAX_SHAPES; i++) {
      const b = new THREE.Mesh(bg, shapeMat);
      b.visible = false;
      this.scene.add(b);
      this.shapeBoxes.push(b);
      const c = new THREE.Mesh(cg, shapeMat);
      c.visible = false;
      this.scene.add(c);
      this.shapeCyls.push(c);
    }

    this.bindPointer();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.el);
    this.setSize('small');
  }

  setSpec(spec: VehicleSpec): void {
    this.spec = spec;
    // 기존 차량 목업/부채꼴 제거 후 재생성
    for (const c of [...this.carGroup.children]) {
      this.carGroup.remove(c);
      disposeObject(c);
    }
    this.fanCover = [];
    this.fanMeasure = [];
    this.fanEdge = [];
    this.dirArrows = [];
    this.mountDots = [];

    const L = spec.length;
    const W = spec.width;
    const H = spec.height;
    const bodyMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.4, metalness: 0.3 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.38, L), bodyMat);
    body.position.y = 0.2 + (H * 0.38) / 2;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, H * 0.3, L * 0.5), new THREE.MeshStandardMaterial({ color: 0x1c2b3a, roughness: 0.2, metalness: 0.6 }));
    cabin.position.set(0, 0.2 + H * 0.38 + (H * 0.3) / 2, -L * 0.05);
    const wheelGeo = new THREE.CylinderGeometry(spec.wheelRadius, spec.wheelRadius, 0.22, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const rearZ = -L / 2 + spec.rearOverhang;
    for (const wz of [rearZ, rearZ + spec.wheelbase]) {
      for (const sx of [1, -1]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(sx * (W / 2 - 0.08), spec.wheelRadius, wz);
        this.carGroup.add(w);
      }
    }
    // 앞 방향 표시 (화살표)
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.12, L / 2 + 0.3);
    this.carGroup.add(body, cabin, arrow);
    this.disposables.push(bodyMat, wheelGeo, wheelMat);

    // 센서별 부채꼴
    const coverMat = new THREE.MeshBasicMaterial({ color: 0x3f6a96, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x6fa8dc, transparent: true, opacity: 0.55 });
    for (const m of spec.sensors) {
      const geo = fanGeometry(m.angle - m.fov / 2, m.angle + m.fov / 2);
      const cover = new THREE.Mesh(geo, coverMat);
      cover.position.set(m.x, 0.04, m.z);
      this.carGroup.add(cover);
      this.fanCover.push(cover);

      const measure = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      measure.position.set(m.x, 0.055, m.z);
      measure.visible = false;
      this.carGroup.add(measure);
      this.fanMeasure.push(measure);

      const edge = new THREE.Line(fanEdgeGeometry(m.angle - m.fov / 2, m.angle + m.fov / 2), edgeMat);
      edge.position.set(m.x, 0.06, m.z);
      this.carGroup.add(edge);
      this.fanEdge.push(edge);

      // 센서 방향 화살표 (디버그)
      const ag = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.sin(m.angle) * 0.7, 0, Math.cos(m.angle) * 0.7)]);
      const arr = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: 0xffffff }));
      arr.position.set(m.x, 0.3, m.z);
      arr.visible = false;
      this.carGroup.add(arr);
      this.dirArrows.push(arr);

      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.position.set(m.x, spec.sensorHeight, m.z);
      this.carGroup.add(dot);
      this.mountDots.push(dot);
    }
  }

  setSize(s: SensorViewSize): void {
    this.size = s;
    this.el.classList.toggle('hidden', s === 'hidden');
    this.el.classList.toggle('small', s === 'small');
    this.el.classList.toggle('large', s === 'large');
    this.dist = s === 'large' ? 9 : 10.5;
    requestAnimationFrame(() => this.resize());
  }
  getSize(): SensorViewSize {
    return this.size;
  }
  get visible(): boolean {
    return this.size !== 'hidden';
  }

  resetCamera(): void {
    this.yaw = Math.PI;
    this.pitch = 1.0;
    this.dist = this.size === 'large' ? 9 : 10.5;
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(2, Math.floor(r.width));
    const h = Math.max(2, Math.floor(r.height));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private bindPointer(): void {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      el.setPointerCapture(e.pointerId);
      this.dragging.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.dragging.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.dragging.size === 2) {
        const pts = [...this.dragging.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pinch > 0) this.dist = clampN(this.dist * (this.pinch / d), 4, 24);
        this.pinch = d;
        return;
      }
      this.yaw -= dx * 0.01;
      this.pitch = clampN(this.pitch + dy * 0.008, 0.25, 1.5);
    });
    const up = (e: PointerEvent): void => {
      this.dragging.delete(e.pointerId);
      this.pinch = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = clampN(this.dist * (1 + Math.sign(e.deltaY) * 0.1), 4, 24);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.resetCamera());
  }

  /** 센서 스냅샷으로 화면 갱신 + 렌더 */
  update(snap: SensorSnapshot | null, pose: SensorViewPose, colliders: Map<string, Collider>, o: SensorViewOptions): void {
    if (!this.visible || !this.spec) return;
    this.resize();
    const spec = this.spec;
    this.statusEl.textContent = !o.enabled ? '센서 OFF' : o.activeGroups.length ? `경고음 대상: ${o.activeGroups.map((g) => GROUP_NAME[g]).join('·')}` : `기어 ${o.gear} · 경고음 대기 (R 또는 저속 D에서 작동)`;
    this.statusEl.classList.toggle('off', !o.enabled);

    // 범례: 일반 화면에서는 거리 숫자 없이 단계 이름만, 디버그에서만 수치 표시
    const lvl = (d: number): string => `${d.toFixed(1)}m`;
    const span = o.range - o.critical;
    const C = (l: ProximityLevel): string => '#' + LEVEL_COLORS[l].toString(16).padStart(6, '0');
    this.legendEl.innerHTML =
      `<span class="chip" style="--c:${C('critical')}">매우 가까움${o.debug ? ' ≤' + lvl(o.critical) : ''}</span>` +
      `<span class="chip" style="--c:${C('near')}">가까움${o.debug ? ' ≤' + lvl(o.critical + span * 0.33) : ''}</span>` +
      `<span class="chip" style="--c:${C('mid')}">접근${o.debug ? ' ≤' + lvl(o.critical + span * 0.66) : ''}</span>` +
      `<span class="chip" style="--c:${C('far')}">감지${o.debug ? ' ≤' + lvl(o.range) : ''}</span>` +
      `<span class="note">연한 부채꼴 밖·낮은 연석·높은 천장 물체는 미감지 영역</span>`;

    // 부채꼴/히트 갱신
    const hitList: { x: number; z: number; c: THREE.Color }[] = [];
    const rayPos = this.rayLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rayCol = this.rayLines.geometry.getAttribute('color') as THREE.BufferAttribute;
    let rayN = 0;
    this.rayLines.visible = o.debug && !!snap;
    this.debugEl.style.display = o.debug ? 'block' : 'none';
    let dbg = '';

    spec.sensors.forEach((m, i) => {
      const cover = this.fanCover[i];
      const measure = this.fanMeasure[i];
      cover.scale.set(o.range, 1, o.range);
      this.fanEdge[i].scale.set(o.range, 1, o.range);
      (cover.material as THREE.MeshBasicMaterial).color.setHex(o.enabled ? 0x3f6a96 : 0x444444);
      this.dirArrows[i].visible = o.debug;
      const r = snap?.readings[i];
      if (!snap || !r || !o.enabled || r.distance === null) {
        measure.visible = false;
      } else {
        const level = proximityLevel(r.distance, o.range, o.critical);
        measure.visible = true;
        measure.scale.set(r.distance, 1, r.distance);
        (measure.material as THREE.MeshBasicMaterial).color.setHex(LEVEL_COLORS[level]);
      }
      if (snap && r && o.enabled) {
        for (const h of r.hits) {
          if (hitList.length >= MAX_HITS) break;
          const lp = worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z);
          hitList.push({ x: lp.x, z: lp.z, c: new THREE.Color(LEVEL_COLORS[proximityLevel(h.distance, o.range, o.critical)]) });
        }
        if (o.debug) {
          for (const ray of r.rays) {
            if (rayN >= MAX_HITS) break;
            const a = worldToLocal(pose.x, pose.z, pose.heading, ray.ox, ray.oz);
            const b = worldToLocal(pose.x, pose.z, pose.heading, ray.ox + ray.dx * ray.length, ray.oz + ray.dz * ray.length);
            rayPos.setXYZ(rayN * 2, a.x, spec.sensorHeight, a.z);
            rayPos.setXYZ(rayN * 2 + 1, b.x, spec.sensorHeight, b.z);
            const col = ray.hit ? [1, 0.35, 0.2] : [0.3, 0.8, 1];
            rayCol.setXYZ(rayN * 2, col[0], col[1], col[2]);
            rayCol.setXYZ(rayN * 2 + 1, col[0], col[1], col[2]);
            rayN++;
          }
          dbg += `${m.id.padEnd(8)} ${((m.angle * 180) / Math.PI).toFixed(0).padStart(4)}° ${r.distance === null ? '  ----' : r.distance.toFixed(3).padStart(6) + 'm'} ${r.nearest?.colliderId ?? ''}\n`;
        }
      }
    });
    rayPos.needsUpdate = true;
    rayCol.needsUpdate = true;
    this.rayLines.geometry.setDrawRange(0, rayN * 2);
    this.debugEl.textContent = dbg;

    // 히트 점
    const dummy = new THREE.Object3D();
    hitList.forEach((h, i) => {
      dummy.position.set(h.x, spec.sensorHeight, h.z);
      dummy.updateMatrix();
      this.hits.setMatrixAt(i, dummy.matrix);
      this.hits.setColorAt(i, h.c);
    });
    this.hits.count = hitList.length;
    this.hits.instanceMatrix.needsUpdate = true;
    if (this.hits.instanceColor) this.hits.instanceColor.needsUpdate = true;

    // 장애물 형상: 맞힌 지점들의 "측정된 범위"만 박스로 표시한다 (미측정 부분은 확정하지 않음)
    for (const b of this.shapeBoxes) b.visible = false;
    for (const c of this.shapeCyls) c.visible = false;
    if (snap && o.enabled) {
      const byCollider = new Map<string, { x: number; z: number }[]>();
      for (const r of snap.readings) for (const h of r.hits) {
        const arr = byCollider.get(h.colliderId);
        if (arr) arr.push(h);
        else byCollider.set(h.colliderId, [h]);
      }
      let bi = 0;
      for (const [id, pts] of byCollider) {
        const col = colliders.get(id);
        if (!col || bi >= MAX_SHAPES) continue;
        const rot = col.kind === 'box' ? col.rot : 0;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of pts) {
          const l = worldToLocal(col.x, col.z, rot, p.x, p.z);
          minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x);
          minZ = Math.min(minZ, l.z); maxZ = Math.max(maxZ, l.z);
        }
        const pad = 0.05; // 측정 지점 자체의 두께만 허용 (그 이상 확장하지 않음)
        const w = maxX - minX + pad * 2;
        const d = maxZ - minZ + pad * 2;
        const cw = localToWorld(col.x, col.z, rot, (minX + maxX) / 2, (minZ + maxZ) / 2);
        const cl = worldToLocal(pose.x, pose.z, pose.heading, cw.x, cw.z);
        const y0 = Math.max(0, col.y0);
        const hgt = Math.max(0.05, col.h);
        const mesh = this.shapeBoxes[bi++];
        mesh.visible = true;
        mesh.scale.set(w, hgt, d);
        mesh.position.set(cl.x, y0 + hgt / 2, cl.z);
        mesh.rotation.y = rot - pose.heading;
      }
    }

    // 그룹별 라벨(가장 가까운 장애물까지의 실제 거리)
    this.camera.position.set(
      Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      Math.sin(this.pitch) * this.dist,
      Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    const v = new THREE.Vector3();
    const summary: string[] = [];
    for (const g of GROUPS) {
      const label = this.labels.get(g)!;
      const d = snap && o.enabled ? snap.groupMin[g] : null;
      if (o.debug) summary.push(`${GROUP_NAME[g]} ${d === null ? '--' : d.toFixed(2) + 'm'}`);
      if (d === null || !snap) {
        label.style.display = 'none';
        continue;
      }
      let best: { x: number; z: number; d: number } | null = null;
      for (const r of snap.readings) {
        if (r.group !== g || !r.nearest) continue;
        if (!best || r.nearest.distance < best.d) best = { x: r.nearest.x, z: r.nearest.z, d: r.nearest.distance };
      }
      if (!best) {
        label.style.display = 'none';
        continue;
      }
      const lp = worldToLocal(pose.x, pose.z, pose.heading, best.x, best.z);
      v.set(lp.x, spec.sensorHeight + 0.35, lp.z).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * this.w;
      const sy = (-v.y * 0.5 + 0.5) * this.h;
      label.style.display = o.debug ? 'block' : 'none';
      label.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%,-100%)`;
      label.textContent = o.debug ? `${best.d.toFixed(2)}m` : ''; // 일반 화면에는 거리 숫자를 넣지 않는다
      const lv: ProximityLevel = proximityLevel(best.d, o.range, o.critical);
      label.style.setProperty('--c', '#' + LEVEL_COLORS[lv].toString(16).padStart(6, '0'));
    }
    this.info.textContent = o.debug ? summary.join(' · ') : '';
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    this.el.remove();
  }
}

const clampN = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** 반지름 1인 부채꼴 (XZ 평면, 각도는 앞(+z)에서 왼쪽(+x)으로) */
function fanGeometry(a0: number, a1: number): THREE.BufferGeometry {
  const seg = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 24)));
  const pos: number[] = [0, 0, 0];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pos.push(Math.sin(a), 0, Math.cos(a));
  }
  const idx: number[] = [];
  for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function fanEdgeGeometry(a0: number, a1: number): THREE.BufferGeometry {
  const seg = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 24)));
  const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pts.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
  }
  pts.push(new THREE.Vector3(0, 0, 0));
  return new THREE.BufferGeometry().setFromPoints(pts);
}
