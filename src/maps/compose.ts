import type { MechFacilityConfig } from '../mech/facility';
import type { ParkingSlot } from '../mission/parking';
import type { Rect2, Terrain, TerrainSurface } from './terrain';
import type { MapData, MapMission, MapSlot, ObstacleDef, PaintRect, RoadSeg, SurfaceRect } from './types';

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
  /**
   * 수직 이동(m). 음수 = 지하층: 구역 전체(바닥/충돌체/주차칸/도색/조명/미션 시작 위치)를 그 높이에 놓는다.
   * 지하 구역은 외벽을 모두 유지하고 `portal`(경사로가 들어오는 개구부)만 연다. 바닥은 지형 데크로, 지붕은 지상 데크(슬래브 렌더)로 만든다.
   */
  dy?: number;
  /** 지하 구역 개구부: 동쪽 외벽에서 로컬 z 중심 ± width/2 */
  portal?: { z: number; width: number };
  /** 층 이름 (예: 'B1') */
  levelName?: string;
}
export interface ZoneInfo {
  id: string;
  label: string;
  /** 월드 좌표 경계 */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 구역 입구(월드 좌표, 서쪽 가장자리 중앙 높이에서 도로와 연결) */
  entrance: { x: number; z: number; side: 'west' | 'east' };
  /** 구역 바닥 높이 (지하 구역은 음수) */
  y: number;
}

const sx = (ns: string, id: string): string => (ns ? `${ns}:${id}` : id);

function moveObstacle(o: ObstacleDef, ns: string, dx: number, dz: number, dy = 0): ObstacleDef {
  return { ...o, id: sx(ns, o.id), x: o.x + dx, z: o.z + dz, ...(dy ? { y0: (o.y0 ?? 0) + dy } : {}) };
}
function moveSlot(s: MapSlot, ns: string, dx: number, dz: number, dy = 0): MapSlot {
  return { ...s, id: sx(ns, s.id), x: s.x + dx, z: s.z + dz, ...(dy ? { y: (s.y ?? 0) + dy } : {}) };
}
const movePaint = <T extends PaintRect>(p: T, dx: number, dz: number): T => ({ ...p, x: p.x + dx, z: p.z + dz });
const moveSurface = (s: SurfaceRect, dx: number, dz: number): SurfaceRect => ({ ...s, x: s.x + dx, z: s.z + dz });

function moveTerrainSurface(s: TerrainSurface, ns: string, dx: number, dz: number, dy = 0): TerrainSurface {
  const id = sx(ns, s.id);
  if (s.kind === 'deck') {
    return {
      ...s,
      id,
      y: s.y + dy,
      rect: { ...s.rect, x: s.rect.x + dx, z: s.rect.z + dz },
      holes: s.holes?.map((h) => ('r' in h ? { ...h, cx: h.cx + dx, cz: h.cz + dz } : { ...h, x: h.x + dx, z: h.z + dz })),
    };
  }
  if (s.kind === 'ramp') return { ...s, id, x: s.x + dx, z: s.z + dz, y0: s.y0 + dy, y1: s.y1 + dy };
  return { ...s, id, cx: s.cx + dx, cz: s.cz + dz, y0: s.y0 + dy, y1: s.y1 + dy };
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
  /** 추가 terrain 면(예: 지하 진입 경사로) */
  extraTerrain?: TerrainSurface[];
  /** 지면 구멍(경사로 트렌치): ground deck 과 지면 메시에 같은 구멍을 낸다 */
  groundHoles?: Rect2[];
  roads?: RoadSeg[];
}

