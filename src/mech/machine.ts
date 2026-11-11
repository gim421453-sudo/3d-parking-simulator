import { DEG, angleDiff, localToWorld, worldToLocal } from '../core/math';
import type { VehicleSpec } from '../vehicle/spec';
import { MECH_LIMITS, checkVehicleLimits } from './limits';

/**
 * 승강기식(팔레트형) 기계식 주차타워 — 순수 로직(렌더링/물리 의존 없음). v0.5.2: 12층 다중 슬롯.
 *
 * 구조(맵 `mechpark`, 월드 좌표):
 *  - 1F 승강장: 팔레트 중심 (PALLET_X, 0), 길이 방향 = 월드 x, 폭 방향 = 월드 z. 바퀴 홈 2개(z=±GROOVE).
 *  - 승강 **캐리지**(플랫폼)는 4개 모서리 기둥의 가이드 레일을 따라 y 로 승강하고, 층마다 좌(A)/우(B) 슬롯으로 수평 이송(z)한다.
 *  - **팔레트(차량 지지)는 캐리지와 별개**: 입고하면 팔레트+차량이 슬롯에 남고, 캐리지는 빈 채로 1F 로 복귀한다(승강장에는 새 빈 팔레트가 공급된다).
 *    출고하면 빈 캐리지가 올라가 팔레트+차량을 인출해 1F 로 내려온다.
 *  - 보관층 2F~12F(층고 3.0m) × A/B = 22 슬롯. 슬롯 점유/차량 정보는 `MachineState.slots` 에 별도로 보관한다.
 * 이 장치는 시뮬레이션용 가상 사양이며 법규 적합 인증을 주장하지 않는다 (`limits.ts`).
 */
export const FLOOR_H = 3.0;
export const TOP_FLOOR = 12;
export const STATION = {
  doorX: -7.0,
  palletX: -2.4, // 팔레트 중심 x (승강장 위치)
  /** 기준 차축(전진 입고=앞차축, 후진 입고=뒷차축) 중심이 이 x 에 오면 정위치 */
  stopperX: -0.65,
  /** 정위치 인정 허용 */
  stopperTol: 0.2,
  heading: Math.PI / 2,
} as const;

export type Side = 'A' | 'B';
export interface SlotDef {
  id: string;
  floor: number;
  side: Side;
  /** 슬롯 바닥 높이(캐리지 y) */
  y: number;
  /** 수평 이송 위치(캐리지 z) */
  z: number;
}
export const SLOT_Z = 3.6;
export const floorY = (floor: number): number => (floor - 1) * FLOOR_H;
export const floorLabel = (floor: number): string => `${String(floor).padStart(2, '0')}F`;
export const slotIdOf = (floor: number, side: Side): string => `${String(floor).padStart(2, '0')}${side}`;
/** 2F~12F × A/B = 22 슬롯 (A = +z, B = -z) */
export const SLOTS: SlotDef[] = [];
for (let f = 2; f <= TOP_FLOOR; f++) for (const side of ['A', 'B'] as const) SLOTS.push({ id: slotIdOf(f, side), floor: f, side, y: floorY(f), z: side === 'A' ? SLOT_Z : -SLOT_Z });
export const slotDef = (id: string): SlotDef => {
  const s = SLOTS.find((q) => q.id === id);
  if (!s) throw new Error(`unknown slot ${id}`);
  return s;
};
export const isSlotId = (id: string): boolean => SLOTS.some((q) => q.id === id);

/** 정렬 허용 오차 */
export const ALIGN_TOL = { lateral: 0.12, heading: 3 * DEG, stopSpeed: 0.08 };

/** 입고 방향: 전진(앞차축이 정지 홈) / 후진(뒷차축이 정지 홈) */
export type EntryMode = 'fwd' | 'rev';
/** 차량이 +x(팔레트 안쪽)를 향하면 전진 입고, -x 를 향하면(후진해서 들어옴) 후진 입고 */
export const entryModeOf = (heading: number): EntryMode => (Math.cos(angleDiff(heading, STATION.heading)) >= 0 ? 'fwd' : 'rev');
export const entryHeading = (mode: EntryMode): number => (mode === 'fwd' ? STATION.heading : STATION.heading + Math.PI);

export interface AlignInput {
  /** 뒷축 중심 (월드) */
  x: number;
  z: number;
  heading: number;
  v: number;
  gear: 'P' | 'R' | 'N' | 'D';
  handbrake: boolean;
  /** 시동이 걸려 있거나 걸리는 중 (입고/하차 전에는 시동 OFF 여야 한다) */
  engineOn?: boolean;
}

