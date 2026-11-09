import { DEG, angleDiff, localToWorld, worldToLocal } from '../core/math';
import type { VehicleSpec } from '../vehicle/spec';
import { MECH_LIMITS, checkVehicleLimits } from './limits';

/**
 * 승강기식(팔레트형) 기계식 주차장 — 순수 로직(렌더링/물리 의존 없음).
 *
 * 월드 배치(맵 `mechpark`): 차량은 +x 방향(heading = +90°)으로 진입한다.
 *  - 팔레트 중심 (PALLET_X, 0), 길이 방향 = 월드 x, 폭 방향 = 월드 z. 바퀴 홈 2개(z = ±GROOVE).
 *  - 앞바퀴 정지턱: 팔레트 앞끝에서 STOP_BACK 뒤. 앞바퀴 중심이 STOPPER_X 를 넘지 못한다.
 * 이 장치는 시뮬레이션용 가상 사양이며 법규 적합 인증을 주장하지 않는다 (`limits.ts`).
 */
export const STATION = {
  doorX: -7.0,
  palletX: -2.4, // 팔레트 중심 x (승강 승강장 위치)
  /** 앞바퀴 중심이 이 x 를 넘어가면 정지턱에 걸린다 */
  stopperX: -0.65,
  /** 정지턱 인정 허용 (앞바퀴 중심이 stopperX 에서 이 거리 이내) */
  stopperTol: 0.2,
  heading: Math.PI / 2,
  /** 저장 베이: level y, 팔레트가 옆(z)으로 옮겨지는 위치 */
  bays: [
    { id: 'A1', y: 3, z: 3.6 },
    { id: 'A2', y: 3, z: -3.6 },
    { id: 'B1', y: 6, z: 3.6 },
    { id: 'B2', y: 6, z: -3.6 },
  ],
} as const;
export type BayId = (typeof STATION.bays)[number]['id'];

/** 정렬 허용 오차 */
export const ALIGN_TOL = { lateral: 0.12, heading: 3 * DEG, stopSpeed: 0.08 };

export interface AlignInput {
  /** 뒷축 중심 (월드) */
  x: number;
  z: number;
  heading: number;
  v: number;
  gear: 'P' | 'R' | 'N' | 'D';
  handbrake: boolean;
}

export interface Alignment {
  /** 팔레트 중심선에서 차체 중심의 좌우 오프셋 (m, +왼쪽 기준 아님: 월드 z 부호와 동일) */
  lateral: number;
  headingErrDeg: number;
  /** 4개 바퀴가 각 홈 안(타이어가 가이드를 침범하지 않음)에 있는가 */
  wheelsInGrooves: boolean;
  /** 타이어가 사이드 가이드를 침범한 바퀴 (FL FR RL RR) */
  guideInvasion: [boolean, boolean, boolean, boolean];
  /** 앞바퀴가 정지턱에 닿았는가 */
  atStopper: boolean;
  /** 앞바퀴 중심과 정지턱 거리 (+: 턱까지 남음) */
  stopperGap: number;
  /** 차량이 팔레트 위(뒷바퀴까지)에 완전히 올라왔는가 */
  onPallet: boolean;
  /** 좌우 가이드와 타이어 바깥쪽의 간격 (m, 좌/우) */
  guideGapL: number;
  guideGapR: number;
}

/** 월드 → 팔레트 좌표: 팔레트 길이 방향이 +z 가 되도록 회전 (worldToLocal 재사용) */
function wheelWorld(s: AlignInput, wx: number, wz: number): { px: number; pz: number } {
  const w = localToWorld(s.x, s.z, s.heading, wx, wz);
  // 팔레트 로컬: 길이 = x 방향이라 x 앞/ z 좌우
  return { px: w.x - STATION.palletX, pz: w.z };
}

