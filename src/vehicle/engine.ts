import type { VehicleSpec } from './spec';

/**
 * 엔진 시동 상태기계 + RPM 시뮬레이션 (순수 로직). RPM 은 물리 엔진의 실측값이 아니라 속도/스로틀/기어에서 만든 **근사**다.
 *  OFF → (조건 충족 + 버튼) → STARTING → RUNNING → (정차 + P/N + 버튼) → STOPPING → OFF
 *  ACC: 전기장치 사용 상태(엔진 정지). 이번 버전은 상태만 지원하고 조명 등 전기장치는 시동 상태와 독립이다.
 */
export type EngineState = 'OFF' | 'ACC' | 'STARTING' | 'RUNNING' | 'STOPPING';

export interface EngineProfile {
  id: string;
  /** 표시 이름 (실제 차량 엔진음이 아니라 합성 프로필임을 밝힌다) */
  label: string;
  idle: number;
  redline: number;
  /** 실린더 수 (점화 주파수 = rpm/60 × cyl/2) */
  cylinders: number;
  startTime: number;
  stopTime: number;
  /** 음색: 고조파 혼합(0..1) — 스포츠일수록 거칠고 높은 배음 */
  rough: number;
  /** 변속비 근사(속도 m/s → rpm 환산): rpm ≈ idle + speed × k */
  rpmPerMps: number;
}

export const ENGINE_PROFILES: Record<string, EngineProfile> = {
  compact: { id: 'compact', label: '소형차 3기통(합성)', idle: 900, redline: 6200, cylinders: 3, startTime: 1.1, stopTime: 1.0, rough: 0.45, rpmPerMps: 115 },
  sedan: { id: 'sedan', label: '세단 4기통(합성)', idle: 750, redline: 6000, cylinders: 4, startTime: 1.2, stopTime: 1.0, rough: 0.3, rpmPerMps: 95 },
  suv: { id: 'suv', label: 'SUV 6기통(합성)', idle: 700, redline: 5600, cylinders: 6, startTime: 1.3, stopTime: 1.1, rough: 0.25, rpmPerMps: 80 },
  coupe: { id: 'coupe', label: '스포츠 쿠페 6기통(합성)', idle: 800, redline: 7200, cylinders: 6, startTime: 1.0, stopTime: 0.9, rough: 0.7, rpmPerMps: 105 },
};

/** 차종 → 합성 엔진 프로필. BMW 계열 프로필(coupe-m4/suv-x6)도 **실제 BMW 엔진음이 아니라** 해당 급의 합성 프로필이다 */
export function profileOf(spec: Pick<VehicleSpec, 'id' | 'category'>): EngineProfile {
  if (spec.id === 'coupe-m4' || spec.id === 'concept-coupe') return ENGINE_PROFILES.coupe;
  if (spec.id === 'suv-x6' || spec.category === 'suv') return ENGINE_PROFILES.suv;
  if (spec.category === 'compact') return ENGINE_PROFILES.compact;
  return ENGINE_PROFILES.sedan;
}

export interface Engine {
  state: EngineState;
  rpm: number;
  /** 현재 상태 경과 시간 */
  t: number;
  profile: EngineProfile;
  /** 시동 시도/성공/종료 횟수 (테스트·사운드 트리거) */
  starts: number;
  stops: number;
}

export const newEngine = (profile: EngineProfile, running: boolean): Engine => ({
  state: running ? 'RUNNING' : 'OFF',
  rpm: running ? profile.idle : 0,
  t: 0,
  profile,
  starts: 0,
  stops: 0,
});

export interface StartStopCtx {
  /** 현재 속력 (m/s, 절댓값) */
  speed: number;
  gear: 'P' | 'R' | 'N' | 'D';
  /** 브레이크 페달 입력 0..1 */
  brake: number;
}

