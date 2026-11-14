import type { Collider } from '../core/geometry';
import { MECH_LIMITS } from '../mech/limits';
import { STATION } from '../mech/machine';
import { frameOf, toWorldXZ, type Frame, type MechFacilityConfig } from '../mech/facility';
import { WHITE, YELLOW, wallBox } from './helpers';
import type { MapSlot, ObstacleDef, PaintRect, SurfaceRect } from './types';

/**
 * 기계식 주차 시설의 **맵 데이터 키트** (v0.5.3): 시설 로컬 좌표(승강장 STATION 기준)로 정의된 벽/기계실/가이드/볼라드/도색을
 * 시설 변환(위치 + 회전)으로 월드 좌표에 놓는다. 어느 맵이든 `facilityKit(cfg)` 결과를 합치면 같은 시설이 설치된다.
 * 회전은 90° 배수만 허용한다(바닥 면이 축 정렬 직사각형이라서).
 */
const px = STATION.palletX;
const guideIn = MECH_LIMITS.palletWidth / 2;
const GT = 0.3; // 가이드 두께(얇은 벽 금지 규칙)
export const GUIDE_H = 0.12;
const doorHalf = MECH_LIMITS.doorWidth / 2;
export const ROOM_HW = 3.3; // 승강장 안쪽 반폭
export const BOLLARD_R = 0.1;
export const BOLLARD_H = 0.95;
/** 좌우 차량 유도선(z=±LANE_Z, 폭 0.1m)의 바로 바깥쪽: 볼라드 안쪽 면 = 유도선 바깥 가장자리 (v0.5.3) */
export const LANE_Z = 1.15;
export const LANE_W = 0.1;
export const BOLLARD_Z = LANE_Z + LANE_W / 2 + BOLLARD_R; // = 1.30
export const BOLLARDS = [
  { id: 'bol-1n', x: -9.5, z: BOLLARD_Z },
  { id: 'bol-1s', x: -9.5, z: -BOLLARD_Z },
  { id: 'bol-2n', x: -13.0, z: BOLLARD_Z },
  { id: 'bol-2s', x: -13.0, z: -BOLLARD_Z },
];

/** 시설 풋프린트(구조물 + 진입로) — 로컬 직사각형. 배치 검증/사이트 탐색에 쓴다 */
export const FACILITY_FOOTPRINT = { minX: -19, maxX: 3, minZ: -8, maxZ: 8 } as const;
/** 구조물만(벽/기계실/기둥): 진입로 제외 */
export const FACILITY_STRUCTURE = { minX: -8, maxX: 2.6, minZ: -7.8, maxZ: 7.8 } as const;

export const PALLET_SLOT: MapSlot = { id: 'pallet', x: px, z: 0, w: MECH_LIMITS.palletWidth, l: MECH_LIMITS.palletLength, dir: Math.PI / 2, style: 'box' };
export const EXIT_SLOT: MapSlot = { id: 'exit-zone', x: -25, z: 0, w: 3.2, l: 6.2, dir: -Math.PI / 2, style: 'box' };

export interface FacilityKit {
  obstacles: ObstacleDef[];
  paint: PaintRect[];
  surfaces: SurfaceRect[];
}

