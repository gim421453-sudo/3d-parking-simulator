import * as THREE from 'three';

export interface Px {
  x: number;
  y: number;
}

const _a = new THREE.Vector4();
const _b = new THREE.Vector4();

/** Liang–Barsky: 선분을 직사각형 [0,w]×[0,h] (여유 pad)에 클리핑 */
export function clipToRect(a: Px, b: Px, w: number, h: number, pad = 0): [Px, Px] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x + pad, w + pad - a.x, a.y + pad, h + pad - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

/**
 * 월드 선분을 카메라로 투영한다 (동차좌표 근평면 클리핑 → 화면 사각형 클리핑).
 * 카메라 뒤(근평면 앞)로 넘어간 부분은 잘라내며, 화면 밖 선분은 null.
 * camera.matrixWorldInverse / projectionMatrix 가 최신이어야 한다.
 */
export function projectSegment(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, w: number, h: number, mirror = false): [Px, Px] | null {
  const vm = camera.matrixWorldInverse;
  const pm = camera.projectionMatrix;
  _a.set(a.x, a.y, a.z, 1).applyMatrix4(vm);
  _b.set(b.x, b.y, b.z, 1).applyMatrix4(vm);
  // 카메라 공간: 앞쪽 = -z. 근평면: z = -near
  const zn = -camera.near * 1.0001;
  const ain = _a.z < zn;
  const bin = _b.z < zn;
  if (!ain && !bin) return null;
  let ax = _a.x, ay = _a.y, az = _a.z;
  let bx = _b.x, by = _b.y, bz = _b.z;
  if (!ain) {
    const t = (zn - az) / (bz - az);
    ax = ax + (bx - ax) * t;
    ay = ay + (by - ay) * t;
    az = zn;
  } else if (!bin) {
    const t = (zn - bz) / (az - bz);
    bx = bx + (ax - bx) * t;
    by = by + (ay - by) * t;
    bz = zn;
  }
  const pj = (x: number, y: number, z: number): Px => {
    _a.set(x, y, z, 1).applyMatrix4(pm);
    const nx = _a.x / _a.w;
    const ny = _a.y / _a.w;
    return { x: ((mirror ? -nx : nx) * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h };
  };
  return clipToRect(pj(ax, ay, az), pj(bx, by, bz), w, h);
}

/** 한 점이 근평면 앞(카메라 앞쪽)에 있는가 */
export function inFront(p: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera): boolean {
  _a.set(p.x, p.y, p.z, 1).applyMatrix4(camera.matrixWorldInverse);
  return _a.z < -camera.near;
}

/**
 * 월드 3D 다각형(예: 지면에 수직으로 세운 경고 패널)을 근평면에서 클리핑(Sutherland–Hodgman)한 뒤 화면 좌표로 투영한다.
 * 모든 꼭짓점이 카메라 뒤면 null. 화면 밖 부분은 호출 쪽의 canvas clip 으로 잘린다.
 */
export function projectPolygon(points: { x: number; y: number; z: number }[], camera: THREE.PerspectiveCamera, w: number, h: number, mirror = false): Px[] | null {
  const vm = camera.matrixWorldInverse;
  const pm = camera.projectionMatrix;
  const zn = -camera.near * 1.0001;
  const cam = points.map((p) => {
    _a.set(p.x, p.y, p.z, 1).applyMatrix4(vm);
    return { x: _a.x, y: _a.y, z: _a.z };
  });
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < cam.length; i++) {
    const a = cam[i];
    const b = cam[(i + 1) % cam.length];
    const ain = a.z < zn;
    const bin = b.z < zn;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (zn - a.z) / (b.z - a.z);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: zn });
    }
  }
  if (out.length < 3) return null;
  return out.map((q) => {
    _a.set(q.x, q.y, q.z, 1).applyMatrix4(pm);
    const nx = _a.x / _a.w;
    const ny = _a.y / _a.w;
    return { x: ((mirror ? -nx : nx) * 0.5 + 0.5) * w, y: (-ny * 0.5 + 0.5) * h };
  });
}