export interface Alignment {
  mode: EntryMode;
  /** 팔레트 중심선에서 차체의 좌우 오프셋 (m, 월드 z 부호) */
  lateral: number;
  headingErrDeg: number;
  /** 4개 바퀴가 각 홈 안(타이어가 가이드를 침범하지 않음)에 있는가 */
  wheelsInGrooves: boolean;
  /** 타이어가 사이드 가이드를 침범한 바퀴 (FL FR RL RR) */
  guideInvasion: [boolean, boolean, boolean, boolean];
  /** 기준 차축이 정지 홈에 정렬되었는가 */
  atStopper: boolean;
  /** 기준 차축과 정지 위치의 거리 (+: 정지 위치까지 남음, −: 지나침) */
  stopperGap: number;
  /** 차량이 팔레트 위(뒤쪽 차축까지)에 완전히 올라왔는가 */
  onPallet: boolean;
  /** 좌우 가이드와 타이어 바깥쪽의 간격 (m) */
  guideGapL: number;
  guideGapR: number;
}

function wheelWorld(s: AlignInput, wx: number, wz: number): { px: number; pz: number } {
  const w = localToWorld(s.x, s.z, s.heading, wx, wz);
  return { px: w.x - STATION.palletX, pz: w.z };
}

export function alignment(spec: VehicleSpec, s: AlignInput): Alignment {
  const mode = entryModeOf(s.heading);
  const half = spec.trackWidth / 2;
  const wb = spec.wheelbase;
  const wheels = [wheelWorld(s, +half, wb), wheelWorld(s, -half, wb), wheelWorld(s, +half, 0), wheelWorld(s, -half, 0)];
  const guideInner = MECH_LIMITS.palletWidth / 2;
  const guideInvasion = wheels.map((w) => Math.abs(w.pz) + MECH_LIMITS.tireHalfWidth > guideInner) as [boolean, boolean, boolean, boolean];
  const grooveIn = MECH_LIMITS.grooveOffset - MECH_LIMITS.grooveHalfWidth - 0.02;
  const wheelsInGrooves = wheels.every((w) => Math.abs(w.pz) + MECH_LIMITS.tireHalfWidth <= guideInner && Math.abs(w.pz) - MECH_LIMITS.tireHalfWidth >= grooveIn - 0.1) && wheels[0].pz * wheels[1].pz < 0;
  const frontX = (wheels[0].px + wheels[1].px) / 2 + STATION.palletX;
  const rearX = (wheels[2].px + wheels[3].px) / 2 + STATION.palletX;
  // 기준 차축: 전진 입고는 앞차축, 후진 입고는 뒷차축(후진으로 들어올 때 안쪽을 향하는 차축)
  const refX = mode === 'fwd' ? frontX : rearX;
  const trailX = mode === 'fwd' ? rearX : frontX;
  const stopperGap = STATION.stopperX - refX;
  const onPallet = trailX - STATION.palletX > -MECH_LIMITS.palletLength / 2 + 0.6 && stopperGap > -0.9;
  const cx = (wheels[0].pz + wheels[1].pz + wheels[2].pz + wheels[3].pz) / 4;
  const maxL = Math.max(wheels[0].pz, wheels[2].pz);
  const minR = Math.min(wheels[1].pz, wheels[3].pz);
  return {
    mode,
    lateral: cx,
    headingErrDeg: Math.abs(angleDiff(s.heading, entryHeading(mode))) / DEG,
    wheelsInGrooves,
    guideInvasion,
    atStopper: Math.abs(stopperGap) <= STATION.stopperTol,
    stopperGap,
    onPallet,
    guideGapL: guideInner - (maxL + MECH_LIMITS.tireHalfWidth),
    guideGapR: guideInner - (-minR + MECH_LIMITS.tireHalfWidth),
  };
}

/**
 * 낮은 정지턱(높이 약 6cm)을 바퀴가 타고 넘을 때의 **약한 저항**(m/s², 진행 반대 방향). 차량을 멈춰 세우지 않는다.
 * 기준 차축이 정지 홈 ±0.14m 구간(턱)에 있을 때만 작용하고, 저속(≥0.35m/s)이면 그냥 넘어간다.
 */
export const BUMP = { halfWidth: 0.14, decel: 0.25 };
export function bumpDecel(spec: VehicleSpec, s: AlignInput): number {
  const a = alignment(spec, s);
  if (!a.onPallet || Math.abs(a.lateral) > MECH_LIMITS.palletWidth / 2) return 0;
  return Math.abs(a.stopperGap) <= BUMP.halfWidth ? BUMP.decel : 0;
}