/** 로컬 장애물 목록 (id 접두어 없음) */
function localObstacles(): ObstacleDef[] {
  return [
    // 승강장 측벽(안쪽 ±1.5) + 문틀 기둥(개구부 2.4m) + 안쪽 벽 — 턴테이블(길이 5.6m 팔레트 180° 회전)을 위해 안쪽 폭 6.6m (±3.3)
    wallBox('ms-wall-n', -2.9, ROOM_HW + GT / 2, 8.2, GT, 2.4, 'wall', 0xb9bcc0),
    wallBox('ms-wall-s', -2.9, -(ROOM_HW + GT / 2), 8.2, GT, 2.4, 'wall', 0xb9bcc0),
    wallBox('ms-front-n', STATION.doorX, (doorHalf + ROOM_HW + GT) / 2, 0.4, ROOM_HW + GT - doorHalf, 2.4, 'wall', 0x6d7176),
    wallBox('ms-front-s', STATION.doorX, -(doorHalf + ROOM_HW + GT) / 2, 0.4, ROOM_HW + GT - doorHalf, 2.4, 'wall', 0x6d7176),
    wallBox('ms-back', 1.65, 0, 0.9, 2 * (ROOM_HW + GT), 2.4, 'wall', 0xb9bcc0),
    // 기계실(저장 베이 하부) — 지상에서는 막혀 있다
    { id: 'ms-room-n', tag: 'building', shape: 'box', x: -2.9, z: ROOM_HW + GT + 1.8, w: 8.2, d: 3.6, h: 2.6, color: 0xc9ccd0 },
    { id: 'ms-room-s', tag: 'building', shape: 'box', x: -2.9, z: -(ROOM_HW + GT + 1.8), w: 8.2, d: 3.6, h: 2.6, color: 0xc9ccd0 },
    // 팔레트 사이드 가이드: 낮은 레일(h 0.12 < 지상고 0.2m) — 차체는 위로 지나가고 타이어가 타고 넘으면 mech.guideDrag 가 저항/경고. 센서 높이(0.55m) 아래라 PDC 미감지가 정상
    { id: 'pal-guide-n', tag: 'guide', shape: 'box', x: px, z: guideIn + GT / 2, w: MECH_LIMITS.palletLength, d: GT, h: GUIDE_H, color: YELLOW },
    { id: 'pal-guide-s', tag: 'guide', shape: 'box', x: px, z: -(guideIn + GT / 2), w: MECH_LIMITS.palletLength, d: GT, h: GUIDE_H, color: YELLOW },
    // 입구 금속 볼라드(강철 원통 기둥, 실제 충돌체 + PDC 감지): 진입로 좌우
    ...BOLLARDS.map((b) => ({ id: b.id, tag: 'bollard' as const, shape: 'cyl' as const, x: b.x, z: b.z, r: BOLLARD_R, h: BOLLARD_H })),
  ];
}

function localPaint(): PaintRect[] {
  return [
    { x: -9.0, z: 0, w: 0.3, d: 2.6, color: WHITE }, // 정지선
    { x: -18, z: 0, w: 24, d: 0.12, color: YELLOW }, // 진입 중앙선 (팔레트 중심선과 같은 z=0)
    { x: -11.6, z: LANE_Z, w: 8.8, d: LANE_W, color: WHITE }, // 좌/우 차량 유도선 (차폭 + 여유) — 볼라드가 바로 바깥쪽에 선다
    { x: -11.6, z: -LANE_Z, w: 8.8, d: LANE_W, color: WHITE },
    { x: -14.0, z: 0, w: 1.8, d: 0.22, color: WHITE }, // 전진 화살표 (축 + 머리)
    { x: -13.35, z: 0.28, w: 0.9, d: 0.2, rot: 0.75, color: WHITE },
    { x: -13.35, z: -0.28, w: 0.9, d: 0.2, rot: -0.75, color: WHITE },
    { x: -6.3, z: 0, w: 0.5, d: 2.4, color: YELLOW }, // 출입문 앞 노란 선
  ];
}

const isQuarterTurn = (yaw: number): boolean => Math.abs(Math.sin(yaw * 2)) < 1e-6;

