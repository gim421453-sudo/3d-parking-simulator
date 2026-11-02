import type { SensorSnapshot } from '../sensors/sensorSystem';
import { proximityLevel, type ProximityLevel } from '../sensors/sensorSystem';
import { localToWorld, worldToLocal } from '../core/math';
import type { Obb } from '../core/geometry';
import { pointToObbGap } from './risk';
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
  /** 이 구역을 만든 실제 충돌체 id (가림 판정에서 자기 자신은 제외) */
  colliderIds: string[];
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
    out.push({ sensorId: m.id, group: m.group, level, corners: [P(f0, l0), P(f0, l1), P(f1, l1), P(f1, l0)], hits: r.hits.length, colliderIds: [...new Set(r.hits.map((h) => h.colliderId))] });
  });
  return out;
}

/** 월드 좌표 → 차량 로컬 (디버그/테스트용) */
export function zoneLocalCorners(z: ObstacleZone, pose: { x: number; z: number; heading: number }): { x: number; z: number }[] {
  return z.corners.map((c) => worldToLocal(pose.x, pose.z, pose.heading, c.x, c.z));
}

// ---------------------------------------------------------------- 전/후방 카메라: 가로 N 개 독립 타일
export const TILE_COUNT = 6;
const TILE_MARGIN = 0.35; // 차체 폭 좌우 여유 (m)
const TILE_DEPTH = 0.45; // 장애물 표면 앞쪽(차량 쪽) 바닥으로 칠하는 깊이

/**
 * 전/후방 카메라용 경고 타일. 차체 폭(+여유)을 가로 6칸으로 나누고, 센서가 실제로 맞춘 히트점이 있는 칸만 점등한다.
 * 타일은 그 칸의 가장 가까운 장애물 표면에서 차량 쪽으로 TILE_DEPTH 만큼의 바닥 사각형이라 표면 위치와 일치한다.
 * 칸의 색 단계는 그 칸의 가장 가까운 거리로 정한다(숫자는 내보내지 않는다). 히트가 없는 칸은 만들지 않는다.
 */
export function buildCameraTiles(snap: SensorSnapshot | null, spec: VehicleSpec, body: Obb, dir: 'front' | 'rear', range: number, critical: number): ObstacleZone[] {
  if (!snap) return [];
  const hw = body.hw;
  const hl = body.hl;
  const half = hw + TILE_MARGIN;
  const bins: { gap: number; hits: number; ids: Set<string> }[] = Array.from({ length: TILE_COUNT }, () => ({ gap: Infinity, hits: 0, ids: new Set<string>() }));
  spec.sensors.forEach((_m, i) => {
    const r = snap.readings[i];
    if (!r) return;
    for (const h of r.hits) {
      const l = worldToLocal(body.x, body.z, body.rot, h.x, h.z);
      const beyond = dir === 'front' ? l.z - hl : -l.z - hl;
      if (beyond < 0 || Math.abs(l.x) > half) continue;
      const bi = Math.min(TILE_COUNT - 1, Math.max(0, Math.floor(((half - l.x) / (2 * half)) * TILE_COUNT)));
      const b = bins[bi];
      b.hits++;
      b.ids.add(h.colliderId);
      if (beyond < b.gap) b.gap = beyond;
    }
  });
  const out: ObstacleZone[] = [];
  const w = (2 * half) / TILE_COUNT;
  bins.forEach((b, i) => {
    if (b.hits === 0 || b.gap > range) return;
    const level = proximityLevel(b.gap, range, critical);
    if (level === 'none') return;
    // 화면 왼쪽 = 차량 왼쪽(+x). 로컬 x 는 왼쪽이 +.
    const xl = half - i * w;
    const xr = xl - w;
    const zNear = (dir === 'front' ? 1 : -1) * (hl + Math.max(0, b.gap - TILE_DEPTH));
    const zFar = (dir === 'front' ? 1 : -1) * (hl + b.gap);
    const P = (x: number, z: number): { x: number; z: number } => localToWorld(body.x, body.z, body.rot, x, z);
    out.push({ sensorId: `tile-${dir}-${i}`, group: dir, level, corners: [P(xl, zNear), P(xr, zNear), P(xr, zFar), P(xl, zFar)], hits: b.hits, colliderIds: [...b.ids] });
  });
  return out;
}

// ---------------------------------------------------------------- 3D/탑뷰: 차량 근처 장애물 경계 셀
export const CELL = 0.45;
export const CELL_MAX_GAP = 1.8; // 이보다 먼 장애물은 표시하지 않는다
export const CELL_MAX = 48;

/** 차체 근처(CELL_MAX_GAP 이내)의 실제 히트점만 월드 격자(0.45m) 셀로 모아 장애물 경계를 따라 표시한다. */
export function buildBoundaryCells(snap: SensorSnapshot | null, body: Obb, range: number, critical: number): ObstacleZone[] {
  if (!snap) return [];
  const cells = new Map<string, { gap: number; hits: number; ids: Set<string>; ix: number; iz: number }>();
  for (const r of snap.readings) {
    for (const h of r.hits) {
      const gap = pointToObbGap(h.x, h.z, body);
      if (gap > CELL_MAX_GAP || gap > range) continue;
      const ix = Math.floor(h.x / CELL);
      const iz = Math.floor(h.z / CELL);
      const k = `${ix}_${iz}`;
      const c = cells.get(k) ?? { gap: Infinity, hits: 0, ids: new Set<string>(), ix, iz };
      c.hits++;
      c.ids.add(h.colliderId);
      if (gap < c.gap) c.gap = gap;
      cells.set(k, c);
    }
  }
  const list = [...cells.values()].sort((a, b) => a.gap - b.gap).slice(0, CELL_MAX);
  const out: ObstacleZone[] = [];
  for (const c of list) {
    const level = proximityLevel(c.gap, range, critical);
    if (level === 'none') continue;
    const x0 = c.ix * CELL;
    const z0 = c.iz * CELL;
    out.push({ sensorId: `cell-${c.ix}_${c.iz}`, group: 'front', level, corners: [{ x: x0, z: z0 }, { x: x0 + CELL, z: z0 }, { x: x0 + CELL, z: z0 + CELL }, { x: x0, z: z0 + CELL }], hits: c.hits, colliderIds: [...c.ids] });
  }
  return out;
}
