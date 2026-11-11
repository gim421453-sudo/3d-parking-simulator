import { DEG, angleDiff, localToWorld, normAngle, worldToLocal, clamp } from '../core/math';

export type MissionKind = 'perpendicular-front' | 'perpendicular-reverse' | 'parallel' | 'mech-in' | 'mech-out';

/** 주차 구획. (x,z)=중심, w=가로(진행 방향에 수직), l=세로(진행 방향), dir=앞으로 주차할 때 차량 앞이 향하는 heading */
export interface ParkingSlot {
  id: string;
  x: number;
  z: number;
  w: number;
  l: number;
  dir: number;
  /** 다층 주차장: 이 주차칸 바닥 높이(m). 없으면 높이 조건 없음 */
  y?: number;
}

export interface CarFootprint {
  x: number; // 차체 중심
  z: number;
  heading: number;
  length: number;
  width: number;
  /** 차체 바닥(지면) 높이 — 다층 주차장 */
  y?: number;
}

/** 다층: 차량이 주차칸 층에 있다고 보는 높이 허용 오차(m) */
export const LEVEL_TOLERANCE = 0.6;

export const HEADING_TOLERANCE: Record<MissionKind, number> = {
  'perpendicular-front': 10 * DEG,
  'perpendicular-reverse': 10 * DEG,
  parallel: 8 * DEG,
  'mech-in': 10 * DEG,
  'mech-out': 12 * DEG,
};
export const CORNER_EPS = 0.02; // 선 두께 오차(m)
export const STOP_SPEED = 0.08; // m/s
export const HOLD_SECONDS = 1.5;

export interface ParkingCheck {
  corners: boolean[]; // 4개 모서리가 구획 안에 있는지
  allInside: boolean;
  /** 다층: 주차칸과 같은 층인가 (평면 맵은 항상 true) */
  levelOk: boolean;
  headingErrorRad: number;
  headingOk: boolean;
  lateralOffset: number; // 구획 중심선에서 가로로 벗어난 거리(차 중심)
  longOffset: number; // 구획 세로 방향 오프셋
  accuracy: number; // 0..100
  poseOk: boolean; // 모서리 + 방향 모두 만족 (정차 조건 제외)
}

export function expectedHeadings(kind: MissionKind, slot: ParkingSlot): number[] {
  switch (kind) {
    case 'perpendicular-front':
    case 'mech-in':
      return [slot.dir];
    case 'mech-out':
      return [slot.dir, normAngle(slot.dir + Math.PI)]; // 기계식은 후진 출고가 일반적 — 어느 쪽을 향해도 출구 구역 정차를 인정
    case 'perpendicular-reverse':
      return [normAngle(slot.dir + Math.PI)];
    case 'parallel':
      return [slot.dir, normAngle(slot.dir + Math.PI)];
  }
}

/** 차량 자세가 구획에 맞는지 검사. 중심점이 아니라 네 모서리를 전부 검사한다. */
export function evaluateParking(car: CarFootprint, slot: ParkingSlot, kind: MissionKind): ParkingCheck {
  const hw = car.width / 2;
  const hl = car.length / 2;
  const cornersLocal: [number, number][] = [
    [hw, hl],
    [-hw, hl],
    [-hw, -hl],
    [hw, -hl],
  ];
  const corners = cornersLocal.map(([lx, lz]) => {
    const w = localToWorld(car.x, car.z, car.heading, lx, lz);
    // 구획 로컬 좌표: 구획의 dir 기준 (x: 가로, z: 세로)
    const s = worldToLocal(slot.x, slot.z, slot.dir, w.x, w.z);
    return Math.abs(s.x) <= slot.w / 2 + CORNER_EPS && Math.abs(s.z) <= slot.l / 2 + CORNER_EPS;
  });
  // 다층 주차장: 주차칸의 층(높이)과 같은 층이어야 한다. 위/아래 층의 같은 평면 좌표는 성공이 아니다.
  const levelOk = slot.y === undefined || car.y === undefined || Math.abs(car.y - slot.y) <= LEVEL_TOLERANCE;
  const allInside = corners.every(Boolean) && levelOk;

  const exp = expectedHeadings(kind, slot);
  let headingErr = Infinity;
  for (const e of exp) headingErr = Math.min(headingErr, Math.abs(angleDiff(car.heading, e)));
  const tol = HEADING_TOLERANCE[kind];
  const headingOk = headingErr <= tol;

  const c = worldToLocal(slot.x, slot.z, slot.dir, car.x, car.z);
  const latMargin = Math.max(0.1, (slot.w - car.width) / 2);
  const longMargin = Math.max(0.1, (slot.l - car.length) / 2);
  const lat = 1 - clamp(Math.abs(c.x) / latMargin, 0, 1);
  const lon = 1 - clamp(Math.abs(c.z) / longMargin, 0, 1);
  const head = 1 - clamp(headingErr / tol, 0, 1);
  const accuracy = Math.round(100 * (0.4 * lat + 0.4 * head + 0.2 * lon));

  return {
    corners,
    allInside,
    levelOk,
    headingErrorRad: headingErr,
    headingOk,
    lateralOffset: c.x,
    longOffset: c.z,
    accuracy,
    poseOk: allInside && headingOk,
  };
}

