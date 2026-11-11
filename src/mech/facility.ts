/**
 * 기계식 주차 시설 모듈 (v0.5.3).
 *
 * 한 시설의 장치 로직(machine.ts)과 모델(mechBuilder.ts)은 **시설 로컬 좌표**(승강장 STATION 기준)에서 동작하고,
 * 월드에는 `(x, z, yaw)` 변환으로만 놓인다. 따라서 시설을 여러 개 서로 다른 위치/방향에 둘 수 있고,
 * 각 시설은 자신의 상태기계(슬롯/차량/셔터/캐리지)를 독립적으로 가진다.
 *
 * 변환 규칙: 월드 = 원점 + Rψ·로컬, Rψ(x,z) = (x·cosψ + z·sinψ, −x·sinψ + z·cosψ).
 *  - three.js 의 group.rotation.y = ψ 와 같은 행렬이고, 차량 heading 은 world = local + ψ.
 */
import type { Collider } from '../core/geometry';
import { STATION } from './machine';

export interface Frame {
  x: number;
  z: number;
  /** 회전(rad). 0 이면 로컬 = 월드 축 */
  yaw: number;
}
export const IDENTITY_FRAME: Frame = { x: 0, z: 0, yaw: 0 };

export const toLocalXZ = (f: Frame, x: number, z: number): { x: number; z: number } => {
  const dx = x - f.x;
  const dz = z - f.z;
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
};
export const toWorldXZ = (f: Frame, x: number, z: number): { x: number; z: number } => {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return { x: f.x + x * c + z * s, z: f.z - x * s + z * c };
};
export const headingToLocal = (f: Frame, h: number): number => h - f.yaw;
export const headingToWorld = (f: Frame, h: number): number => h + f.yaw;

/** 시설 설정 데이터 (맵 데이터에 들어간다) */
export interface MechFacilityConfig {
  id: string;
  name: string;
  /** 시설 원점(승강장 로컬 (0,0))의 월드 위치와 회전 */
  x: number;
  z: number;
  rotationY: number;
  /** 층수(2~12). 보관층 = 2F~floors, 층당 슬롯 2개(A/B) */
  floors: number;
  slotsPerFloor: 2;
  /** 입고 방식: 전진/후진 모두, 또는 한쪽만 안내 */
  entranceMode: 'both' | 'fwd' | 'rev';
  /** 정원(슬롯 수) — floors 에서 계산되지만 데이터에 남겨 둔다(검증용) */
  capacity: number;
  enabled: boolean;
}

export const capacityOf = (floors: number): number => (Math.min(12, Math.max(2, Math.round(floors))) - 1) * 2;

export function makeFacility(p: { id: string; name: string; x: number; z: number; rotationY?: number; floors?: number; entranceMode?: MechFacilityConfig['entranceMode']; enabled?: boolean }): MechFacilityConfig {
  const floors = Math.min(12, Math.max(2, Math.round(p.floors ?? 12)));
  return { id: p.id, name: p.name, x: p.x, z: p.z, rotationY: p.rotationY ?? 0, floors, slotsPerFloor: 2, entranceMode: p.entranceMode ?? 'both', capacity: capacityOf(floors), enabled: p.enabled ?? true };
}

export const frameOf = (c: Pick<MechFacilityConfig, 'x' | 'z' | 'rotationY'>): Frame => ({ x: c.x, z: c.z, yaw: c.rotationY });

/** 시설의 입구(문 바깥 진입 지점)의 월드 좌표 — 추천/안내 표시용 */
export const entranceOf = (c: Pick<MechFacilityConfig, 'x' | 'z' | 'rotationY'>): { x: number; z: number } => toWorldXZ(frameOf(c), STATION.doorX - 6, 0);

/** 로컬 좌표로 정의된 충돌체를 월드 좌표로 옮긴다 (box: 중심+회전, circle: 중심) */
export function transformCollider<T extends Collider>(c: T, f: Frame): T {
  const p = toWorldXZ(f, (c as { x: number }).x, (c as { z: number }).z);
  const out = { ...c, x: p.x, z: p.z } as T & { rot?: number };
  if ((c as { kind: string }).kind === 'box') (out as { rot: number }).rot = ((c as { rot?: number }).rot ?? 0) + f.yaw;
  return out;
}

/** 월드 점이 시설 영역(로컬 직사각형 [minX,maxX]×[minZ,maxZ]) 안에 있는가 */
export function insideFacility(f: Frame, x: number, z: number, margin = 0): boolean {
  const l = toLocalXZ(f, x, z);
  return l.x > STATION.doorX - 28 - margin && l.x < STATION.palletX + 14 + margin && Math.abs(l.z) < 14 + margin;
}
export const distToFacility = (f: Frame, x: number, z: number): number => Math.hypot(x - f.x, z - f.z);