export type CheckKey = 'size' | 'centered' | 'heading' | 'grooves' | 'guides' | 'wheelPos' | 'stopped' | 'parked' | 'engine' | 'occupant' | 'door' | 'slot';
export interface CheckItem {
  key: CheckKey;
  label: string;
  ok: boolean;
}

export type Phase =
  | 'waiting'
  | 'closing'
  | 'lifting' // 입고: 차량+팔레트를 실은 캐리지 상승
  | 'storing' // 입고: 슬롯으로 수평 이송 후 팔레트 안치
  | 'returning' // 입고 후: 빈 캐리지 1F 복귀
  | 'restocking' // 승강장에 새 빈 팔레트 공급
  | 'calling' // 출고: 빈 캐리지 상승
  | 'pulling' // 출고: 슬롯에서 팔레트+차량 인출
  | 'lowering' // 출고: 1F 로 하강
  | 'rotating' // 출고: 턴테이블 180° (전진 입고 차량만)
  | 'opening'
  | 'exit'
  | 'estop';

export const TIMES = { door: 2.5, liftSpeed: 3.0, liftMin: 1.2, transfer: 3.0, retract: 2.2, restock: 1.5, rotate: 4.0 };

export interface StoredCar {
  carId: number;
  specId: string;
  mode: EntryMode;
  /** 팔레트 로컬 좌표의 차량 상대 pose (회전 yaw 는 별도) */
  rel: { x: number; z: number; heading: number };
  since: number;
}

export type PalletLoc = 'station' | 'carriage' | 'slot' | 'none';
export interface MachineEvent {
  type: 'stored' | 'picked' | 'retrieved' | 'rejected';
  slot?: string;
  carId?: number;
  reason?: string;
}

export interface MachineState {
  phase: Phase;
  /** estop 해제 시 돌아갈 단계 */
  resume: Phase | null;
  /** 진행 단계의 경과 시간 */
  t: number;
  /** 문 열림 정도 0(닫힘)..1(열림) */
  door: number;
  /** 진행 중인 작업 */
  op: { kind: 'store' | 'retrieve'; slot: string } | null;
  /** 승강 캐리지 위치 (y: 높이, z: 수평 이송) */
  carriage: { y: number; z: number };
  /** 승강장(캐리지) 위 팔레트의 상태: 승강장 지면 / 캐리지 위(차량 탑재 중) / 없음(보관 중 또는 호출 중) */
  palletLoc: PalletLoc;
  /** 캐리지 위 팔레트에 차량이 실려 있는가 */
  carOnPallet: boolean;
  /** 턴테이블 회전각(rad, 0..π) */
  yaw: number;
  occupant: 'in' | 'out';
  /** 차량이 팔레트에 고정(승강/이송 중)되어 운전 불가인가 */
  locked: boolean;
  /** 현재 팔레트 위 차량의 입고 방향 */
  entryMode: EntryMode;
  /** 경고/거부 메시지(HUD) */
  message: string;
  cycles: number;
  /** 문 안전센서 감지 */
  doorBlocked: boolean;
  /** 승강장 위 차량의 팔레트 기준 상대 pose */
  rel: { x: number; z: number; heading: number } | null;
  /** 이 시설의 층수(2F~floors 가 보관층). 슬롯 키는 이 층수까지만 존재한다 */
  floors: number;
  /** 슬롯별 보관 차량 (null = 비어 있음) */
  slots: Record<string, StoredCar | null>;
  /** 호출/출고 대상 차량의 입고 정보 */
  carrying: StoredCar | null;
  nextCarId: number;
  /** 오류/고장 표시(상태기계 불변식 위반 시) */
  fault: string;
  /** 소비되지 않은 이벤트 */
  events: MachineEvent[];
  /** 누적 시간 */
  clock: number;
}

/** floors: 시설 층수(2~12). 기본 12층 타워 */
export function newMachine(floors: number = TOP_FLOOR): MachineState {
  const fl = Math.min(TOP_FLOOR, Math.max(2, Math.round(floors)));
  const slots: Record<string, StoredCar | null> = {};
  for (const s of SLOTS) if (s.floor <= fl) slots[s.id] = null;
  return {
    phase: 'waiting',
    resume: null,
    t: 0,
    door: 1,
    op: null,
    carriage: { y: 0, z: 0 },
    palletLoc: 'station',
    carOnPallet: false,
    yaw: 0,
    occupant: 'in',
    locked: false,
    entryMode: 'fwd',
    message: '',
    cycles: 0,
    doorBlocked: false,
    rel: null,
    floors: fl,
    slots,
    carrying: null,
    nextCarId: 1,
    fault: '',
    events: [],
    clock: 0,
  };
}

