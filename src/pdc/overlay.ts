import type { SensorSnapshot } from '../sensors/sensorSystem';
import { proximityLevel, type ProximityLevel } from '../sensors/sensorSystem';
import { worldToLocal } from '../core/math';
import type { VehicleSpec } from '../vehicle/spec';

/**
 * 카메라 영상 위 "실제 감지된 장애물" 구역 (엔진 독립 순수 로직).
 * - 센서가 실제로 맞춘 히트점(충돌체 기하)만 사용한다. 미감지 구역/임의 크기는 만들지 않는다.
 * - 구역 폭 = 히트점들의 좌우 범위(+여유), 깊이 = 가장 가까운 히트점 거리 ~ +DEPTH.
 * - 색 단계는 거리에서 계산하지만 거리 숫자는 출력하지 않는다 (일반 화면 거리 표시 금지).
 */
export interface ObstacleZone {
  sensorId: string;
  group: 'front' | 'rear' | 'left' | 'right';
  level: Exclude<ProximityLevel, 'none'>;
  /** 지면 사각형 4모서리 (월드 좌표, 시계/반시계 순서) */
  corners: { x: number; z: number }[];
  /** 히트점 개수(신뢰도 근사). 1개 이하의 고립 히트는 약하게 표시 */
  hits: number;
}

export const OVERLAY_DEPTH = 0.45; // m, 가장 가까운 히트점에서 바깥쪽으로
export const OVERLAY_PAD = 0.12; // m, 좌우 여유

export function buildObstacleZones(
  snap: SensorSnapshot | null,
  spec: VehicleSpec,
  pose: { x: number; z: number; heading: number },
  groups: ReadonlyArray<'front' | 'rear' | 'left' | 'right'>,
): ObstacleZone[] {
  if (!snap) return [];
  const out: ObstacleZone[] = [];
  spec.sensors.forEach((m, i) => {
    if (!groups.includes(m.group)) return;
    const r = snap.readings[i];
    if (!r || r.distance === null || r.hits.length === 0) return;
    const level = proximityLevel(r.distance, snap.range, snap.critical);
    if (level === 'none') return;
    // 센서 방향(월드) 기준 좌표계에서 히트점 범위를 구한다
    const ang = pose.heading + m.angle;
    const fx = -Math.sin(ang);
    const fz = Math.cos(ang);
    const lx = -fz; // 왼쪽 수직
    const lz = fx;
    let minF = Infinity;
    let minL = Infinity;
    let maxL = -Infinity;
    for (const h of r.hits) {
      const dx = h.x - r.origin.x;
      const dz = h.z - r.origin.z;
      const f = dx * fx + dz * fz;
      const l = dx * lx + dz * lz;
      if (f < minF) minF = f;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    const f0 = minF;
    const f1 = minF + OVERLAY_DEPTH;
    const l0 = minL - OVERLAY_PAD;
    const l1 = maxL + OVERLAY_PAD;
    const P = (f: number, l: number): { x: number; z: number } => ({ x: r.origin.x + fx * f + lx * l, z: r.origin.z + fz * f + lz * l });
    out.push({ sensorId: m.id, group: m.group, level, corners: [P(f0, l0), P(f0, l1), P(f1, l1), P(f1, l0)], hits: r.hits.length });
  });
  return out;
}

/** 월드 좌표 → 차량 로컬 (디버그/테스트용) */
export function zoneLocalCorners(z: ObstacleZone, pose: { x: number; z: number; heading: number }): { x: number; z: number }[] {
  return z.corners.map((c) => worldToLocal(pose.x, pose.z, pose.heading, c.x, c.z));
}
