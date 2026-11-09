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
    ambient: number;
  };
  spawn: { x: number; z: number; heading: number; y?: number };
  /** 다층/경사 지형 (없으면 평면 맵). 맵 데이터와 3D 에셋(towerBuilder)은 분리되어 있다 */
  terrain?: Terrain;
  /** 상층 바닥 도색 등 층별 시각 데이터 (terrain 이 있을 때) */
  levelPaint?: (PaintRect & { y: number })[];
  /** 승강기식 기계식 주차장 장치가 있는 맵 (src/mech) */
  mech?: boolean;
  /** 최종 확정된 맵이 아니라 검증용 임시 레이아웃인가 */
  provisional?: boolean;
  surfaces: SurfaceRect[];
  paint: PaintRect[];
  obstacles: ObstacleDef[];
  slots: MapSlot[];
  missions: MapMission[];
  /** 실내 점광원/천장 조명 위치 */
  ceilingLights?: { x: number; z: number }[];
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