export function composeMap(o: ComposeOptions): MapData & { zones: ZoneInfo[] } {
  const obstacles: ObstacleDef[] = [...(o.extraObstacles ?? [])];
  const slots: MapSlot[] = [];
  const paint: PaintRect[] = [...(o.paint ?? [])];
  const levelPaint: (PaintRect & { y: number })[] = [];
  const surfaces: SurfaceRect[] = [...(o.surfaces ?? [])];
  const missions: MapMission[] = [];
  const lights: { x: number; z: number; y?: number }[] = [];
  const indoorZones: NonNullable<MapData['indoorZones']> = [];
  const tSurf: TerrainSurface[] = [
    { kind: 'deck', id: 'mega-ground', rect: { ...o.groundRect }, y: 0, holes: o.groundHoles?.map((h) => ({ ...h })) },
    ...(o.extraTerrain ?? []),
  ];
  const levels: Terrain['levels'] = [{ id: 'ground', name: '지상', y: 0 }];
  const zones: ZoneInfo[] = [];
  let mech = false;
  const facilities: MechFacilityConfig[] = [];
  for (const z of o.zones) {
    const m = z.map;
    const { ns, dx, dz } = z;
    const dy = z.dy ?? 0;
    const below = dy < 0;
    for (const ob of m.obstacles) {
      if (below) {
        // 지하 구역: 외벽을 유지하고 개구부(portal)가 있는 동쪽 벽만 두 조각으로 나눈다
        if (z.portal && /^edge-e/.test(ob.id)) {
          const b = m.bounds;
          const z0 = z.portal.z - z.portal.width / 2;
          const z1 = z.portal.z + z.portal.width / 2;
          const th = ob.w ?? 0.6;
          if (z0 > b.minZ) obstacles.push(moveObstacle({ ...ob, id: `${ob.id}-s`, z: (b.minZ + z0) / 2, d: z0 - b.minZ }, ns, dx, dz, dy));
          if (z1 < b.maxZ) obstacles.push(moveObstacle({ ...ob, id: `${ob.id}-n`, z: (z1 + b.maxZ) / 2, d: b.maxZ - z1 }, ns, dx, dz, dy));
          void th;
          continue;
        }
        obstacles.push(moveObstacle(ob, ns, dx, dz, dy));
        continue;
      }
      if (/^edge-w/.test(ob.id)) continue; // 서쪽 외벽은 도로와 연결되도록 연다
      if (z.side === 'east' && /^edge-e/.test(ob.id)) continue; // 동쪽 입구 구역은 동쪽 외벽도 연다
      obstacles.push(moveObstacle(ob, ns, dx, dz, dy));
    }
    for (const s of m.slots) slots.push(moveSlot(s, ns, dx, dz, dy));
    if (dy) for (const p of m.paint) levelPaint.push({ ...movePaint(p, dx, dz), y: dy });
    else for (const p of m.paint) paint.push(movePaint(p, dx, dz));
    for (const p of m.levelPaint ?? []) levelPaint.push({ ...movePaint(p, dx, dz), y: p.y + dy });
    if (dy) {
      // 바닥 = 지형 데크(슬래브로 그린다), 지붕 = 지상 높이의 데크 슬래브(아래에서 보이는 천장)
      m.surfaces.forEach((sf, i) => tSurf.push({ kind: 'deck', id: sx(ns, `floor${i}`), rect: { x: sf.x + dx, z: sf.z + dz, w: sf.w, d: sf.d }, y: dy, thickness: 0.4, render: true }));
      const b = m.bounds;
      const rect = { x: (b.minX + b.maxX) / 2 + dx, z: (b.minZ + b.maxZ) / 2 + dz, w: b.maxX - b.minX + 1.2, d: b.maxZ - b.minZ + 1.2 };
      if (below) {
        tSurf.push({ kind: 'deck', id: sx(ns, 'roof'), rect, y: 0, thickness: 0.3, render: true });
        indoorZones.push({ id: sx(ns, 'indoor'), rect, yMin: dy - 0.5, yMax: -0.2 });
      }
      levels.push({ id: sx(ns, z.levelName ?? 'L'), name: `${z.label} ${z.levelName ?? ''}`.trim(), y: dy });
    } else for (const s of m.surfaces) surfaces.push(moveSurface(s, dx, dz));
    const lightY = dy + (m.env.ceilingHeight ?? 2.9);
    for (const l of m.ceilingLights ?? []) lights.push({ x: l.x + dx, z: l.z + dz, ...(dy ? { y: lightY } : {}) });
    if (m.terrain) {
      for (const s of m.terrain.surfaces) tSurf.push(moveTerrainSurface(s, ns, dx, dz, dy));
      for (const l of m.terrain.levels) levels.push({ ...l, id: sx(ns, l.id), name: `${z.label} ${l.name}`, y: l.y + dy });
    }
    for (const ms of m.missions) {
      const sp = ms.spawn ?? m.spawn;
      missions.push({
        ...ms,
        id: sx(ns, ms.id),
        name: `[${z.label}] ${ms.name}`,
        slotId: sx(ns, ms.slotId),
        ...(ms.mech?.facility ? { mech: { ...ms.mech, facility: sx(ns, ms.mech.facility) } } : {}),
        spawn: { ...sp, x: sp.x + dx, z: sp.z + dz, ...(dy ? { y: (sp.y ?? 0) + dy } : {}) },
      });
    }
    if (m.mech) mech = true;
    // 기계식 시설: 평행이동 + ID 네임스페이스 (시설 변환은 로컬 좌표 기반이라 이동만으로 충분)
    for (const f of m.mechFacilities ?? []) facilities.push({ ...f, id: sx(ns, f.id), x: f.x + dx, z: f.z + dz });
    zones.push({
      id: m.id,
      label: z.label,
      bounds: { minX: m.bounds.minX + dx, maxX: m.bounds.maxX + dx, minZ: m.bounds.minZ + dz, maxZ: m.bounds.maxZ + dz },
      entrance: z.side === 'east' || z.portal ? { x: m.bounds.maxX + dx, z: (z.portal?.z ?? z.entranceZ ?? m.spawn.z) + dz, side: 'east' } : { x: m.bounds.minX + dx, z: (z.entranceZ ?? m.spawn.z) + dz, side: 'west' },
      y: dy,
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
    groundHoles: o.groundHoles,
    indoorZones: indoorZones.length ? indoorZones : undefined,
    roads: o.roads,
    zones,
  };
}
