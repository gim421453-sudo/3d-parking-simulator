/**
 * 주차칸 점유/잔여 집계와 기계식 주차 이용 추천 정책 (v0.5.3, 순수 로직).
 *
 * 확정 정책:
 *  - 기계식 주차는 일반 주차칸이 남아 있어도 **항상 이용할 수 있다**(만차/고장/비상정지/작동 중 제외).
 *  - 일반 주차칸 잔여율이 임계값(기본 20%) 이하이면 기계식을 **우선 추천**한다.
 *  - 일반 주차칸이 0이면 이용 가능한 기계식 시설로 안내한다. 기계식도 만차면 다른 구역의 이용 가능한 주차장을 안내한다.
 *  - 점유/잔여 수는 실제 데이터(맵의 주차된 차량, 시설 상태기계의 슬롯)에서 센다.
 */
import type { MapData } from '../maps/types';
import type { MechFacilityConfig } from '../mech/facility';
import { entranceOf } from '../mech/facility';
import type { MachineState } from '../mech/machine';

export const DEFAULT_LOW_RATIO = 0.2;

export type FacilityStatus = 'available' | 'busy' | 'full' | 'fault' | 'estop';
export interface FacilityAvail {
  id: string;
  name: string;
  entrance: { x: number; z: number };
  total: number;
  occupied: number;
  free: number;
  status: FacilityStatus;
  /** 지금 입고를 시작할 수 있는가(available) 또는 잠시 뒤 가능한가(busy) */
  usable: boolean;
}
export interface AreaAvail {
  id: string;
  label: string;
  regularTotal: number;
  regularOccupied: number;
  regularFree: number;
  mech: FacilityAvail[];
  /** 구역 입구(다른 구역 안내 거리 계산용) */
  entrance: { x: number; z: number };
}

export type RecommendKind = 'both' | 'prefer-mech' | 'only-mech' | 'other-area' | 'regular-only' | 'none';
export interface Recommendation {
  kind: RecommendKind;
  headline: string;
  /** 추천 시설(가장 가까운 이용 가능한 기계식) */
  facility: FacilityAvail | null;
  /** 다른 구역 안내(기계식이 만차/불가일 때) */
  area: AreaAvail | null;
  usable: FacilityAvail[];
  regularRatio: number;
}

const isMechSlot = (id: string): boolean => /(^|:)(pallet|exit-zone)$/.test(id);

export interface SlotLike {
  id: string;
  x: number;
  z: number;
  w: number;
  l: number;
  dir: number;
}
/** 일반(기계식 제외) 주차칸 */
export const regularSlots = (map: Pick<MapData, 'slots'>): SlotLike[] => (map.slots as unknown as SlotLike[]).filter((s) => !isMechSlot(s.id));

/** 차량 중심점이 주차칸 직사각형 안에 있으면 그 칸은 점유 */
export function slotOccupied(s: SlotLike, vehicles: { x: number; z: number }[]): boolean {
  const c = Math.cos(s.dir);
  const sn = Math.sin(s.dir);
  return vehicles.some((v) => {
    const dx = v.x - s.x;
    const dz = v.z - s.z;
    // heading 규칙: 칸 로컬 +z = (sin dir, cos dir), +x = (cos dir, -sin dir)
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    return Math.abs(lx) <= s.w / 2 && Math.abs(lz) <= s.l / 2;
  });
}

export function facilityAvail(cfg: MechFacilityConfig, m: Pick<MachineState, 'slots' | 'phase' | 'fault'>): FacilityAvail {
  const total = Object.keys(m.slots).length;
  const occupied = Object.values(m.slots).filter(Boolean).length;
  const free = total - occupied;
  let status: FacilityStatus = 'available';
  if (!cfg.enabled || m.fault) status = 'fault';
  else if (m.phase === 'estop') status = 'estop';
  else if (free <= 0) status = 'full';
  else if (m.phase !== 'waiting') status = 'busy';
  return { id: cfg.id, name: cfg.name, entrance: entranceOf(cfg), total, occupied, free, status, usable: status === 'available' || status === 'busy' };
}

export const statusText = (s: FacilityStatus): string => ({ available: '이용 가능', busy: '작동 중(잠시 후)', full: '만차', fault: '점검/고장', estop: '비상정지' })[s];

interface Zone {
  id: string;
  label: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  entrance: { x: number; z: number };
}
const inB = (b: Zone['bounds'], x: number, z: number): boolean => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

