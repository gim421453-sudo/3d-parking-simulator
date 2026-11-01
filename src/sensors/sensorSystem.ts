import { raycast, type Collider } from '../core/geometry';
import { localToWorld, type Vec2 } from '../core/math';
import type { SensorGroup, SensorMount } from '../vehicle/spec';

export interface SensorConfig {
  range: number; // 최대 감지 거리(m)
  critical: number; // 연속 경고 거리(m)
  rayStep: number; // 광선 간격(rad)
  collectRays: boolean; // 디버그용 광선 수집
}

export const DEFAULT_SENSOR_CONFIG: SensorConfig = {
  range: 2.5,
  critical: 0.3,
  rayStep: (5 * Math.PI) / 180,
  collectRays: false,
};

export interface SensorPose {
  x: number; // 차체 중심
  z: number;
  heading: number;
}

export interface SensorHit {
  x: number; // 월드 좌표
  z: number;
  distance: number;
  colliderId: string;
  tag: string;
}

export interface DebugRay {
  ox: number;
  oz: number;
  dx: number;
  dz: number;
  length: number; // 히트 시 거리, 아니면 range
  hit: boolean;
  colliderId?: string;
}

export interface SensorReading {
  id: string;
  group: SensorGroup;
  /** 가장 가까운 장애물까지의 거리(m). 범위 내 미검출이면 null */
  distance: number | null;
  nearest: SensorHit | null;
  hits: SensorHit[];
  origin: Vec2; // 월드 좌표 센서 위치
  rays: DebugRay[];
}

export interface SensorSnapshot {
  readings: SensorReading[];
  /** 그룹별 최소 거리 (미검출은 null) */
  groupMin: Record<SensorGroup, number | null>;
  range: number;
  critical: number;
}

/** 모든 센서를 한 번 읽는다. 장애물은 충돌체 기하 데이터만 사용하며, 자차/지면은 충돌체가 아니므로 감지되지 않는다. */
export function readSensors(
  pose: SensorPose,
  mounts: readonly SensorMount[],
  sensorHeight: number,
  colliders: readonly Collider[],
  cfg: SensorConfig,
): SensorSnapshot {
  const readings: SensorReading[] = [];
  const groupMin: Record<SensorGroup, number | null> = { front: null, rear: null, left: null, right: null };
  for (const m of mounts) {
    const o = localToWorld(pose.x, pose.z, pose.heading, m.x, m.z);
    const nRays = Math.max(1, Math.round(m.fov / cfg.rayStep) + 1);
    const hits: SensorHit[] = [];
    const rays: DebugRay[] = [];
    let nearest: SensorHit | null = null;
    for (let i = 0; i < nRays; i++) {
      const a = m.angle + (nRays === 1 ? 0 : -m.fov / 2 + (m.fov * i) / (nRays - 1));
      // 로컬 방향 (sin a, cos a) → 월드
      const c = Math.cos(pose.heading);
      const s = Math.sin(pose.heading);
      const ldx = Math.sin(a);
      const ldz = Math.cos(a);
      const dx = ldx * c + ldz * s;
      const dz = -ldx * s + ldz * c;
      const hit = raycast(colliders, o.x, o.z, dx, dz, cfg.range, sensorHeight);
      if (cfg.collectRays) {
        rays.push({
          ox: o.x,
          oz: o.z,
          dx,
          dz,
          length: hit ? hit.t : cfg.range,
          hit: !!hit,
          colliderId: hit?.collider.id,
        });
      }
      if (hit) {
        const h: SensorHit = {
          x: o.x + dx * hit.t,
          z: o.z + dz * hit.t,
          distance: hit.t,
          colliderId: hit.collider.id,
          tag: hit.collider.tag,
        };
        hits.push(h);
        if (!nearest || h.distance < nearest.distance) nearest = h;
      }
    }
    const distance = nearest ? nearest.distance : null;
    readings.push({ id: m.id, group: m.group, distance, nearest, hits, origin: o, rays });
    if (distance !== null) {
      const g = groupMin[m.group];
      if (g === null || distance < g) groupMin[m.group] = distance;
    }
  }
  return { readings, groupMin, range: cfg.range, critical: cfg.critical };
}

export type ProximityLevel = 'none' | 'far' | 'mid' | 'near' | 'critical';

/** 거리 → 경고 단계 (색상/경고음 공통 기준) */
export function proximityLevel(d: number | null, range: number, critical: number): ProximityLevel {
  if (d === null || d > range) return 'none';
  if (d <= critical) return 'critical';
  const span = range - critical;
  const f = (d - critical) / span;
  if (f < 0.33) return 'near';
  if (f < 0.66) return 'mid';
  return 'far';
}

export const LEVEL_COLORS: Record<ProximityLevel, number> = {
  none: 0x2e4a66,
  far: 0xe6d93a,
  mid: 0xf29a2e,
  near: 0xe8512f,
  critical: 0xd01030,
};

/** 경고음 주기(ms). 0 = 연속음, null = 소리 없음. 가까울수록 짧아진다. */
export function beepIntervalMs(d: number | null, range: number, critical: number): number | null {
  if (d === null || d > range) return null;
  if (d <= critical) return 0;
  const f = (d - critical) / (range - critical);
  return Math.round(110 + f * (900 - 110));
}

export type Gear = 'P' | 'R' | 'N' | 'D';

/** 기어/속도에 따라 경고음 대상이 되는 센서 그룹 */
export function activeGroupsFor(gear: Gear, speedKmh: number): SensorGroup[] {
  if (gear === 'R') return ['rear', 'left', 'right'];
  if (gear === 'D' && speedKmh < 10) return ['front', 'left', 'right'];
  return [];
}

export function minDistance(snap: SensorSnapshot, groups: readonly SensorGroup[]): number | null {
  let best: number | null = null;
  for (const g of groups) {
    const d = snap.groupMin[g];
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}