export function alignment(spec: VehicleSpec, s: AlignInput, palletX: number = STATION.palletX): Alignment {
  const half = spec.trackWidth / 2;
  const wb = spec.wheelbase;
  const wheels = [
    wheelWorld(s, +half, wb), // FL (로컬 +x = 왼쪽)
    wheelWorld(s, -half, wb), // FR
    wheelWorld(s, +half, 0), // RL
    wheelWorld(s, -half, 0), // RR
  ];
  const guideInner = MECH_LIMITS.palletWidth / 2;
  const guideInvasion = wheels.map((w) => Math.abs(w.pz) + MECH_LIMITS.tireHalfWidth > guideInner) as [boolean, boolean, boolean, boolean];
  // 각 바퀴가 자기 홈 영역(중심 ± (halfWidth) 근처)에 있는가: 홈 영역 = |pz| 가 inner 이내 + 홈 안쪽 경계 이상
  const grooveIn = MECH_LIMITS.grooveOffset - MECH_LIMITS.grooveHalfWidth - 0.02;
  const wheelsInGrooves = wheels.every((w) => Math.abs(w.pz) + MECH_LIMITS.tireHalfWidth <= guideInner && Math.abs(w.pz) - MECH_LIMITS.tireHalfWidth >= grooveIn - 0.1) && wheels[0].pz * wheels[1].pz < 0;
  const frontX = (wheels[0].px + wheels[1].px) / 2 + STATION.palletX;
  const stopperGap = STATION.stopperX + (STATION.palletX - palletX) - frontX;
  const rearX = (wheels[2].px + wheels[3].px) / 2;
  const onPallet = rearX > -MECH_LIMITS.palletLength / 2 + 0.6 && stopperGap > -0.6;
  const cx = (wheels[0].pz + wheels[1].pz + wheels[2].pz + wheels[3].pz) / 4;
  const maxL = Math.max(wheels[0].pz, wheels[2].pz);
  const minR = Math.min(wheels[1].pz, wheels[3].pz);
  return {
    lateral: cx,
    headingErrDeg: Math.abs(angleDiff(s.heading, STATION.heading)) / DEG,
    wheelsInGrooves,
    guideInvasion,
    atStopper: Math.abs(stopperGap) <= STATION.stopperTol,
    stopperGap,
    onPallet,
    guideGapL: guideInner - (maxL + MECH_LIMITS.tireHalfWidth),
    guideGapR: guideInner - (-minR + MECH_LIMITS.tireHalfWidth),
  };
}

/** 앞바퀴가 정지턱을 넘으려 하면 되밀어야 할 거리(m, 뒤로). 0 이면 걸리지 않음 */
export function stopperPushback(spec: VehicleSpec, s: AlignInput): number {
  const fx = localToWorld(s.x, s.z, s.heading, 0, spec.wheelbase).x;
  const over = fx - STATION.stopperX;
  // 진행 방향(+x)에 가까운 자세에서만 작동. 정지턱은 팔레트 폭 안쪽에만 존재
  const lat = localToWorld(s.x, s.z, s.heading, 0, spec.wheelbase).z;
  if (Math.abs(lat) > MECH_LIMITS.palletWidth / 2 || over <= 0) return 0;
  const f = Math.cos(angleDiff(s.heading, STATION.heading));
  return f > 0.3 ? over / f : 0;
}

export type CheckKey = 'size' | 'centered' | 'heading' | 'grooves' | 'guides' | 'wheelPos' | 'stopped' | 'parked' | 'occupant' | 'door';
export interface CheckItem {
  key: CheckKey;
  label: string;
  ok: boolean;
}

export type Phase = 'waiting' | 'closing' | 'toBay' | 'stored' | 'fromBay' | 'opening' | 'exit' | 'estop';

export const TIMES = { door: 2.5, liftPerMeter: 1.6, transfer: 3.0 };

export interface MachineState {
  phase: Phase;
  /** estop 해제 시 돌아갈 단계 */
  resume: Phase | null;
  /** 진행 단계의 경과 시간 */
  t: number;
  /** 문 열림 정도 0(닫힘)..1(열림) */
  door: number;
  bay: BayId | null;
  /** 팔레트 현재 위치 */
  palletY: number;
  palletZ: number;
  occupant: 'in' | 'out';
  /** 차량이 팔레트에 고정(승강/이송 중)되어 운전 불가인가 */
  locked: boolean;
  /** 경고/거부 메시지(HUD) */
  message: string;
  cycles: number;
  /** 문 안전센서 감지 */
  doorBlocked: boolean;
  /** 저장 중인 차량의 팔레트 기준 오프셋(고정 상태의 상대 위치) */
  rel: { x: number; z: number; heading: number } | null;
}

