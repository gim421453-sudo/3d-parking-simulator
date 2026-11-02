import type { Collider } from '../core/geometry';
import { localToWorld, worldToLocal } from '../core/math';
import type { VehicleSpec } from '../vehicle/spec';
import { pointInsideSolid, segmentBlocked, tooCloseToSolid, type CarBody, type Pt3 } from './visibility';

export interface FramePose {
  x: number;
  z: number;
  heading: number;
  /** 차체 중심의 지면 높이 (다층). 모든 카메라 높이는 이 값에 더해진다 */
  y?: number;
}
export interface FrameResult {
  pos: Pt3;
  look: Pt3;
  up: { x: number; y: number; z: number };
  fov: number;
  /** 시야 가림 검사를 통과했는가 (false 면 정책이 탑뷰로 넘겨야 함) */
  visible: boolean;
}
export interface FrameInput {
  view: 'left' | 'right' | 'top' | 'topZoom' | 'topFront' | 'topRear';
  pose: FramePose; // 차체 중심
  spec: VehicleSpec;
  /** 센서가 실제로 맞춘 히트점 (월드). 비어 있으면 차량만 프레이밍 */
  hits: { x: number; z: number }[];
  colliders: readonly Collider[];
  aspect: number;
  /** topZoom 의 초점 방향 */
  focusSide?: 'left' | 'right' | null;
}

const toWorld = (pose: FramePose, lx: number, y: number, lz: number): Pt3 => {
  const w = localToWorld(pose.x, pose.z, pose.heading, lx, lz);
  return { x: w.x, y: y + (pose.y ?? 0), z: w.z };
};
const carBody = (pose: FramePose, spec: VehicleSpec): CarBody => ({ x: pose.x, z: pose.z, rot: pose.heading, hw: spec.width / 2, hl: spec.length / 2, height: spec.height, base: pose.y ?? 0 });
const forwardUp = (pose: FramePose): { x: number; y: number; z: number } => ({ x: Math.sin(pose.heading), y: 0, z: Math.cos(pose.heading) });
const clampN = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const TOP_FOV = 52;

/** 차량 + 장애물 경계 좌표로 탑뷰 프레이밍 (고정 높이/중심 없음) */
function frameTop(inp: FrameInput, pts: { x: number; z: number }[], margin: number, minH: number, maxH: number): FrameResult {
  const { pose, spec, aspect } = inp;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    const l = worldToLocal(pose.x, pose.z, pose.heading, p.x, p.z);
    minX = Math.min(minX, l.x);
    maxX = Math.max(maxX, l.x);
    minZ = Math.min(minZ, l.z);
    maxZ = Math.max(maxZ, l.z);
  }
  minX -= margin;
  maxX += margin;
  minZ -= margin;
  maxZ += margin;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const t = Math.tan((TOP_FOV * Math.PI) / 360);
  const need = Math.max((maxZ - minZ) / 2 / t, (maxX - minX) / 2 / (t * Math.max(0.5, aspect)));
  const h = clampN(need * 1.04, minH, maxH);
  void spec;
  return { pos: toWorld(pose, cx, h, cz), look: toWorld(pose, cx, 0, cz), up: forwardUp(pose), fov: TOP_FOV, visible: true };
}

const carCorners = (pose: FramePose, spec: VehicleSpec, zMin = -Infinity, zMax = Infinity): { x: number; z: number }[] => {
  const hw = spec.width / 2;
  const hl = spec.length / 2;
  const z0 = Math.max(-hl, zMin);
  const z1 = Math.min(hl, zMax);
  return [
    [hw, z1],
    [-hw, z1],
    [-hw, z0],
    [hw, z0],
  ].map(([x, z]) => localToWorld(pose.x, pose.z, pose.heading, x, z));
};

/**
 * 주차 보조 3D 시점 프레이밍.
 * - left/right: 차체 측면과 장애물 표면 사이의 "남은 공간"이 한 화면에 보이는 위치/높이/FOV 를 탐색하고,
 *   시야 가림(차체/장애물)이 있으면 visible=false 를 반환한다.
 * - top: 차량과 모든 장애물 경계가 들어오는 전체 탑뷰.
 * - topZoom: 위험 방향에 초점을 맞춘 확대 탑뷰 (최소 높이로 상대 위치 파악이 가능하게 제한).
 */