/** 이 시설에 존재하는 슬롯 */
export const slotsOf = (m: MachineState): SlotDef[] => SLOTS.filter((s) => s.id in m.slots);
export const hasSlot = (m: MachineState, id: string): boolean => isSlotId(id) && id in m.slots;
export const freeSlots = (m: MachineState): SlotDef[] => slotsOf(m).filter((s) => !m.slots[s.id]);
export const occupiedSlots = (m: MachineState): SlotDef[] => slotsOf(m).filter((s) => !!m.slots[s.id]);

/** 입고 시작 조건 체크리스트 (HUD/테스트 공용) */
export function checklist(spec: VehicleSpec, s: AlignInput, m: MachineState, slot?: string): CheckItem[] {
  const a = alignment(spec, s);
  const lim = checkVehicleLimits(spec);
  const stopped = Math.abs(s.v) < ALIGN_TOL.stopSpeed;
  const items: CheckItem[] = [
    { key: 'size', label: '차량 치수/중량 허용', ok: lim.ok },
    { key: 'centered', label: `팔레트 중앙 정렬 (±${(ALIGN_TOL.lateral * 100).toFixed(0)}cm)`, ok: Math.abs(a.lateral) <= ALIGN_TOL.lateral },
    { key: 'heading', label: `방향 정렬 (±${(ALIGN_TOL.heading / DEG).toFixed(0)}°)`, ok: a.headingErrDeg <= ALIGN_TOL.heading / DEG },
    { key: 'grooves', label: '4개 바퀴가 홈 안', ok: a.wheelsInGrooves },
    { key: 'guides', label: '가이드 간섭 없음', ok: !a.guideInvasion.some(Boolean) },
    { key: 'wheelPos', label: a.mode === 'fwd' ? '앞바퀴 정지 위치' : '뒷바퀴 정지 위치', ok: a.atStopper && a.onPallet },
    { key: 'stopped', label: '정차', ok: stopped },
    { key: 'parked', label: 'P 단 + 주차 브레이크', ok: s.gear === 'P' && s.handbrake },
    { key: 'engine', label: '시동 OFF', ok: !s.engineOn },
    { key: 'occupant', label: '운전자 하차', ok: m.occupant === 'out' },
    { key: 'door', label: '출입문 안전센서 정상', ok: !m.doorBlocked },
  ];
  if (slot !== undefined) items.push({ key: 'slot', label: `${slot} 슬롯 사용 가능`, ok: hasSlot(m, slot) && !m.slots[slot] });
  return items;
}

export function canStart(spec: VehicleSpec, s: AlignInput, m: MachineState, slot?: string): { ok: boolean; failed: CheckItem[] } {
  if (m.phase !== 'waiting' || m.palletLoc !== 'station') return { ok: false, failed: [] };
  const failed = checklist(spec, s, m, slot).filter((c) => !c.ok);
  return { ok: failed.length === 0, failed };
}

/** 운전자 하차/탑승 전환 — 정차 + P + 주차 브레이크 상태에서만 하차 가능 (사람 감지가 아니라 게임 상태) */
export function toggleOccupant(s: AlignInput, m: MachineState): { ok: boolean; reason: string } {
  if (m.locked) return { ok: false, reason: '장치 동작 중에는 승하차할 수 없습니다' };
  if (m.occupant === 'in') {
    if (Math.abs(s.v) >= ALIGN_TOL.stopSpeed) return { ok: false, reason: '정차 후 하차하세요' };
    if (s.gear !== 'P' || !s.handbrake) return { ok: false, reason: 'P 단 + 주차 브레이크 후 하차하세요' };
    if (s.engineOn) return { ok: false, reason: '시동을 끈(OFF) 뒤 하차하세요 — 브레이크를 밟고 시동 버튼(O)' };
    m.occupant = 'out';
    return { ok: true, reason: '하차했습니다' };
  }
  m.occupant = 'in';
  return { ok: true, reason: '탑승했습니다' };
}

const reject = (m: MachineState, reason: string): false => {
  m.message = reason;
  m.events.push({ type: 'rejected', reason });
  return false;
};

