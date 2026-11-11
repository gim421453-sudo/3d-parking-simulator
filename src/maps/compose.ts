import type { MechFacilityConfig } from '../mech/facility';
import type { ParkingSlot } from '../mission/parking';
import type { DeckSurface, Terrain, TerrainSurface } from './terrain';
import type { MapData, MapMission, MapSlot, ObstacleDef, PaintRect, SurfaceRect } from './types';

/**
 * 여러 MapData 를 **하나의 장면**에 배치하는 구성기 (v0.5.2 통합 맵).
 * 순수 평행이동(회전 없음)만 사용하므로 바닥/지형 높이/경사로/나선/충돌체/도색/주차칸/목표/미션 스폰이 모두 같은 변환을 받는다.
 * 객체 ID 는 구역 접두사(`zoneId:`)로 네임스페이스를 부여해 중복을 막는다(기계식 구역은 장치 좌표가 절대값이라 접두사/이동 없음).
 */
export interface ZonePlacement {
  map: MapData;
  /** 구역 접두사('' = 없음) */
  ns: string;
  label: string;
  dx: number;
  dz: number;
  /** 구역 입구의 로컬 z (기본: 맵 시작 위치 z) */
  entranceZ?: number;
  /** 입구가 열려 있는 쪽 (기본 서쪽). 동쪽이면 동쪽 외벽을 연다 */
  side?: 'west' | 'east';
}
export interface ZoneInfo {
  id: string;
  label: string;
  /** 월드 좌표 경계 */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 구역 입구(월드 좌표, 서쪽 가장자리 중앙 높이에서 도로와 연결) */
  entrance: { x: number; z: number; side: 'west' | 'east' };
}

const sx = (ns: string, id: string): string => (ns ? `${ns}:${id}` : id);

function moveObstacle(o: ObstacleDef, ns: string, dx: number, dz: number): ObstacleDef {
  return { ...o, id: sx(ns, o.id), x: o.x + dx, z: o.z + dz };
}
function moveSlot(s: MapSlot, ns: string, dx: number, dz: number): MapSlot {
  return { ...s, id: sx(ns, s.id), x: s.x + dx, z: s.z + dz };
}
const movePaint = <T extends PaintRect>(p: T, dx: number, dz: number): T => ({ ...p, x: p.x + dx, z: p.z + dz });
const moveSurface = (s: SurfaceRect, dx: number, dz: number): SurfaceRect => ({ ...s, x: s.x + dx, z: s.z + dz });

function moveTerrainSurface(s: TerrainSurface, ns: string, dx: number, dz: number): TerrainSurface {
  const id = sx(ns, s.id);
  if (s.kind === 'deck') {
    return {
      ...s,
      id,
      rect: { ...s.rect, x: s.rect.x + dx, z: s.rect.z + dz },
      holes: s.holes?.map((h) => ('r' in h ? { ...h, cx: h.cx + dx, cz: h.cz + dz } : { ...h, x: h.x + dx, z: h.z + dz })),
    };
  }
  if (s.kind === 'ramp') return { ...s, id, x: s.x + dx, z: s.z + dz };
  return { ...s, id, cx: s.cx + dx, cz: s.cz + dz };
}

export interface ComposeOptions {
  id: string;
  name: string;
  desc: string;
  zones: ZonePlacement[];
  /** 도로/추가 지면 */
  surfaces?: SurfaceRect[];
  paint?: PaintRect[];
  extraObstacles?: ObstacleDef[];
  spawn: MapData['spawn'];
  bounds: MapData['bounds'];
  /** 지상(y=0) 전체를 덮는 deck 의 사각형 (terrain 이 있는 맵은 바닥 면이 없으면 주행 불가) */
  groundRect: { x: number; z: number; w: number; d: number };
  /** 추가 terrain 면(예: 지하주차장 천장) */
  extraTerrain?: DeckSurface[];
}

