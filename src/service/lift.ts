import { DEG, angleDiff } from '../core/math';
import type { VehicleSpec } from '../vehicle/spec';

/**
 * 2주식(2-post) 차량 리프트 — 순수 로직 (v0.5.4). 시뮬레이션용 가상 장치이며 실제 정비 장비의 인증 사양을 주장하지 않는다.
 *
 * 리프트 로컬 좌표: 원점 = 두 기둥 사이 중앙(바닥), +z = 차량 진입 방향(차량 앞쪽), 기둥은 x = ±postHalf.
 * 차량은 **차체 중심**이 원점 근처에 오도록 세운다(앞뒤 ±0.30m, 좌우 ±0.15m, 방향 ±4°).
 * 순서: 정위치 정차 → P + 주차 브레이크 + 시동 OFF → [상승] 암이 차체 아래로 들어가 고정 → 상승 → 정지(최고 높이 또는 중간 정지)
 *       → [하강] 바닥까지 내려옴 → 암이 빠짐(고정 해제) → 출차 가능.
 * 차량이 고정된 동안(암이 닿아 있는 동안)은 주행 입력이 막히고 차량 높이는 리프트 높이를 따른다(떨어지지 않는다).
 */
export type LiftKind = '2post' | '4post';
export interface LiftConfig {
  id: string;
  /** 2주식(스윙 암이 차체 아래 리프트 포인트를 받침) / 4주식(차량이 올라선 주행판(런웨이) 전체가 승강, v0.5.5) */
  kind: LiftKind;
  name: string;
  x: number;
  z: number;
  /** 차량 진입 방향(heading 규칙) */
  heading: number;
  /** 기둥 중심 반간격(m) */
  postHalf: number;
  /** 최고 높이(m) */
  maxHeight: number;
}
export const LIFT_DEFAULT = { postHalf: 1.6, maxHeight: 1.8, postSize: 0.3, postHeight: 2.9 } as const;
/** 4주식: 기둥 4개(x=±postHalf, z=±postZ), 주행판 2개(중심 x=±runwayX, 폭 runwayW, 길이 runwayL). 주행판은 바닥에 매립된 형태(윗면 = 바닥)라 차량이 그대로 올라선다 */
export const LIFT4_DEFAULT = { postHalf: 1.55, postZ: 2.75, maxHeight: 1.9, postSize: 0.28, postHeight: 2.6, runwayX: 0.78, runwayW: 0.6, runwayL: 5.3 } as const;
/** 4주식 정위치 허용: 좌우는 타이어가 주행판 위에 있어야 하므로 ±0.20m, 앞뒤는 ±0.45m */
export const LIFT4_TOL = { lateral: 0.2, longitudinal: 0.45 } as const;
/** v0.5.5 조건 완화: 좌우 ±15→25cm, 앞뒤 ±30→45cm, 방향 ±4→6°. 주차 브레이크/시동 OFF 는 필수 조건에서 뺐다(고정되면 주차 브레이크는 자동) */
export const LIFT_TOL = { lateral: 0.25, longitudinal: 0.45, heading: 6 * DEG, stopSpeed: 0.08 } as const;
export const LIFT_LIMITS = { maxWidth: 2.1, maxWeightKg: 3500 } as const;
export const LIFT_TIMES = { arms: 1.6, speed: 0.22 } as const; // 암 전개 시간(s), 승강 속도(m/s)

export type LiftPhase = 'idle' | 'armsIn' | 'raising' | 'holding' | 'lowering' | 'armsOut';
export interface LiftState {
  phase: LiftPhase;
  /** 캐리지(암) 높이 */
  h: number;
  /** 암 전개 정도 0(벌어짐, 차량 통과 가능) ~ 1(차체 아래로 들어가 접촉) */
  arms: number;
  /** 차량이 암에 고정되어 있는가 (주행 불가, 높이는 h 를 따른다) */
  locked: boolean;
  /** 고정 시점의 차량 로컬 pose (리프트 기준) — 승강 중 그대로 유지 */
  rel: { x: number; z: number; heading: number } | null;
  message: string;
  cycles: number;
  /** 상승 목표(중간 정지 지원) */
  target: number;
}
export const newLift = (): LiftState => ({ phase: 'idle', h: 0, arms: 0, locked: false, rel: null, message: '', cycles: 0, target: 0 });

export interface LiftCarInput {
  /** 차체 중심(월드) */
  cx: number;
  cz: number;
  heading: number;
  v: number;
  gear: 'P' | 'R' | 'N' | 'D';
  handbrake: boolean;
  engineOn: boolean;
}
export interface LiftAlignment {
  lateral: number;
  longitudinal: number;
  headingErrDeg: number;
  /** 뒤로 들어온 차량(차량 앞이 -z 를 향함)도 허용 */
  reversed: boolean;
  inBay: boolean;
}

