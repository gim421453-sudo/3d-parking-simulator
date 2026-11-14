import type { MechFacilityConfig } from '../mech/facility';
import type { LiftConfig } from '../service/lift';
import type { Rect2 } from './terrain';

/** 도로 구간: 중심선 a→b (직선), 폭, 통행 방향. y0/y1 은 경사로(지하 진입 등)의 시작/끝 높이 */
export interface RoadSeg {
  id: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
  /** 차로 수(양방향 합계) */
  lanes: number;
  /** 일방통행이면 a→b 방향만 */
  oneway?: boolean;
  kind: 'avenue' | 'street' | 'access' | 'ramp';
  y0?: number;
  y1?: number;
  name?: string;
}
import type { Collider } from '../core/geometry';
import type { MissionDef, ParkingSlot } from '../mission/parking';
import type { Terrain } from './terrain';

export type ObstacleTag =
  | 'wall'
  | 'pillar'
  | 'cone'
  | 'barrier'
  | 'building'
  | 'lamp'
  | 'tree'
  | 'planter'
  | 'curb'
  | 'drum'
  | 'guide'
  | 'bollard'
  | 'car';

export interface ObstacleDef {
  id: string;
  tag: ObstacleTag;
  shape: 'box' | 'cyl';
  x: number;
  z: number;
  w?: number; // box: 로컬 x 폭
  d?: number; // box: 로컬 z 깊이
  r?: number; // cyl 반지름
  rot?: number;
  h: number;
  y0?: number;
  color?: number;
  /** tag === 'car' 일 때 VEHICLES 인덱스 */
  carSpec?: number;
  /** v0.6.0: 충돌/센서 전용(맵 빌더가 그리지 않는다) — 실제 지도 건물처럼 외형은 다른 레이어(geo)가 그릴 때 */
  hidden?: boolean;
}

/** v0.6.0 실제 지도(OSM 등) 표시 레이어. 좌표는 맵 좌표(m), 다각형은 [x, z] 점 목록 */
export interface GeoLayer {
  buildings: { id: string; pts: [number, number][]; h: number; color: number; name?: string; gen?: boolean }[];
  roads: { id: string; pts: [number, number][]; w: number; hw: string; name?: string; oneway: boolean }[];
  areas: { id: string; kind: 'parking' | 'grass' | 'water' | 'pitch'; pts: [number, number][]; name?: string }[];
  /** 화면에 표시할 출처 (ODbL 등) */
  attribution: string;
}

export interface MapSlot extends ParkingSlot {
  style: 'u' | 'box'; // u: 입구가 열린 U자 선, box: 사각형
}

export interface PaintRect {
  x: number;
  z: number;
  w: number;
  d: number;
  rot?: number;
  color: number; // 0xffffff 흰색 / 0xf2c200 노란색
}

export interface SurfaceRect {
  x: number;
  z: number;
  w: number;
  d: number;
  kind: 'asphalt' | 'sidewalk' | 'concrete' | 'grass';
}

export interface MapMission extends MissionDef {
  spawn?: { x: number; z: number; heading: number; y?: number };
}

export interface MapData {
  id: string;
  name: string;
  desc: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  env: {
    indoor: boolean;
    sky: number;
    ceilingHeight?: number;
    /** 실내 천장이 덮는 범위(생략하면 맵 경계 전체). 옆에 붙은 기계식 구역처럼 천장이 없는 부분을 뺄 때 쓴다 */
    ceilingRect?: { minX: number; maxX: number; minZ: number; maxZ: number };
    ambient: number;
  };
  spawn: { x: number; z: number; heading: number; y?: number };
  /** 다층/경사 지형 (없으면 평면 맵). 맵 데이터와 3D 에셋(towerBuilder)은 분리되어 있다 */
  terrain?: Terrain;
  /** 상층 바닥 도색 등 층별 시각 데이터 (terrain 이 있을 때) */
  levelPaint?: (PaintRect & { y: number })[];
  /** 승강기식 기계식 주차장 장치가 있는 맵 (src/mech) */
  mech?: boolean;
  /** 기계식 주차 시설 목록(재사용 모듈). 시설마다 독립 ID/위치/회전/층수 — mech 플래그는 목록이 비어 있지 않을 때 true */
  mechFacilities?: MechFacilityConfig[];
  /** 맵 옆에 붙인 기계식 부속 구역(maps/mechAnnex.ts) — 마당/문/접근 자세. 검증·문서용 데이터 */
  annex?: { facility: string; side: 'east' | 'west' | 'north' | 'south'; yard: { minX: number; maxX: number; minZ: number; maxZ: number }; gate: { minX: number; maxX: number; minZ: number; maxZ: number }; approach: { x: number; z: number; heading: number } }[];
  /** 기계식 시설을 설치하지 못한 이유(문서/추천 정책 표시용) */
  mechUnavailable?: string;
  /** 최종 확정된 맵이 아니라 검증용 임시 레이아웃인가 */
  provisional?: boolean;
  surfaces: SurfaceRect[];
  paint: PaintRect[];
  obstacles: ObstacleDef[];
  slots: MapSlot[];
  missions: MapMission[];
  /** 실내 점광원/천장 조명 위치 (y = 조명 높이, 생략하면 env.ceilingHeight) */
  ceilingLights?: { x: number; z: number; y?: number }[];
  /** 지면(y=0)에 뚫린 구멍: 지하 진입 경사로 트렌치 등. 지면 메시와 지형(ground deck)이 같은 구멍을 가진다 */
  groundHoles?: Rect2[];
  /** 야외 맵 안의 실내 구역(지하층 등): 이 안에서는 어둡게(자동 전조등/주변광 감소) */
  indoorZones?: { id: string; rect: Rect2; yMin: number; yMax: number }[];
  /** 정비소 2주식 리프트 (service/lift.ts) */
  lifts?: LiftConfig[];
  /** 도로 중심선 데이터(시각/내비 가중/자동 검사용) */
  roads?: RoadSeg[];
  /** v0.6.0 실제 지도 표시 레이어(건물 다각형/도로 폴리라인/면) */
  geo?: GeoLayer;
  /** v0.6.0 실제 도로망 그래프(내비): 노드 [x,z], 간선 [a, b, 일방통행] */
  roadNet?: { nodes: [number, number][]; edges: [number, number, 0 | 1][] };
}

export function obstacleToCollider(o: ObstacleDef): Collider {
  if (o.shape === 'cyl') {
    return { kind: 'cyl', id: o.id, tag: o.tag, x: o.x, z: o.z, r: o.r ?? 0.2, y0: o.y0 ?? 0, h: o.h };
  }
  return {
    kind: 'box',
    id: o.id,
    tag: o.tag,
    x: o.x,
    z: o.z,
    w: o.w ?? 1,
    d: o.d ?? 1,
    rot: o.rot ?? 0,
    y0: o.y0 ?? 0,
    h: o.h,
  };
}

const cache = new WeakMap<MapData, Collider[]>();
export function mapColliders(map: MapData): Collider[] {
  let c = cache.get(map);
  if (!c) {
    c = map.obstacles.map(obstacleToCollider);
    cache.set(map, c);
  }
  return c;
}