export function composeMap(o: ComposeOptions): MapData & { zones: ZoneInfo[] } {
  const obstacles: ObstacleDef[] = [...(o.extraObstacles ?? [])];
  const slots: MapSlot[] = [];
  const paint: PaintRect[] = [...(o.paint ?? [])];
  const levelPaint: (PaintRect & { y: number })[] = [];
  const surfaces: SurfaceRect[] = [...(o.surfaces ?? [])];
  const missions: MapMission[] = [];
  const lights: { x: number; z: number }[] = [];
  const tSurf: TerrainSurface[] = [
    { kind: 'deck', id: 'mega-ground', rect: { ...o.groundRect }, y: 0 },
    ...(o.extraTerrain ?? []),
  ];
  const levels: Terrain['levels'] = [{ id: 'ground', name: '지상', y: 0 }];
  const zones: ZoneInfo[] = [];
  let mech = false;
  const facilities: MechFacilityConfig[] = [];
  for (const z of o.zones) {
    const m = z.map;
    const { ns, dx, dz } = z;
    for (const ob of m.obstacles) {
      if (/^edge-w/.test(ob.id)) continue; // 서쪽 외벽은 도로와 연결되도록 연다
      if (z.side === 'east' && /^edge-e/.test(ob.id)) continue; // 동쪽 입구 구역은 동쪽 외벽도 연다
      obstacles.push(moveObstacle(ob, ns, dx, dz));
    }
    for (const s of m.slots) slots.push(moveSlot(s, ns, dx, dz));
    for (const p of m.paint) paint.push(movePaint(p, dx, dz));
    for (const p of m.levelPaint ?? []) levelPaint.push(movePaint(p, dx, dz));
    for (const s of m.surfaces) surfaces.push(moveSurface(s, dx, dz));
    for (const l of m.ceilingLights ?? []) lights.push({ x: l.x + dx, z: l.z + dz });
    if (m.terrain) {
      for (const s of m.terrain.surfaces) tSurf.push(moveTerrainSurface(s, ns, dx, dz));
      for (const l of m.terrain.levels) levels.push({ ...l, id: sx(ns, l.id), name: `${z.label} ${l.name}` });
    }
    for (const ms of m.missions) {
      const sp = ms.spawn ?? m.spawn;
      missions.push({
        ...ms,
        id: sx(ns, ms.id),
        name: `[${z.label}] ${ms.name}`,
        slotId: sx(ns, ms.slotId),
        ...(ms.mech?.facility ? { mech: { ...ms.mech, facility: sx(ns, ms.mech.facility) } } : {}),
        spawn: { ...sp, x: sp.x + dx, z: sp.z + dz },
      });
    }
    if (m.mech) mech = true;
    // 기계식 시설: 평행이동 + ID 네임스페이스 (시설 변환은 로컬 좌표 기반이라 이동만으로 충분)
    for (const f of m.mechFacilities ?? []) facilities.push({ ...f, id: sx(ns, f.id), x: f.x + dx, z: f.z + dz });
    zones.push({
      id: m.id,
      label: z.label,
      bounds: { minX: m.bounds.minX + dx, maxX: m.bounds.maxX + dx, minZ: m.bounds.minZ + dz, maxZ: m.bounds.maxZ + dz },
      entrance: z.side === 'east' ? { x: m.bounds.maxX + dx, z: (z.entranceZ ?? m.spawn.z) + dz, side: 'east' } : { x: m.bounds.minX + dx, z: (z.entranceZ ?? m.spawn.z) + dz, side: 'west' },
    });
  }
  return {
    id: o.id,
    name: o.name,
    desc: o.desc,
    bounds: o.bounds,
    env: { indoor: false, sky: 0x9ab4cc, ambient: 0.6 },
    spawn: o.spawn,
    terrain: { surfaces: tSurf, levels },
    levelPaint,
    provisional: true,
    mech,
    mechFacilities: facilities,
    surfaces,
    paint,
    obstacles,
    slots: slots as unknown as ParkingSlot[] as MapSlot[],
    missions,
    ceilingLights: lights.length ? lights : undefined,
    zones,
  };
}
