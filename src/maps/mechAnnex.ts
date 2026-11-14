// 기계식 주차 부속 구역 (v0.5.5): 시설을 놓을 자리가 없는 맵의 **바로 옆**에 마당을 붙이고 외벽에 문을 내 연결한다.
// - 기존 맵 데이터(원본 export)는 바꾸지 않는다: megapark 합성은 원본을 그대로 쓴다. 공개 맵 목록(MAPS)에서만 감싼다.
// - 시설 자체는 facilityKit/MechFacilityConfig 그대로(로직·모델은 시설 로컬 좌표). 여기서는 마당 지면/외벽/문/미션만 만든다.
// - 치수(마당 27×22m, 문 폭 6m)는 임시 배치다. 실제 시설 사양을 주장하지 않는다.
import { frameOf, makeFacility, toWorldXZ, type MechFacilityConfig } from '../mech/facility';
import type { MissionDef } from '../mission/parking';
import { wallBox } from './helpers';
import { FACILITY_FOOTPRINT, PALLET_SLOT, facilityKit } from './mechKit';
import type { DeckSurface } from './terrain';
import type { MapData, MapSlot, ObstacleDef } from './types';

export type AnnexSide = 'east' | 'west' | 'north' | 'south';

export interface AnnexOpts {
  /** 시설 id (맵 안에서 유일) */
  id: string;
  name: string;
  side: AnnexSide;
  /** 문 중심의 벽 방향 좌표 (east/west: z, north/south: x) */
  at: number;
  floors?: number;
  /** 문 폭 (기본 6m) */
  gateW?: number;
  /** 벽 안쪽으로 얼마나 깊이까지 벽체를 자를지 (외벽이 경계보다 안쪽에 있는 맵용, 기본 1.0m) */
  cutIn?: number;
  /** 입고 미션 출발 위치: 문 안쪽으로 떨어진 거리 (기본 9m) */
  spawnIn?: number;
}

/** 마당 깊이(경계 밖으로): 시설 풋프린트(22m) + 문 앞 여유 2.6m + 뒤 여유 2.4m */
export const ANNEX_DEPTH = 27;
/** 마당 반폭: 시설 풋프린트 ±8m + 여유 3m */
export const ANNEX_HALF = 11;
const WALL_T = 0.6;
/** 시설 원점까지 거리(경계에서): 문(벽 두께) + 2m + 진입로 19m */
const ORIGIN_OUT = WALL_T + 2 + -FACILITY_FOOTPRINT.minX;

const OUT: Record<AnnexSide, { ox: number; oz: number; yaw: number }> = {
  // 시설 로컬 +x(진입 방향) 가 바깥쪽을 향하도록 하는 회전. 로컬 +x → 월드 (cos yaw, −sin yaw)
  east: { ox: 1, oz: 0, yaw: 0 },
  west: { ox: -1, oz: 0, yaw: Math.PI },
  north: { ox: 0, oz: 1, yaw: -Math.PI / 2 },
  south: { ox: 0, oz: -1, yaw: Math.PI / 2 },
};

export interface AnnexGeom {
  facility: MechFacilityConfig;
  /** 마당(경계 밖) 사각형 */
  yard: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 문 통로(벽을 자르는 범위) */
  gate: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 문 안쪽 접근 자세(차체 중심, 바깥쪽을 바라봄) */
  approach: { x: number; z: number; heading: number };
  /** 바깥 방향 단위 벡터 */
  out: { x: number; z: number };
}

/** 부속 구역의 기하(순수 계산) — 맵 데이터/테스트/문서가 같은 값을 쓴다 */
export function annexGeom(bounds: MapData['bounds'], o: AnnexOpts): AnnexGeom {
  const d = OUT[o.side];
  const horizontal = d.ox !== 0;
  const edge = o.side === 'east' ? bounds.maxX : o.side === 'west' ? bounds.minX : o.side === 'north' ? bounds.maxZ : bounds.minZ;
  const sgn = horizontal ? d.ox : d.oz;
  const g = (o.gateW ?? 6) / 2;
  const cutIn = o.cutIn ?? 1.0;
  const far = edge + sgn * ANNEX_DEPTH;
  const rect = (u0: number, u1: number, v0: number, v1: number): AnnexGeom['yard'] =>
    horizontal ? { minX: Math.min(u0, u1), maxX: Math.max(u0, u1), minZ: v0, maxZ: v1 } : { minX: v0, maxX: v1, minZ: Math.min(u0, u1), maxZ: Math.max(u0, u1) };
  const origin = edge + sgn * ORIGIN_OUT;
  const facility = makeFacility({ id: o.id, name: o.name, x: horizontal ? origin : o.at, z: horizontal ? o.at : origin, rotationY: d.yaw, floors: o.floors ?? 6 });
  const inn = edge - sgn * (o.spawnIn ?? 9);
  // 진행 방향 = 바깥쪽: heading 0 = +z, π/2 = +x
  const heading = Math.atan2(d.ox, d.oz);
  return {
    facility,
    yard: rect(edge, far, o.at - ANNEX_HALF, o.at + ANNEX_HALF),
    gate: rect(edge - sgn * cutIn, edge + sgn * (WALL_T + 0.1), o.at - g, o.at + g),
    approach: { x: horizontal ? inn : o.at, z: horizontal ? o.at : inn, heading },
    out: { x: d.ox, z: d.oz },
  };
}