/** 시설 설정으로 월드 좌표 데이터를 만든다. idPrefix 는 여러 시설의 id 충돌을 막는다(기본 시설은 접두어 없음) */
export function facilityKit(cfg: Pick<MechFacilityConfig, 'x' | 'z' | 'rotationY'>, opts: { idPrefix?: string; pad?: boolean } = {}): FacilityKit {
  if (!isQuarterTurn(cfg.rotationY)) throw new Error(`기계식 시설 회전은 90° 배수여야 합니다 (${cfg.rotationY})`);
  const f: Frame = frameOf(cfg);
  const pre = opts.idPrefix ?? '';
  const obstacles: ObstacleDef[] = localObstacles().map((o) => {
    const p = toWorldXZ(f, o.x, o.z);
    return { ...o, id: pre + o.id, x: p.x, z: p.z, ...(o.shape === 'box' ? { rot: (o.rot ?? 0) + f.yaw } : {}) };
  });
  const paint: PaintRect[] = localPaint().map((r) => {
    const p = toWorldXZ(f, r.x, r.z);
    return { ...r, x: p.x, z: p.z, rot: (r.rot ?? 0) + f.yaw };
  });
  const surfaces: SurfaceRect[] = [];
  if (opts.pad) {
    // 시설 바닥(콘크리트): 구조물 영역 + 진입 램프 앞 포장
    const S = FACILITY_STRUCTURE;
    const c = toWorldXZ(f, (S.minX + S.maxX) / 2, 0);
    const swap = Math.abs(Math.sin(f.yaw)) > 0.5;
    const w = S.maxX - S.minX;
    const d = S.maxZ - S.minZ;
    surfaces.push({ x: c.x, z: c.z, w: swap ? d : w, d: swap ? w : d, kind: 'concrete' });
    // 진입로(아스팔트): 출입문 앞 11m, 폭 6m
    const a = toWorldXZ(f, (FACILITY_FOOTPRINT.minX + S.minX) / 2, 0);
    const aw = S.minX - FACILITY_FOOTPRINT.minX;
    surfaces.push({ x: a.x, z: a.z, w: swap ? 6 : aw, d: swap ? aw : 6, kind: 'asphalt' });
  }
  return { obstacles, paint, surfaces };
}

/** 월드 좌표의 충돌 풋프린트(OBB) — 배치 검증용 */
export function footprintObb(cfg: Pick<MechFacilityConfig, 'x' | 'z' | 'rotationY'>, rect: { minX: number; maxX: number; minZ: number; maxZ: number } = FACILITY_FOOTPRINT, margin = 0): { x: number; z: number; rot: number; hw: number; hl: number } {
  const f = frameOf(cfg);
  const c = toWorldXZ(f, (rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2);
  return { x: c.x, z: c.z, rot: Math.PI / 2 + f.yaw, hw: (rect.maxZ - rect.minZ) / 2 + margin, hl: (rect.maxX - rect.minX) / 2 + margin };
}

/**
 * 카메라 가림 전용 물체 (v0.6.0): 셔터 위 상인방 + 작동 상태 LED 안내판은 차량이 닿지 않는 높이라 충돌체가 아니지만,
 * 승강장 안 팔레트 위 차량을 뒤에서 비추는 추적 카메라 시선을 가린다. 카메라 가림 보정(`CameraRig.colliders`)에만 넣는다.
 * 치수는 mechBuilder 의 상인방(doorH+0.15, 두께 0.3)·안내판(doorX-0.4, 중심 doorH+0.85, 높이 0.95, 폭 3.5)과 같다.
 */
export function facilityCameraOccluders(cfg: Pick<MechFacilityConfig, 'x' | 'z' | 'rotationY'>, idPrefix = ''): Collider[] {
  const f = frameOf(cfg);
  const dh = MECH_LIMITS.doorHeight;
  const cx = STATION.doorX - 0.15;
  const c = toWorldXZ(f, cx, 0);
  const swap = Math.abs(Math.sin(f.yaw)) > 0.5;
  const w = 0.6; // 로컬 x 두께 (상인방 0.3 + 안내판 뒷판 사이 포함)
  const d = MECH_LIMITS.doorWidth + 1.2; // 로컬 z 폭 (안내판 3.5m 보다 약간 넓게)
  return [{ kind: 'box', id: `${idPrefix}cam-occ-door-header`, tag: 'camera-only', x: c.x, z: c.z, w: swap ? d : w, d: swap ? w : d, rot: 0, y0: dh, h: 1.45 }];
}