export interface FacilityStateRef {
  cfg: MechFacilityConfig;
  m: Pick<MachineState, 'slots' | 'phase' | 'fault'>;
}

/** 맵(또는 통합 맵의 각 구역)별 점유/잔여 집계. 구역은 서로 독립이다. */
export function computeAreas(map: MapData, facilities: FacilityStateRef[], extraVehicles: { x: number; z: number }[] = []): AreaAvail[] {
  const cars = map.obstacles.filter((o) => o.tag === 'car').map((o) => ({ x: o.x, z: o.z }));
  const vehicles = [...cars, ...extraVehicles];
  const slots = regularSlots(map);
  const zones = (map as unknown as { zones?: Zone[] }).zones;
  const build = (id: string, label: string, ss: SlotLike[], fs: FacilityStateRef[], entrance: { x: number; z: number }): AreaAvail => {
    const occ = ss.filter((s) => slotOccupied(s, vehicles)).length;
    return { id, label, regularTotal: ss.length, regularOccupied: occ, regularFree: ss.length - occ, mech: fs.map((f) => facilityAvail(f.cfg, f.m)), entrance };
  };
  if (!zones?.length) return [build(map.id, map.name, slots, facilities, { x: map.spawn.x, z: map.spawn.z })];
  return zones.map((z) =>
    build(
      z.id,
      z.label,
      slots.filter((s) => inB(z.bounds, s.x, s.z)),
      facilities.filter((f) => inB(z.bounds, f.cfg.x, f.cfg.z)),
      z.entrance,
    ),
  );
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 추천 정책. `area` = 플레이어가 있는 구역. `all` = 전체 구역(다른 구역 안내용). `from` = 플레이어 위치.
 * 일반 칸 잔여율 > lowRatio → both, ≤ lowRatio(>0) → prefer-mech, 0 → only-mech, 기계식 불가 → other-area.
 */
export function recommend(area: AreaAvail, all: AreaAvail[], from: { x: number; z: number }, lowRatio = DEFAULT_LOW_RATIO): Recommendation {
  const usable = area.mech.filter((f) => f.usable).sort((a, b) => dist(from, a.entrance) - dist(from, b.entrance));
  const ratio = area.regularTotal > 0 ? area.regularFree / area.regularTotal : 0;
  const base = { usable, regularRatio: ratio };
  const nearestOther = (): AreaAvail | null =>
    all
      .filter((a) => a.id !== area.id && (a.regularFree > 0 || a.mech.some((f) => f.usable)))
      .sort((a, b) => dist(from, a.entrance) - dist(from, b.entrance))[0] ?? null;

  if (area.regularFree > 0 && ratio > lowRatio) {
    return { ...base, kind: 'both', headline: usable.length ? '일반 주차칸과 기계식 주차장을 모두 이용할 수 있습니다' : '일반 주차칸을 이용하세요', facility: usable[0] ?? null, area: null };
  }
  if (area.regularFree > 0) {
    // 잔여율 ≤ 임계: 기계식 우선 추천 (일반 칸도 아직 있음)
    if (usable.length) return { ...base, kind: 'prefer-mech', headline: `일반 주차칸 잔여 ${area.regularFree}칸(${Math.round(ratio * 100)}%) — 기계식 주차장을 우선 추천합니다`, facility: usable[0], area: null };
    const other = nearestOther();
    return { ...base, kind: 'regular-only', headline: `일반 주차칸 잔여 ${area.regularFree}칸 — 기계식은 지금 이용할 수 없습니다`, facility: null, area: other };
  }
  // 일반 칸 0
  if (usable.length) return { ...base, kind: 'only-mech', headline: '일반 주차칸이 모두 찼습니다 — 기계식 주차장으로 안내합니다', facility: usable[0], area: null };
  const other = nearestOther();
  if (other) return { ...base, kind: 'other-area', headline: `이 구역은 만차입니다 — ${other.label} 이용을 안내합니다`, facility: null, area: other };
  return { ...base, kind: 'none', headline: '이용 가능한 주차 공간이 없습니다', facility: null, area: null };
}

/** 한 줄 요약(HUD 표시용). 거리 숫자는 넣지 않는다 */
export function summaryLine(area: AreaAvail): string {
  const m = area.mech.length ? ` · 기계식 ${area.mech.reduce((a, f) => a + f.free, 0)}/${area.mech.reduce((a, f) => a + f.total, 0)}` : '';
  return `일반 ${area.regularFree}/${area.regularTotal}${m}`;
}