export function toLiftLocal(cfg: LiftConfig, x: number, z: number): { x: number; z: number } {
  const dx = x - cfg.x;
  const dz = z - cfg.z;
  const c = Math.cos(cfg.heading);
  const s = Math.sin(cfg.heading);
  // heading 규칙: 로컬 +z = (sin, cos), 로컬 +x = (cos, -sin)
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}
export function liftToWorld(cfg: LiftConfig, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(cfg.heading);
  const s = Math.sin(cfg.heading);
  return { x: cfg.x + lx * c + lz * s, z: cfg.z - lx * s + lz * c };
}

export function liftAlignment(cfg: LiftConfig, car: LiftCarInput): LiftAlignment {
  const l = toLiftLocal(cfg, car.cx, car.cz);
  const e0 = Math.abs(angleDiff(car.heading, cfg.heading));
  const e1 = Math.abs(angleDiff(car.heading, cfg.heading + Math.PI));
  const reversed = e1 < e0;
  return { lateral: l.x, longitudinal: l.z, headingErrDeg: Math.min(e0, e1) / DEG, reversed, inBay: Math.abs(l.x) < cfg.postHalf && Math.abs(l.z) < 2.6 };
}

export interface LiftCheck {
  key: 'size' | 'centered' | 'position' | 'heading' | 'stopped' | 'parked' | 'engine';
  label: string;
  ok: boolean;
}
export function liftChecklist(cfg: LiftConfig, spec: Pick<VehicleSpec, 'width'> & { massKg?: number }, car: LiftCarInput): LiftCheck[] {
  const a = liftAlignment(cfg, car);
  if (cfg.kind === '4post') {
    return [
      { key: 'size', label: `차폭 ${LIFT_LIMITS.maxWidth}m 이하`, ok: spec.width <= LIFT_LIMITS.maxWidth && (spec.massKg ?? 0) <= LIFT_LIMITS.maxWeightKg },
      { key: 'centered', label: `주행판 중앙 (±${(LIFT4_TOL.lateral * 100).toFixed(0)}cm)`, ok: Math.abs(a.lateral) <= LIFT4_TOL.lateral },
      { key: 'position', label: `앞뒤 정위치 (±${(LIFT4_TOL.longitudinal * 100).toFixed(0)}cm)`, ok: Math.abs(a.longitudinal) <= LIFT4_TOL.longitudinal },
      { key: 'heading', label: `방향 정렬 (±${(LIFT_TOL.heading / DEG).toFixed(0)}°)`, ok: a.headingErrDeg <= LIFT_TOL.heading / DEG },
      { key: 'stopped', label: '정차', ok: Math.abs(car.v) < LIFT_TOL.stopSpeed },
      { key: 'parked', label: 'P 단', ok: car.gear === 'P' },
    ];
  }
  return [
    { key: 'size', label: `차폭 ${LIFT_LIMITS.maxWidth}m 이하`, ok: spec.width <= LIFT_LIMITS.maxWidth && (spec.massKg ?? 0) <= LIFT_LIMITS.maxWeightKg },
    { key: 'centered', label: `기둥 사이 중앙 (±${(LIFT_TOL.lateral * 100).toFixed(0)}cm)`, ok: Math.abs(a.lateral) <= LIFT_TOL.lateral },
    { key: 'position', label: `앞뒤 정위치 (±${(LIFT_TOL.longitudinal * 100).toFixed(0)}cm)`, ok: Math.abs(a.longitudinal) <= LIFT_TOL.longitudinal },
    { key: 'heading', label: `방향 정렬 (±${(LIFT_TOL.heading / DEG).toFixed(0)}°)`, ok: a.headingErrDeg <= LIFT_TOL.heading / DEG },
    { key: 'stopped', label: '정차', ok: Math.abs(car.v) < LIFT_TOL.stopSpeed },
    { key: 'parked', label: 'P 단', ok: car.gear === 'P' },
  ];
}