const isAxisBox = (ob: ObstacleDef): boolean => ob.shape === 'box' && Math.abs(Math.sin((ob.rot ?? 0) * 2)) < 1e-6;
const boxAabb = (ob: ObstacleDef): AnnexGeom['yard'] => {
  const swap = Math.abs(Math.sin(ob.rot ?? 0)) > 0.5;
  const w = (swap ? ob.d : ob.w) ?? 0;
  const dd = (swap ? ob.w : ob.d) ?? 0;
  return { minX: ob.x - w / 2, maxX: ob.x + w / 2, minZ: ob.z - dd / 2, maxZ: ob.z + dd / 2 };
};
const overlaps = (a: AnnexGeom['yard'], b: AnnexGeom['yard']): boolean => a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6 && a.minZ < b.maxZ - 1e-6 && a.maxZ > b.minZ + 1e-6;

/** 문 통로와 겹치는 지상 벽체를 잘라 문을 낸다. 벽이 아닌 물체가 통로에 있으면 배치 오류다(예외) */
export function cutGate(obstacles: readonly ObstacleDef[], gate: AnnexGeom['yard'], horizontal: boolean): ObstacleDef[] {
  const out: ObstacleDef[] = [];
  for (const ob of obstacles) {
    if ((ob.y0 ?? 0) > 0.5 || ob.shape !== 'box') {
      if ((ob.y0 ?? 0) <= 0.5 && ob.shape === 'cyl' && overlaps({ minX: ob.x - (ob.r ?? 0), maxX: ob.x + (ob.r ?? 0), minZ: ob.z - (ob.r ?? 0), maxZ: ob.z + (ob.r ?? 0) }, gate)) throw new Error(`기계식 부속 구역 문 자리에 물체가 있습니다: ${ob.id}`);
      out.push(ob);
      continue;
    }
    const bb = boxAabb(ob);
    if (!overlaps(bb, gate)) {
      out.push(ob);
      continue;
    }
    if (ob.tag !== 'wall' || !isAxisBox(ob)) throw new Error(`기계식 부속 구역 문 자리에 벽이 아닌 물체가 있습니다: ${ob.id} (${ob.tag})`);
    // 벽 방향(문 폭 방향)으로 두 조각. 벽 두께 방향 치수는 그대로 둔다
    const [lo, hi, g0, g1] = horizontal ? [bb.minZ, bb.maxZ, gate.minZ, gate.maxZ] : [bb.minX, bb.maxX, gate.minX, gate.maxX];
    const thick = horizontal ? bb.maxX - bb.minX : bb.maxZ - bb.minZ;
    const piece = (a: number, b: number, suffix: string): void => {
      if (b - a < 0.05) return;
      const c = (a + b) / 2;
      out.push({ ...ob, id: `${ob.id}~${suffix}`, rot: 0, x: horizontal ? ob.x : c, z: horizontal ? c : ob.z, w: horizontal ? thick : b - a, d: horizontal ? b - a : thick });
    };
    piece(lo, g0, 'a');
    piece(g1, hi, 'b');
  }
  return out;
}