export function newMachine(): MachineState {
  return { phase: 'waiting', resume: null, t: 0, door: 1, bay: null, palletY: 0, palletZ: 0, occupant: 'in', locked: false, message: '', cycles: 0, doorBlocked: false, rel: null };
}

export function bayOf(id: BayId): (typeof STATION.bays)[number] {
  return STATION.bays.find((b) => b.id === id)!;
}

/** 입고 시작 조건 체크리스트 (HUD/테스트 공용) */
export function checklist(spec: VehicleSpec, s: AlignInput, m: MachineState): CheckItem[] {
  const a = alignment(spec, s);
  const lim = checkVehicleLimits(spec);
  const stopped = Math.abs(s.v) < ALIGN_TOL.stopSpeed;
  return [
    { key: 'size', label: '차량 치수/중량 허용', ok: lim.ok },
    { key: 'centered', label: `팔레트 중앙 정렬 (±${(ALIGN_TOL.lateral * 100).toFixed(0)}cm)`, ok: Math.abs(a.lateral) <= ALIGN_TOL.lateral },
    { key: 'heading', label: `방향 정렬 (±${(ALIGN_TOL.heading / DEG).toFixed(0)}°)`, ok: a.headingErrDeg <= ALIGN_TOL.heading / DEG },
    { key: 'grooves', label: '4개 바퀴가 홈 안', ok: a.wheelsInGrooves },
    { key: 'guides', label: '가이드 간섭 없음', ok: !a.guideInvasion.some(Boolean) },
    { key: 'wheelPos', label: '앞바퀴 정지턱 위치', ok: a.atStopper && a.onPallet },
    { key: 'stopped', label: '정차', ok: stopped },
    { key: 'parked', label: 'P 단 + 주차 브레이크', ok: s.gear === 'P' && s.handbrake },
    { key: 'occupant', label: '운전자 하차', ok: m.occupant === 'out' },
    { key: 'door', label: '출입문 안전센서 정상', ok: !m.doorBlocked },
  ];
}

export function canStart(spec: VehicleSpec, s: AlignInput, m: MachineState): { ok: boolean; failed: CheckItem[] } {
  if (m.phase !== 'waiting') return { ok: false, failed: [] };
  const failed = checklist(spec, s, m).filter((c) => !c.ok);
  return { ok: failed.length === 0, failed };
}

/** 운전자 하차/탑승 전환 — 정차 + P + 주차 브레이크 상태에서만 하차 가능 (사람 감지가 아니라 게임 상태) */
export function toggleOccupant(s: AlignInput, m: MachineState): { ok: boolean; reason: string } {
  if (m.locked) return { ok: false, reason: '장치 동작 중에는 승하차할 수 없습니다' };
  if (m.occupant === 'in') {
    if (Math.abs(s.v) >= ALIGN_TOL.stopSpeed) return { ok: false, reason: '정차 후 하차하세요' };
    if (s.gear !== 'P' || !s.handbrake) return { ok: false, reason: 'P 단 + 주차 브레이크 후 하차하세요' };
    m.occupant = 'out';
    return { ok: true, reason: '하차했습니다' };
  }
  m.occupant = 'in';
  return { ok: true, reason: '탑승했습니다' };
}

/** 입고 시작. 조건이 안 맞으면 거부하고 이유를 message 에 남긴다 */
export function startStore(spec: VehicleSpec, s: AlignInput, m: MachineState, bay: BayId): boolean {
  const lim = checkVehicleLimits(spec);
  if (!lim.ok) {
    m.message = `입고 불가: ${lim.reasons.join(', ')}`;
    return false;
  }
  const c = canStart(spec, s, m);
  if (!c.ok) {
    m.message = c.failed.length ? `입고 불가: ${c.failed.map((f) => f.label).join(', ')}` : '입고 불가: 장치가 사용 중입니다';
    return false;
  }
  m.bay = bay;
  m.phase = 'closing';
  m.t = 0;
  m.locked = true;
  // 팔레트 기준 상대 위치를 고정 (승강/이송 중 차량-팔레트 상대 위치 불변)
  const rel = worldToLocal(STATION.palletX, 0, STATION.heading, s.x, s.z);
  m.rel = { x: rel.x, z: rel.z, heading: s.heading - STATION.heading };
  m.message = '출입문을 닫는 중';
  return true;
}