/** 입고 시작. 조건이 안 맞으면 거부하고 이유를 message 에 남긴다. slot 은 사용 가능한 보관 슬롯이어야 한다 */
export function startStore(spec: VehicleSpec, s: AlignInput, m: MachineState, slot: string): boolean {
  if (!hasSlot(m, slot)) return reject(m, `입고 불가: 이 시설에 없는 슬롯 ${slot}`);
  if (m.phase !== 'waiting' || m.palletLoc !== 'station') return reject(m, '입고 불가: 장치가 사용 중입니다');
  if (m.slots[slot]) return reject(m, `입고 불가: ${slot} 슬롯이 이미 사용 중입니다 — 다른 슬롯을 선택하세요`);
  const lim = checkVehicleLimits(spec);
  if (!lim.ok) return reject(m, `입고 불가: ${lim.reasons.join(', ')}`);
  const c = canStart(spec, s, m, slot);
  if (!c.ok) return reject(m, `입고 불가: ${c.failed.map((f) => f.label).join(', ')}`);
  const a = alignment(spec, s);
  m.op = { kind: 'store', slot };
  m.phase = 'closing';
  m.t = 0;
  m.locked = true;
  m.carOnPallet = true;
  m.entryMode = a.mode;
  const rel = worldToLocal(STATION.palletX, 0, STATION.heading, s.x, s.z);
  m.rel = { x: rel.x, z: rel.z, heading: s.heading - STATION.heading };
  m.message = '출입문을 닫는 중';
  return true;
}

/** 출고 요청: 해당 슬롯에 보관된 차량을 호출한다. 승강장이 비어 있고 대기 상태여야 한다 */
export function requestRetrieve(m: MachineState, slot: string): boolean {
  if (!hasSlot(m, slot)) return reject(m, `출고 불가: 이 시설에 없는 슬롯 ${slot}`);
  if (m.phase !== 'waiting') return reject(m, '출고 불가: 장치가 동작 중입니다');
  const car = m.slots[slot];
  if (!car) return reject(m, `출고 불가: ${slot} 슬롯에 보관된 차량이 없습니다`);
  if (m.carOnPallet || m.locked) return reject(m, '출고 불가: 승강장에 차량이 있습니다 — 먼저 입고하거나 이동하세요');
  m.op = { kind: 'retrieve', slot };
  m.carrying = car;
  m.phase = 'closing';
  m.t = 0;
  m.message = `${slot} 차량을 호출합니다`;
  return true;
}

/** 입고/출고 취소: 문이 닫히기 시작한 직후(승강 전)에만 가능 */
export function cancelOp(m: MachineState): boolean {
  if (m.phase !== 'closing') {
    m.message = '취소 불가: 승강이 시작되었습니다';
    return false;
  }
  m.phase = 'opening';
  m.t = 0;
  if (m.op?.kind === 'store') {
    m.locked = false;
    m.carOnPallet = false;
    m.rel = null;
    m.occupant = 'out'; // 운전자는 아직 차 밖
  }
  m.op = null;
  m.carrying = null;
  m.message = '작업을 취소했습니다';
  return true;
}

export function emergencyStop(m: MachineState): void {
  if (m.phase === 'estop' || m.phase === 'waiting' || m.phase === 'exit') return;
  m.resume = m.phase;
  m.phase = 'estop';
  m.message = '비상 정지';
}
export function emergencyRelease(m: MachineState): void {
  if (m.phase !== 'estop' || !m.resume) return;
  m.phase = m.resume;
  m.resume = null;
  m.message = '비상 정지 해제 — 재개';
}

/** 캐리지 y 이동 시간(초) */
export const liftTime = (dy: number): number => Math.max(TIMES.liftMin, Math.abs(dy) / TIMES.liftSpeed);
/** 입고 한 사이클 대략 시간(문 닫힘 제외): 상승 + 이송 + 복귀 */
export const storeDuration = (slot: string): number => liftTime(slotDef(slot).y) + TIMES.transfer + TIMES.retract + liftTime(slotDef(slot).y) + TIMES.restock;
export const retrieveDuration = (slot: string, needRotate: boolean): number => liftTime(slotDef(slot).y) + TIMES.transfer + liftTime(slotDef(slot).y) + (needRotate ? TIMES.rotate : 0) + TIMES.door;

const moveTo = (cur: number, target: number, speed: number, dt: number): number => (Math.abs(target - cur) <= speed * dt ? target : cur + Math.sign(target - cur) * speed * dt);

/**
 * 시간 진행. `doorClear`: 문 구역에 차량/물체가 없는가 — 안전센서 입력.
 * 캐리지 위치/문 개폐도/회전각을 갱신하고, 입고·출고 완료 시 이벤트를 남긴다.
 */
