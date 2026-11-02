import type { VehicleSpec } from '../vehicle/spec';
import type { Collider } from '../core/geometry';
import { localToWorld } from '../core/math';
import { insideFootprint } from './visibility';

/**
 * 조향각 기반 동적 주차 가이드라인 (지면 위 경로, 차량 로컬 좌표).
 * 저속 자전거 모델과 같은 기구학: 뒤축 중심을 기준으로 선회 중심 C = (R, zRear), R = L / tan(steer).
 * dir: +1 전진, -1 후진.  steer: 왼쪽 + (rad).
 */
export interface PathPoint {
  x: number;
  z: number;
  s: number; // 진행 거리(m)
}

export function rotateAbout(px: number, pz: number, cx: number, cz: number, h: number): { x: number; z: number } {
  const vx = px - cx;
  const vz = pz - cz;
  // 차량 좌표계의 heading 회전 (src/core/math.ts 의 localToWorld 와 동일 부호)
  return { x: cx + vx * Math.cos(h) + vz * Math.sin(h), z: cz - vx * Math.sin(h) + vz * Math.cos(h) };
}

/** 차체의 한 점(px, pz)이 steer 로 dir 방향으로 s 만큼 진행할 때 지나는 점들 */
export function pathOfPoint(spec: VehicleSpec, steer: number, dir: 1 | -1, px: number, pz: number, maxDist: number, step: number): PathPoint[] {
  const zRear = -spec.length / 2 + spec.rearOverhang;
  const t = Math.tan(steer);
  const out: PathPoint[] = [];
  for (let s = 0; s <= maxDist + 1e-9; s += step) {
    if (Math.abs(t) < 1e-4) {
      out.push({ x: px, z: pz + dir * s, s });
    } else {
      const R = spec.wheelbase / t; // 부호 있는 반경 (왼쪽 +)
      const theta = (dir * s) / R; // 진행에 따른 heading 변화
      const p = rotateAbout(px, pz, R, zRear, theta);
      out.push({ x: p.x, z: p.z, s });
    }
  }
  return out;
}

export interface GuideLines {
  /** 현재 조향으로 예상되는 차체 좌/우 끝선 경로 */
  left: PathPoint[];
  right: PathPoint[];
  /** 조향 0(직진) 기준 폭 표시선 */
  straightLeft: PathPoint[];
  straightRight: PathPoint[];
  /** 거리 구분선(가로선): 각 s 에서 좌-우 끝점 */
  marks: { s: number; left: PathPoint; right: PathPoint }[];
}

export const GUIDE_ZONES = [1.0, 2.0, 3.5]; // 빨강 → 노랑 → 초록 경계(m)

export const SURROUND_MARKS = [0.5, 1.0, 2.0, 3.0]; // 서라운드뷰 예측 거리 구분선(조향 경로상 이동 거리, 장애물까지의 측정 거리가 아님)

export function buildGuideLines(spec: VehicleSpec, steer: number, dir: 1 | -1, maxDist = 4.5, markDists: readonly number[] = GUIDE_ZONES): GuideLines {
  const zEdge = dir < 0 ? -spec.length / 2 : spec.length / 2; // 후진=뒤 범퍼, 전진=앞 범퍼
  const hw = spec.width / 2;
  const left = pathOfPoint(spec, steer, dir, hw, zEdge, maxDist, 0.25);
  const right = pathOfPoint(spec, steer, dir, -hw, zEdge, maxDist, 0.25);
  const straightLeft = pathOfPoint(spec, 0, dir, hw, zEdge, maxDist, maxDist);
  const straightRight = pathOfPoint(spec, 0, dir, -hw, zEdge, maxDist, maxDist);
  const marks = markDists.filter((z) => z <= maxDist + 1e-9).map((s) => {
    const l = pathOfPoint(spec, steer, dir, hw, zEdge, s, s).pop()!;
    const r = pathOfPoint(spec, steer, dir, -hw, zEdge, s, s).pop()!;
    return { s, left: l, right: r };
  });
  return { left, right, straightLeft, straightRight, marks };
}

/** 진행 거리에 따른 선 색 (가까움=빨강) */
export function guideColor(s: number): 'critical' | 'mid' | 'far' {
  return s < GUIDE_ZONES[0] ? 'critical' : s < GUIDE_ZONES[1] ? 'mid' : 'far';
}

/**
 * 예측 경로가 실제 장애물(센서 높이에서 감지되는 충돌체)과 처음 만나는 진행 거리(m).
 * 이 이후는 그리지 않아 선이 다른 차량/벽 차체를 통과하는 것처럼 보이지 않게 한다. 장애물이 없으면 maxDist.
 * pose: 차체 중심 pose. 경로는 물리와 같은 기구학(buildGuideLines) 그대로이며 모양을 바꾸지 않고 길이만 자른다.
 */
export function guideCutDistance(spec: VehicleSpec, steer: number, dir: 1 | -1, pose: { x: number; z: number; heading: number }, colliders: readonly Collider[], sensorY = 0.55, maxDist = 4.5): number {
  const lines = buildGuideLines(spec, steer, dir, maxDist);
  const solid = colliders.filter((c) => sensorY >= c.y0 && sensorY <= c.y0 + c.h);
  for (let i = 0; i < lines.left.length; i++) {
    for (const p of [lines.left[i], lines.right[i]]) {
      const w = localToWorld(pose.x, pose.z, pose.heading, p.x, p.z);
      if (solid.some((c) => insideFootprint(c, w.x, w.z))) return Math.max(0, lines.left[Math.max(0, i - 1)].s);
    }
  }
  return maxDist;
}