/** 출고 요청: 저장 상태에서만 */
export function requestRetrieve(m: MachineState): boolean {
  if (m.phase !== 'stored') {
    m.message = '출고할 차량이 저장되어 있지 않습니다';
    return false;
  }
  m.phase = 'fromBay';
  m.t = 0;
  m.message = '팔레트를 호출했습니다';
  return true;
}

export function emergencyStop(m: MachineState): void {
  if (m.phase === 'estop' || m.phase === 'waiting' || m.phase === 'exit' || m.phase === 'stored') return;
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

const liftTime = (y: number): number => y * TIMES.liftPerMeter;
/** 입고 이동 시간: 상승 + 옆 이송 */
export const storeDuration = (id: BayId): number => liftTime(bayOf(id).y) + TIMES.transfer;

/**
 * 시간 진행. `doorClear`: 문 구역(문 평면 ±0.5m)에 차량/물체가 없는가 — 안전센서 입력.
 * 팔레트 pose(palletY/Z)와 문 개폐도를 갱신한다.
 */
export function stepMachine(m: MachineState, dt: number, doorClear: boolean): void {
  if (m.phase === 'estop') return;
  m.doorBlocked = !doorClear && m.phase !== 'toBay' && m.phase !== 'fromBay' && m.phase !== 'stored';
  const rate = dt / TIMES.door;
  switch (m.phase) {
    case 'closing':
      if (!doorClear) {
        // 안전센서: 닫히던 문이 다시 열린다
        m.door = Math.min(1, m.door + rate * 2);
        m.message = '출입문 안전센서 감지 — 닫힘 정지';
        break;
      }
      m.door = Math.max(0, m.door - rate);
      if (m.door <= 0) {
        m.phase = 'toBay';
        m.t = 0;
        m.message = '팔레트 이동 중';
      }
      break;
    case 'toBay': {
      if (m.door > 0) break; // 인터록: 문이 완전히 닫혀야 승강 가능
      const b = bayOf(m.bay!);
      const tl = liftTime(b.y);
      m.t += dt;
      if (m.t < tl) {
        m.palletY = (m.t / tl) * b.y;
        m.palletZ = 0;
      } else {
        const f = Math.min(1, (m.t - tl) / TIMES.transfer);
        m.palletY = b.y;
        m.palletZ = f * b.z;
        if (f >= 1) {
          m.phase = 'stored';
          m.cycles += 0;
          m.message = `저장 완료 (${b.id})`;
        }
      }
      break;
    }
    case 'fromBay': {
      const b = bayOf(m.bay!);
      const tl = liftTime(b.y);
      m.t += dt;
      if (m.t < TIMES.transfer) {
        m.palletY = b.y;
        m.palletZ = (1 - m.t / TIMES.transfer) * b.z;
      } else {
        const f = Math.min(1, (m.t - TIMES.transfer) / tl);
        m.palletZ = 0;
        m.palletY = (1 - f) * b.y;
        if (f >= 1) {
          m.phase = 'opening';
          m.t = 0;
          m.palletY = 0;
          m.message = '출입문을 여는 중';
        }
      }
      break;
    }
    case 'opening':
      m.door = Math.min(1, m.door + rate);
      if (m.door >= 1) {
        m.phase = 'exit';
        m.message = '출고 완료 — 탑승 후 출차하세요';
        m.cycles++;
      }
      break;
    default:
      break;
  }
}

/** 출고 후 탑승해서 출차를 시작하면 장치를 다시 대기 상태로 */
export function releaseVehicle(m: MachineState): void {
  if (m.phase !== 'exit') return;
  m.locked = false;
  m.rel = null;
  m.bay = null;
  m.occupant = 'in';
}
export function resetToWaiting(m: MachineState): void {
  m.phase = 'waiting';
  m.t = 0;
  m.locked = false;
  m.rel = null;
  m.bay = null;
  m.occupant = 'in';
  m.message = '';
}

/** 고정된 차량의 월드 pose (뒷축 중심, 팔레트 pose + 상대 위치) */
export function lockedPose(m: MachineState): { x: number; z: number; y: number; heading: number } | null {
  if (!m.rel) return null;
  const w = localToWorld(STATION.palletX, m.palletZ, STATION.heading, m.rel.x, m.rel.z);
  return { x: w.x, z: w.z, y: m.palletY, heading: STATION.heading + m.rel.heading };
}