export function stepMachine(m: MachineState, dt: number, doorClear: boolean): void {
  m.clock += dt;
  if (m.phase === 'estop') return;
  m.doorBlocked = !doorClear && (m.phase === 'waiting' || m.phase === 'closing');
  const rate = dt / TIMES.door;
  const op = m.op;
  switch (m.phase) {
    case 'closing':
      if (!doorClear) {
        m.door = Math.min(1, m.door + rate * 2); // 안전센서: 닫히던 문이 다시 열린다
        m.message = '출입문 안전센서 감지 — 닫힘 정지';
        break;
      }
      m.door = Math.max(0, m.door - rate);
      if (m.door <= 0 && op) {
        m.t = 0;
        if (op.kind === 'store') {
          m.phase = 'lifting';
          m.palletLoc = 'carriage';
          m.message = `입고 중 — ${floorLabel(slotDef(op.slot).floor)} 이동`;
        } else {
          m.phase = 'calling';
          m.palletLoc = 'none'; // 승강장의 빈 팔레트는 보관되고 빈 캐리지만 상승
          m.message = `출고 중 — ${floorLabel(slotDef(op.slot).floor)} 차량 호출`;
        }
      }
      break;
    case 'lifting': {
      if (m.door > 0 || !op) break; // 인터록: 문이 완전히 닫혀야 승강 가능
      const sd = slotDef(op.slot);
      m.carriage.y = moveTo(m.carriage.y, sd.y, TIMES.liftSpeed, dt);
      if (m.carriage.y >= sd.y) {
        m.phase = 'storing';
        m.t = 0;
        m.message = `입고 중 — ${floorLabel(sd.floor)} 보관`;
      }
      break;
    }
    case 'storing': {
      if (!op) break;
      const sd = slotDef(op.slot);
      m.carriage.z = moveTo(m.carriage.z, sd.z, Math.abs(sd.z) / TIMES.transfer, dt);
      if (m.carriage.z === sd.z) {
        // 팔레트+차량을 슬롯에 안치 (캐리지는 비게 된다)
        const car: StoredCar = { carId: m.nextCarId++, specId: '', mode: m.entryMode, rel: { ...m.rel! }, since: m.clock };
        m.slots[op.slot] = car;
        m.events.push({ type: 'stored', slot: op.slot, carId: car.carId });
        m.palletLoc = 'none';
        m.carOnPallet = false;
        m.locked = false;
        m.rel = null;
        m.phase = 'returning';
        m.t = 0;
        m.message = '플랫폼 복귀 중 — 01F';
      }
      break;
    }
    case 'returning': {
      // 빈 캐리지: 먼저 수평 복귀, 그다음 하강
      if (Math.abs(m.carriage.z) > 1e-9) m.carriage.z = moveTo(m.carriage.z, 0, SLOT_Z / TIMES.retract, dt);
      else m.carriage.y = moveTo(m.carriage.y, 0, TIMES.liftSpeed, dt);
      if (m.carriage.z === 0 && m.carriage.y === 0) {
        m.phase = 'restocking';
        m.t = 0;
        m.message = '플랫폼 복귀 중 — 01F';
      }
      break;
    }
    case 'restocking':
      m.t += dt;
      if (m.t >= TIMES.restock) {
        m.palletLoc = 'station';
        m.op = null;
        m.yaw = 0;
        m.occupant = 'in';
        m.door = Math.max(m.door, 0);
        m.phase = 'opening';
        m.t = 0;
        m.message = '출입문을 여는 중';
        m.cycles++;
      }
      break;
    case 'calling': {
      if (m.door > 0 || !op) break;
      const sd = slotDef(op.slot);
      m.carriage.y = moveTo(m.carriage.y, sd.y, TIMES.liftSpeed, dt);
      if (m.carriage.y >= sd.y) {
        m.phase = 'pulling';
        m.t = 0;
        m.message = `출고 중 — ${floorLabel(sd.floor)} 인출`;
      }
      break;
    }
    case 'pulling': {
      if (!op) break;
      const sd = slotDef(op.slot);
      // 캐리지가 슬롯으로 나가 팔레트+차량을 싣고 복귀: 먼저 슬롯 쪽으로, 그다음 되돌아옴
      if (m.palletLoc === 'none' && m.slots[op.slot]) {
        m.carriage.z = moveTo(m.carriage.z, sd.z, Math.abs(sd.z) / TIMES.transfer, dt);
        if (m.carriage.z === sd.z) {
          m.carrying = m.slots[op.slot];
          m.slots[op.slot] = null;
          m.palletLoc = 'carriage';
          m.carOnPallet = true;
          m.rel = { ...m.carrying!.rel };
          m.locked = true;
          m.entryMode = m.carrying!.mode;
          m.occupant = 'out';
          m.events.push({ type: 'picked', slot: op.slot, carId: m.carrying!.carId });
        }
      } else {
        m.carriage.z = moveTo(m.carriage.z, 0, Math.abs(sd.z) / TIMES.retract, dt);
        if (m.carriage.z === 0) {
          m.phase = 'lowering';
          m.t = 0;
          m.message = '출고 중 — 01F 하강';
        }
      }
      break;
    }
    case 'lowering':
      m.carriage.y = moveTo(m.carriage.y, 0, TIMES.liftSpeed, dt);
      if (m.carriage.y === 0) {
        m.t = 0;
        // 전진 입고 차량은 안쪽(+x)을 보고 있으므로 출고 전에 180° 회전, 후진 입고 차량은 이미 문을 향하므로 회전 불필요
        m.phase = m.entryMode === 'fwd' ? 'rotating' : 'opening';
        m.message = m.entryMode === 'fwd' ? '출고 중 — 턴테이블 회전' : '출입문을 여는 중';
      }
      break;
    case 'rotating': {
      // 인터록: 문이 닫혀 있고 차량이 팔레트에 고정, 하차 상태일 때만 회전
      if (m.door > 0 || !m.locked || m.occupant !== 'out') break;
      m.t += dt;
      m.yaw = Math.min(Math.PI, (Math.PI * m.t) / TIMES.rotate);
      if (m.yaw >= Math.PI) {
        m.phase = 'opening';
        m.t = 0;
        m.message = '출입문을 여는 중';
      }
      break;
    }
    case 'opening':
      m.door = Math.min(1, m.door + rate);
      if (m.door >= 1) {
        if (op?.kind === 'retrieve') {
          m.phase = 'exit';
          m.palletLoc = 'carriage';
          m.message = '출고 완료 — 탑승 후 출차하세요';
          m.events.push({ type: 'retrieved', slot: op.slot, carId: m.carrying?.carId });
        } else {
          m.phase = 'waiting';
          m.message = '입고 가능';
        }
      }
      break;
    default:
      break;
  }
}