export function frameView(inp: FrameInput): FrameResult {
  const { pose, spec, hits, colliders } = inp;
  const near = hits.filter((h) => Math.hypot(h.x - pose.x, h.z - pose.z) < spec.length / 2 + 6);
  if (inp.view === 'top') {
    return frameTop(inp, [...carCorners(pose, spec), ...near], 1.0, 8, 22);
  }
  const W = spec.width;
  const L = spec.length;
  if (inp.view === 'topFront' || inp.view === 'topRear') {
    // 진행 방향 집중 탑뷰: 차량 앞(뒤) 40% + 그 방향의 장애물 경계. 위쪽은 항상 차량 진행 방향.
    const front = inp.view === 'topFront';
    const hl = L / 2;
    const sel = near.filter((h) => {
      const l = worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z);
      return front ? l.z > hl - 0.3 : l.z < -hl + 0.3;
    });
    // 자기 차량의 해당 범퍼/차체 일부는 반드시 화면에 포함한다(최우선). 장애물은 가까운 것부터 추가하되,
    // 높이 상한(12m, 일반 전체 탑뷰와 구분되는 집중 시점 유지) 안에 들어오는 만큼만 포함한다.
    const base = front ? carCorners(pose, spec, hl - L * 0.4, hl) : carCorners(pose, spec, -hl, -hl + L * 0.4);
    const byDist = sel
      .map((h) => ({ h, d: Math.abs(worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z).z) }))
      .sort((a, b) => a.d - b.d)
      .map((q) => q.h);
    const pts = [...base];
    for (const h of byDist) {
      const test = frameTop(inp, [...pts, h], 0.9, 5.0, 1e9);
      if (test.pos.y - (pose.y ?? 0) <= 12) pts.push(h);
      else break;
    }
    return frameTop(inp, pts, 0.9, 5.0, 12);
  }
  if (inp.view === 'topZoom') {
    const side = inp.focusSide ?? null;
    const loc = near.map((h) => ({ h, l: worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z) }));
    const sel = side ? loc.filter((q) => (side === 'left' ? q.l.x > 0 : q.l.x < 0)) : loc;
    const zc = sel.length ? sel.reduce((a, q) => a + q.l.z, 0) / sel.length : 0;
    const pts = [...carCorners(pose, spec, zc - L * 0.32, zc + L * 0.32), ...sel.map((q) => q.h)];
    return frameTop(inp, pts, 0.9, 5.2, 13);
  }
  // ---- 측면 3D ----
  const s = inp.view === 'left' ? 1 : -1;
  const loc = near
    .map((h) => ({ h, l: worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z) }))
    .filter((q) => s * q.l.x > W / 2 - 0.05);
  const body = carBody(pose, spec);
  if (!loc.length) {
    // 감지 없음(해제 대기 중): 기본 위치 (차체 측면 전체)
    return {
      pos: toWorld(pose, s * (W / 2 + 2.3), 2.6, -L * 0.45),
      look: toWorld(pose, s * 0.1, 0.45, L * 0.12),
      up: { x: 0, y: 1, z: 0 },
      fov: 64,
      visible: true,
    };
  }
  loc.sort((a, b) => s * a.l.x - s * b.l.x);
  const gapMin = Math.max(0.05, s * loc[0].l.x - W / 2);
  const closest = loc.filter((q) => s * q.l.x - W / 2 <= gapMin + 0.6);
  const zc = closest.reduce((a, q) => a + q.l.z, 0) / closest.length;
  const target = toWorld(pose, s * (W / 2 + gapMin / 2), 0.25, zc);
  const sideRef = toWorld(pose, s * W / 2, 0.6, zc);
  const obstacleRef = toWorld(pose, s * (W / 2 + gapMin), 0.6, zc);
  const ignore = new Set(colliders.filter((c) => Math.hypot(c.x - obstacleRef.x, c.z - obstacleRef.z) < 2.5).map((c) => c.id));
  const xs = [W / 2 - 0.15, W / 2 + gapMin / 2];
  // 틈 구간 여러 지점(앞·중·뒤)이 모두 보여야 한다. 장애물 표면에 0.7m 이내로 붙은 카메라는 시야가 막히므로 제외.
  const targets = [-0.9, 0, 0.9].map((dz) => toWorld(pose, s * (W / 2 + gapMin / 2), 0.25, zc + dz));
  for (const h of [3.2, 4.0, 5.0, 6.0]) {
    for (const back of [2.2, 3.2, 4.2]) {
      for (const lx of xs) {
        const pos = toWorld(pose, s * lx, h, zc - back);
        if (pointInsideSolid(pos, colliders, body)) continue;
        if (tooCloseToSolid(pos, colliders.filter((c) => !ignore.has(c.id) || c.h < h - 0.5), 0.7)) continue;
        const seeGap = targets.every((tg) => !segmentBlocked(pos, tg, colliders, body, { ignoreIds: ignore, endMargin: 0.1 }));
        const seeCar = !segmentBlocked(pos, sideRef, colliders, body, { endMargin: 0.2 });
        const seeObs = !segmentBlocked(pos, obstacleRef, colliders, body, { ignoreIds: ignore, endMargin: 0.1 });
        if (seeGap && seeCar && seeObs) {
          const dist = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
          const span = gapMin + 1.8;
          const fov = clampN((2 * Math.atan2((span / 2) * 1.3, dist) * 180) / Math.PI, 42, 78);
          return { pos, look: target, up: { x: 0, y: 1, z: 0 }, fov, visible: true };
        }
      }
    }
  }
  const fb = toWorld(pose, s * (W / 2 + 2.3), 3.0, zc - 3);
  return { pos: fb, look: target, up: { x: 0, y: 1, z: 0 }, fov: 64, visible: false };
}