export interface ScoreInput {
  accuracy: number; // 0..100
  timeSec: number;
  parTimeSec: number;
  collisions: number;
}
export interface ScoreResult {
  total: number;
  accuracyPoints: number;
  timePoints: number;
  collisionPenalty: number;
  stars: 1 | 2 | 3;
}

/** 점수: 정확도 500 + 시간 300 + 기본 200 - 충돌당 100 */
export function computeScore(i: ScoreInput): ScoreResult {
  const accuracyPoints = Math.round(i.accuracy * 5);
  const over = Math.max(0, i.timeSec - i.parTimeSec);
  const timePoints = Math.max(0, Math.round(300 - over * 3));
  const collisionPenalty = i.collisions * 100;
  const total = Math.max(0, 200 + accuracyPoints + timePoints - collisionPenalty);
  const stars: 1 | 2 | 3 = total >= 850 ? 3 : total >= 600 ? 2 : 1;
  return { total, accuracyPoints, timePoints, collisionPenalty, stars };
}

export type MissionStatus = 'running' | 'success' | 'failed';

/** 기계식 미션 옵션: 대상 보관 슬롯, 입고 방향, 미리 보관된 차량(출고 미션) */
export interface MechMissionOpts {
  slot: string;
  /** 시설 id (생략하면 맵의 첫 번째 시설) */
  facility?: string;
  mode?: 'fwd' | 'rev';
  seed?: { slot: string; specId: string; mode: 'fwd' | 'rev' }[];
}

export interface MissionDef {
  id: string;
  mech?: MechMissionOpts;
  name: string;
  kind: MissionKind;
  slotId: string;
  desc: string;
  parTimeSec: number;
  timeLimitSec: number;
}

/** 미션 진행기: 자세 조건 + 정차 유지 시간을 만족해야 성공. 순수 로직(렌더링 의존 없음). */
export class MissionRunner {
  status: MissionStatus = 'running';
  elapsed = 0;
  collisions = 0;
  hold = 0;
  check: ParkingCheck | null = null;
  score: ScoreResult | null = null;
  failReason = '';

  constructor(
    readonly def: MissionDef,
    readonly slot: ParkingSlot,
  ) {}

  addCollision(): void {
    if (this.status === 'running') this.collisions++;
  }

  giveUp(): void {
    if (this.status === 'running') {
      this.status = 'failed';
      this.failReason = '미션을 포기했습니다';
    }
  }

  update(dt: number, car: CarFootprint, speed: number): void {
    if (this.status !== 'running') return;
    this.elapsed += dt;
    this.check = evaluateParking(car, this.slot, this.def.kind);
    if (this.check.poseOk && Math.abs(speed) < STOP_SPEED) this.hold += dt;
    else this.hold = 0;
    if (this.hold >= HOLD_SECONDS) {
      this.status = 'success';
      this.score = computeScore({
        accuracy: this.check.accuracy,
        timeSec: this.elapsed,
        parTimeSec: this.def.parTimeSec,
        collisions: this.collisions,
      });
    } else if (this.elapsed >= this.def.timeLimitSec) {
      this.status = 'failed';
      this.failReason = '제한 시간이 끝났습니다';
    }
  }
}