/** 출고 후 탑승해서 출차를 시작하면 장치를 다시 대기 상태로 (팔레트는 승강장에 남는다) */
export function releaseVehicle(m: MachineState): void {
  if (m.phase !== 'exit') return;
  m.locked = false;
  m.carOnPallet = false;
  m.rel = null;
  m.op = null;
  m.carrying = null;
  m.occupant = 'in';
  m.palletLoc = 'station';
  m.cycles++;
}
export function resetToWaiting(m: MachineState): void {
  m.phase = 'waiting'; // yaw 는 차량이 팔레트를 벗어난 뒤 컨트롤러가 0 으로 되돌린다
  m.t = 0;
  m.message = '';
}

/** 승강장/캐리지 위 차량(고정 상태)의 월드 pose (뒷축 중심, 팔레트 pose + 상대 위치) */
export function lockedPose(m: MachineState): { x: number; z: number; y: number; heading: number } | null {
  if (!m.rel) return null;
  const w = localToWorld(STATION.palletX, m.carriage.z, STATION.heading + m.yaw, m.rel.x, m.rel.z);
  return { x: w.x, z: w.z, y: m.carriage.y, heading: STATION.heading + m.yaw + m.rel.heading };
}
/** 보관 슬롯에 있는 차량의 월드 pose */
export function storedPose(slot: string, car: StoredCar): { x: number; z: number; y: number; heading: number } {
  const sd = slotDef(slot);
  const w = localToWorld(STATION.palletX, sd.z, STATION.heading, car.rel.x, car.rel.z);
  return { x: w.x, z: w.z, y: sd.y, heading: STATION.heading + car.rel.heading };
}

// ---------------------------------------------------------------- 입구 안내 표시기 (전진/정지/후진)
export type GuideState = 'forward' | 'stop' | 'back' | 'align' | 'blocked';
export interface Guidance {
  state: GuideState;
  /** 짧은 안내 문구 (거리 숫자 없음) */
  text: string;
  /** 정렬 힌트: 차량을 어느 쪽으로 옮겨야 하는가 */
  steer: 'left' | 'right' | null;
  mode: EntryMode;
}

/**
 * 입구 거울 옆 표시기의 상태. **차량의 실제 위치/방향/바퀴/진행 방향(전진·후진 입고)으로만 정해진다**(타이머 없음).
 *  - 전진 입고(차량이 +x 를 향함): 앞차축이 정지 위치보다 뒤 → "전진", 지나침 → "후진"
 *  - 후진 입고(차량이 -x 를 향하고 뒷차축이 안쪽): 뒷차축이 정지 위치보다 뒤 → "후진", 지나침 → "전진"
 *  - align: 진입부(기준 차축이 정지 위치 3.5m 이내)인데 좌우/방향이 허용 오차를 벗어남
 *  - blocked: 장치가 대기 상태가 아니거나 출입문이 열려 있지 않음/승강장에 팔레트가 없음
 */