/** 맵 옆에 기계식 주차 부속 구역을 붙인 새 맵 데이터를 돌려준다(원본은 그대로) */
export function withMechAnnex(map: MapData, o: AnnexOpts): MapData {
  const g = annexGeom(map.bounds, o);
  const horizontal = g.out.x !== 0;
  const f = g.facility;
  const pre = `${f.id}:`;
  const kit = facilityKit(f, { idPrefix: pre, pad: false });
  const y = g.yard;
  const cx = (y.minX + y.maxX) / 2;
  const cz = (y.minZ + y.maxZ) / 2;
  const w = y.maxX - y.minX;
  const d = y.maxZ - y.minZ;

  // 마당 외벽 3면(맵 쪽은 기존 외벽 + 문)
  const walls: ObstacleDef[] = [];
  const H = 1.4;
  const C = 0x8f8f8a;
  const far = horizontal ? (g.out.x > 0 ? y.maxX : y.minX) : g.out.z > 0 ? y.maxZ : y.minZ;
  if (horizontal) {
    walls.push(wallBox(`${pre}yard-far`, far + (g.out.x * WALL_T) / 2, cz, WALL_T, d + 2 * WALL_T, H, 'wall', C));
    walls.push(wallBox(`${pre}yard-a`, cx, y.minZ - WALL_T / 2, w, WALL_T, H, 'wall', C));
    walls.push(wallBox(`${pre}yard-b`, cx, y.maxZ + WALL_T / 2, w, WALL_T, H, 'wall', C));
  } else {
    walls.push(wallBox(`${pre}yard-far`, cx, far + (g.out.z * WALL_T) / 2, w + 2 * WALL_T, WALL_T, H, 'wall', C));
    walls.push(wallBox(`${pre}yard-a`, y.minX - WALL_T / 2, cz, WALL_T, d, H, 'wall', C));
    walls.push(wallBox(`${pre}yard-b`, y.maxX + WALL_T / 2, cz, WALL_T, d, H, 'wall', C));
  }

  const fr = frameOf(f);
  const pc = toWorldXZ(fr, PALLET_SLOT.x, PALLET_SLOT.z);
  const pallet: MapSlot = { ...PALLET_SLOT, id: `${pre}pallet`, x: pc.x, z: pc.z, dir: PALLET_SLOT.dir + f.rotationY };

  const mission: MissionDef & { spawn: NonNullable<MapData['spawn']> } = {
    id: `${map.id}-mech-in`,
    name: `기계식 전진 입고 (${f.name})`,
    kind: 'mech-in',
    slotId: pallet.id,
    desc: '문을 지나 옆 기계식 구역으로 들어가 팔레트 중앙에 정렬하고 앞바퀴를 정지 홈에 맞춘 뒤 P·주차브레이크·시동 OFF·하차(G)·입고(J). 2F A 슬롯.',
    parTimeSec: 150,
    timeLimitSec: 720,
    spawn: { x: g.approach.x, z: g.approach.z, heading: g.approach.heading },
    mech: { slot: '02A', mode: 'fwd', facility: f.id },
  };

  // 지형 맵: 마당도 지면 데크가 있어야 차가 설 수 있다(문 안쪽 통로와 겹치게 이어 붙인다)
  const yardDeck: DeckSurface = {
    kind: 'deck',
    id: `${pre}ground`,
    rect: { x: (Math.min(y.minX, g.gate.minX) + Math.max(y.maxX, g.gate.maxX)) / 2, z: (Math.min(y.minZ, g.gate.minZ) + Math.max(y.maxZ, g.gate.maxZ)) / 2, w: Math.max(y.maxX, g.gate.maxX) - Math.min(y.minX, g.gate.minX), d: Math.max(y.maxZ, g.gate.maxZ) - Math.min(y.minZ, g.gate.minZ) },
    y: 0,
  };

  const b = map.bounds;
  const { mechUnavailable: _drop, ...rest } = map;
  void _drop;
  return {
    ...rest,
    bounds: { minX: Math.min(b.minX, y.minX), maxX: Math.max(b.maxX, y.maxX), minZ: Math.min(b.minZ, y.minZ), maxZ: Math.max(b.maxZ, y.maxZ) },
    ...(map.env.indoor ? { env: { ...map.env, ceilingRect: map.env.ceilingRect ?? { ...b } } } : {}),
    mech: true,
    mechFacilities: [...(map.mechFacilities ?? []), f],
    annex: [...(map.annex ?? []), { facility: f.id, side: o.side, yard: y, gate: g.gate, approach: g.approach }],
    surfaces: [...map.surfaces, { x: cx, z: cz, w, d, kind: 'concrete' }, { x: (g.gate.minX + g.gate.maxX) / 2, z: (g.gate.minZ + g.gate.maxZ) / 2, w: g.gate.maxX - g.gate.minX, d: g.gate.maxZ - g.gate.minZ, kind: 'asphalt' }],
    paint: [...map.paint, ...kit.paint],
    obstacles: [...cutGate(map.obstacles, g.gate, horizontal), ...walls, ...kit.obstacles],
    slots: [...map.slots, pallet],
    missions: [...map.missions, mission],
    ...(map.terrain ? { terrain: { ...map.terrain, surfaces: [...map.terrain.surfaces, yardDeck] } } : {}),
  };
}