/** 시동 버튼: 조건을 검사하고 상태를 전이한다. 조건 불충족 시 이유를 반환 */
export function pressStartStop(e: Engine, c: StartStopCtx): { ok: boolean; reason: string; autoPark?: boolean } {
  if (e.state === 'STARTING' || e.state === 'STOPPING') return { ok: false, reason: e.state === 'STARTING' ? '시동 중입니다' : '시동을 끄는 중입니다' };
  if (e.state === 'OFF' || e.state === 'ACC') {
    if (c.speed > 0.2) return { ok: false, reason: '차량이 정차한 상태에서만 시동을 걸 수 있습니다' };
    if (c.gear !== 'P' && c.gear !== 'N') return { ok: false, reason: 'P 또는 N 단에서 시동을 걸어주세요' };
    if (c.brake < 0.3) return { ok: false, reason: '브레이크 페달을 밟은 채 시동 버튼을 누르세요' };
    e.state = 'STARTING';
    e.t = 0;
    e.starts++;
    return { ok: true, reason: '시동 중…' };
  }
  // RUNNING
  if (c.speed > 0.2) return { ok: false, reason: '정차 후 시동을 끌 수 있습니다' };
  // v0.5.5 조건 완화: 정차만 했으면 어느 기어에서든 끌 수 있다. D/R 이면 호출 쪽이 P 로 자동 변속한다(autoPark)
  const autoPark = c.gear !== 'P' && c.gear !== 'N';
  e.state = 'STOPPING';
  e.t = 0;
  e.stops++;
  return { ok: true, reason: autoPark ? '시동 종료 (P 단 자동 변속)' : '시동 종료', autoPark };
}

/** 주행 동력 사용 가능 여부: RUNNING 일 때만 가속/크리프/엔진브레이크가 작동한다 */
export const powerOn = (e: Engine): boolean => e.state === 'RUNNING';
/** 시동이 걸려 있거나 걸리는 중인가 (기계식 입고 전 시동 OFF 검사용) */
export const engineOn = (e: Engine): boolean => e.state === 'RUNNING' || e.state === 'STARTING';

export interface EngineInput {
  throttle: number;
  speed: number;
  gear: 'P' | 'R' | 'N' | 'D';
}

const approach = (cur: number, target: number, rate: number, dt: number): number => (Math.abs(target - cur) <= rate * dt ? target : cur + Math.sign(target - cur) * rate * dt);

/** 시간 진행: 상태 전이 + RPM 근사 */
export function stepEngine(e: Engine, dt: number, i: EngineInput): void {
  const p = e.profile;
  e.t += dt;
  switch (e.state) {
    case 'OFF':
    case 'ACC':
      e.rpm = approach(e.rpm, 0, 4000, dt);
      break;
    case 'STARTING': {
      // 크랭킹: 0 → 250rpm 로 오르다 마지막 순간에 점화되어 공회전 위로 튀었다가 안정
      const f = Math.min(1, e.t / p.startTime);
      e.rpm = f < 0.8 ? 120 + 130 * (f / 0.8) : approach(e.rpm, p.idle * 1.35, 9000, dt);
      if (e.t >= p.startTime) {
        e.state = 'RUNNING';
        e.t = 0;
      }
      break;
    }
    case 'RUNNING': {
      const driven = i.gear === 'D' || i.gear === 'R';
      const load = driven ? p.idle + i.speed * p.rpmPerMps : p.idle;
      const rev = p.idle + Math.max(0, i.throttle) * (p.redline * 0.62 - p.idle); // 공회전/무부하 가속(스로틀 → RPM)
      const target = Math.min(p.redline, Math.max(p.idle, driven ? Math.max(load, load * 0.55 + rev * 0.9 * Math.min(1, 0.4 + i.throttle)) : rev));
      e.rpm = approach(e.rpm, target, i.throttle > 0.05 ? 5500 : 2600, dt);
      break;
    }
    case 'STOPPING':
      e.rpm = approach(e.rpm, 0, p.idle / Math.max(0.2, p.stopTime), dt);
      if (e.t >= p.stopTime || e.rpm <= 0) {
        e.rpm = 0;
        e.state = 'OFF';
        e.t = 0;
      }
      break;
  }
}