export function guidance(spec: VehicleSpec, s: AlignInput, m: MachineState): Guidance {
  const a = alignment(spec, s);
  const mode = a.mode;
  if (m.phase !== 'waiting' || m.door < 0.9 || m.palletLoc !== 'station') return { state: 'blocked', text: '진입 금지', steer: null, mode };
  const along = mode === 'fwd' ? ('forward' as const) : ('back' as const);
  const against = mode === 'fwd' ? ('back' as const) : ('forward' as const);
  const word = (g: 'forward' | 'back'): string => (g === 'forward' ? '전진' : '후진');
  if (a.stopperGap < -STATION.stopperTol) return { state: against, text: word(against), steer: null, mode };
  const near = a.stopperGap < 3.5;
  const latBad = Math.abs(a.lateral) > ALIGN_TOL.lateral;
  const headBad = a.headingErrDeg > ALIGN_TOL.heading / DEG;
  if (near && (latBad || headBad)) {
    // 월드 z 기준: 진행 방향(+x)의 왼쪽 = -z. 차량 방향에 따라 좌우가 뒤집힌다 (전진: +z 쪽이면 왼쪽으로, 후진 입고: +z 쪽이면 오른쪽으로 보인다)
    const lefty = mode === 'fwd' ? a.lateral > 0 : a.lateral < 0;
    return { state: 'align', text: latBad ? (lefty ? '왼쪽으로' : '오른쪽으로') : '방향 정렬', steer: latBad ? (lefty ? 'left' : 'right') : null, mode };
  }
  if (a.atStopper) return { state: 'stop', text: '정지', steer: null, mode };
  return { state: along, text: word(along), steer: null, mode };
}

/** 셔터 상단 LED(작동 상태 전용 안내판)의 문구/단계. machine 상태기계에서만 계산한다 */
export type StatusKind = 'ready' | 'storing' | 'lifting' | 'retrieving' | 'returning' | 'blocked' | 'estop' | 'fault';
export function statusBoard(m: MachineState): { kind: StatusKind; text: string } {
  const f = m.op ? floorLabel(slotDef(m.op.slot).floor) : '';
  if (m.fault) return { kind: 'fault', text: `고장/오류 — ${m.fault}` };
  switch (m.phase) {
    case 'estop':
      return { kind: 'estop', text: '비상 정지' };
    case 'waiting':
      return m.door < 0.9 || m.palletLoc !== 'station' ? { kind: 'blocked', text: '입출고 금지' } : { kind: 'ready', text: '입고 가능' };
    case 'closing':
      return { kind: m.op?.kind === 'retrieve' ? 'retrieving' : 'storing', text: m.op?.kind === 'retrieve' ? `출고 중 — ${f} 차량 호출` : `입고 중 — ${f} 이동` };
    case 'lifting':
      return { kind: 'lifting', text: `승강 중 — ${f} 이동` };
    case 'storing':
      return { kind: 'storing', text: `입고 중 — ${f} 보관` };
    case 'returning':
    case 'restocking':
      return { kind: 'returning', text: '플랫폼 복귀 중 — 01F' };
    case 'calling':
      return { kind: 'retrieving', text: `출고 중 — ${f} 차량 호출` };
    case 'pulling':
      return { kind: 'retrieving', text: `출고 중 — ${f} 인출` };
    case 'lowering':
      return { kind: 'lifting', text: '승강 중 — 01F 하강' };
    case 'rotating':
      return { kind: 'retrieving', text: '출고 중 — 턴테이블 회전' };
    case 'opening':
      return { kind: 'retrieving', text: '셔터 개방 중' };
    case 'exit':
      return { kind: 'ready', text: '출고 완료' };
  }
}

/** 앞/뒤 기준 차축 안착 홈의 깊이(m): 기준 차축 중심 x 가 stopperX 근처 ±0.14m 에서 최대 3cm */
export const POCKET = { depth: 0.03, halfWidth: 0.14, center: STATION.stopperX - 0.06 };
export function pocketDepthAt(refAxleX: number): number {
  const d = Math.abs(refAxleX - POCKET.center);
  if (d >= POCKET.halfWidth) return 0;
  const t = 1 - d / POCKET.halfWidth;
  return POCKET.depth * t * t * (3 - 2 * t); // smoothstep
}