/** 상승 요청: 바닥(idle)이면 조건 검사 후 암 전개 → 상승. 중간 정지(holding)에서는 다시 상승 */
export function liftUp(cfg: LiftConfig, spec: Pick<VehicleSpec, 'width'> & { massKg?: number }, car: LiftCarInput, s: LiftState): boolean {
  if (s.phase === 'holding' && s.h < cfg.maxHeight - 1e-6) {
    s.phase = 'raising';
    s.target = cfg.maxHeight;
    s.message = '상승 중';
    return true;
  }
  if (s.phase !== 'idle') {
    s.message = s.phase === 'holding' ? '이미 최고 높이입니다' : '리프트가 동작 중입니다';
    return false;
  }
  const failed = liftChecklist(cfg, spec, car).filter((c) => !c.ok);
  if (failed.length) {
    s.message = `상승 불가: ${failed.map((f) => f.label).join(', ')}`;
    return false;
  }
  const l = toLiftLocal(cfg, car.cx, car.cz);
  s.rel = { x: l.x, z: l.z, heading: angleDiff(car.heading, cfg.heading) };
  s.phase = 'armsIn';
  s.target = cfg.maxHeight;
  s.message = cfg.kind === '4post' ? '바퀴 고임목 고정 중' : '리프트 암 고정 중';
  return true;
}

/** 정지 요청: 승강 중이면 그 높이에서 멈춘다(차량은 고정 유지) */
export function liftStop(s: LiftState): boolean {
  if (s.phase !== 'raising' && s.phase !== 'lowering') return false;
  s.phase = 'holding';
  s.message = '정지';
  return true;
}

/** 하강 요청: 올라가 있거나(holding) 올라가는 중이면 내려온다 */
export function liftDown(s: LiftState): boolean {
  if (s.phase === 'holding' || s.phase === 'raising') {
    s.phase = 'lowering';
    s.target = 0;
    s.message = '하강 중';
    return true;
  }
  s.message = s.phase === 'idle' ? '리프트가 이미 내려와 있습니다' : '리프트가 동작 중입니다';
  return false;
}

export function stepLift(_cfg: LiftConfig, s: LiftState, dt: number): void {
  switch (s.phase) {
    case 'armsIn':
      s.arms = Math.min(1, s.arms + dt / LIFT_TIMES.arms);
      if (s.arms >= 1) {
        s.locked = true; // 암이 차체 리프트 포인트에 닿음 → 차량 고정
        s.phase = 'raising';
        s.message = '상승 중';
      }
      break;
    case 'raising':
      s.h = Math.min(s.target, s.h + LIFT_TIMES.speed * dt);
      if (s.h >= s.target - 1e-9) {
        s.h = s.target;
        s.phase = 'holding';
        s.message = '상승 완료 — 정지';
      }
      break;
    case 'lowering':
      s.h = Math.max(0, s.h - LIFT_TIMES.speed * dt);
      if (s.h <= 1e-9) {
        s.h = 0;
        s.phase = 'armsOut';
        s.message = '고정 해제 중';
      }
      break;
    case 'armsOut':
      s.arms = Math.max(0, s.arms - dt / LIFT_TIMES.arms);
      if (s.arms <= 0) {
        s.locked = false; // 바닥에 내려온 뒤에만 고정 해제
        s.rel = null;
        s.phase = 'idle';
        s.cycles++;
        s.message = '하강 완료 — 출차 가능';
      }
      break;
    default:
      break;
  }
  // 불변식: 공중에 있는 동안에는 반드시 고정 상태
  if (s.h > 1e-6 && !s.locked) {
    s.locked = true;
    s.message = '오류: 고정 없이 상승 — 강제 고정';
  }
}

/** 고정된 차량의 월드 pose (차체 중심, 높이 포함) */
export function liftedPose(cfg: LiftConfig, s: LiftState, baseY = 0): { cx: number; cz: number; y: number; heading: number } | null {
  if (!s.rel) return null;
  const w = liftToWorld(cfg, s.rel.x, s.rel.z);
  return { cx: w.x, cz: w.z, y: baseY + s.h, heading: cfg.heading + s.rel.heading };
}

/** 리프트가 주행을 막는가(암이 들어와 있거나 공중) */
export const liftBlocksDriving = (s: LiftState): boolean => s.locked || s.phase === 'armsIn';

export function makeLift(p: { id: string; kind?: LiftKind; name?: string; x: number; z: number; heading: number; postHalf?: number; maxHeight?: number }): LiftConfig {
  if (p.kind === '4post') return { id: p.id, kind: '4post', name: p.name ?? '4주식 리프트', x: p.x, z: p.z, heading: p.heading, postHalf: p.postHalf ?? LIFT4_DEFAULT.postHalf, maxHeight: p.maxHeight ?? LIFT4_DEFAULT.maxHeight };
  return { id: p.id, kind: '2post', name: p.name ?? '2주식 리프트', x: p.x, z: p.z, heading: p.heading, postHalf: p.postHalf ?? LIFT_DEFAULT.postHalf, maxHeight: p.maxHeight ?? LIFT_DEFAULT.maxHeight };
}
