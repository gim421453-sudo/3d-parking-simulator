/**
 * v0.6.2 차량 핸들링 매개변수와 동역학 자전거 모델(순수 로직).
 *
 * 구조(physics.stepVehicle 이 사용):
 *  - 저속(|v| ≤ 3m/s, 주차): 이전과 **똑같은** 기구학 자전거 모델(뒷바퀴 횡미끄럼 없음) — 주차 감각·기존 검사 보존.
 *  - 고속(|v| ≥ 6m/s): 동역학 단일 궤도(bicycle) 모델 — 횡속도 vy, 요 레이트 r, 앞/뒤 타이어 코너링 강성 + 접지 한계(tanh 포화),
 *    정적 하중 + 가감속 하중 이동, 마찰원(가감속 중에는 횡력 한계 감소). 언더스티어/오버스티어·차체 관성·급제동 중 조향이 여기서 나온다.
 *  - 3~6m/s: 두 모델을 부드럽게 섞는다(상태 연속).
 * 질량·무게 배분·무게중심 높이·타이어 강성은 공개 제원이 없는 한 **시뮬레이션 추정값**이다(estimated=true).
 */
import type { VehicleSpec } from './spec';

export interface Handling {
  mass: number;
  /** 앞축 하중 비율(정적) */
  frontWeight: number;
  /** 무게중심 높이(m) */
  cgHeight: number;
  /** 단위 하중당 코너링 강성(1/rad) — 앞/뒤. 앞 < 뒤 이면 언더스티어 성향 */
  kf: number;
  kr: number;
  /** 요 관성 반경 계수: Iz = mass · (ry · wheelbase)² */
  ry: number;
  /** 차체 자세 제어(ESC) 근사 사용 — 국내 신차 의무(2012~). false 면 스핀 가능 */
  esc: boolean;
  /** 값이 실제 공개 제원이 아니라 추정인가 */
  estimated: boolean;
  /** 설명(문서/디버그) */
  note: string;
}

const BY_CATEGORY: Record<VehicleSpec['category'], Handling> = {
  compact: { mass: 1250, frontWeight: 0.61, cgHeight: 0.52, kf: 15, kr: 18.5, ry: 0.46, esc: true, estimated: true, note: '소형 전륜구동 추정' },
  sedan: { mass: 1550, frontWeight: 0.57, cgHeight: 0.54, kf: 15.5, kr: 18, ry: 0.47, esc: true, estimated: true, note: '중형 세단 추정' },
  suv: { mass: 1950, frontWeight: 0.55, cgHeight: 0.72, kf: 14, kr: 16.5, ry: 0.48, esc: true, estimated: true, note: 'SUV 추정(무게중심 높음)' },
  bus: { mass: 11000, frontWeight: 0.35, cgHeight: 1.1, kf: 9, kr: 11, ry: 0.5, esc: true, estimated: true, note: '구조만' },
  truck: { mass: 8000, frontWeight: 0.4, cgHeight: 1.0, kf: 9, kr: 11, ry: 0.5, esc: true, estimated: true, note: '구조만' },
};
const BY_ID: Record<string, Partial<Handling>> = {
  // 프로필 차량(임시 절차 형상): 공개 제원 확인 전이라 추정값 — 실제 차량 수치라고 표기하지 말 것
  'coupe-m4': { mass: 1730, frontWeight: 0.53, cgHeight: 0.48, kf: 16.5, kr: 18.5, note: 'M4 프로필(후륜 스포츠 쿠페) 추정' },
  'suv-x6': { mass: 2200, frontWeight: 0.52, cgHeight: 0.68, kf: 14.5, kr: 16.5, note: 'X6 프로필(대형 SUV 쿠페) 추정' },
  'concept-coupe': { mass: 1500, frontWeight: 0.5, cgHeight: 0.46, kf: 16.5, kr: 18.5, note: '컨셉 쿠페 추정' },
};
const cache = new WeakMap<VehicleSpec, Handling>();
export function handlingOf(spec: VehicleSpec): Handling {
  let h = cache.get(spec);
  if (!h) {
    h = { ...BY_CATEGORY[spec.category], ...(BY_ID[spec.id] ?? {}) };
    cache.set(spec, h);
  }
  return h;
}

/** 노면 마찰계수(건조 아스팔트 = 1 기준 배율). 젖은 노면은 후속 확장용 값만 둔다 */
export const SURFACE_MU: Record<string, number> = {
  asphalt: 1.0,
  concrete: 0.92,
  paving_stones: 0.85,
  compacted: 0.7,
  gravel: 0.6,
  unpaved: 0.6,
  ground: 0.55,
  grass: 0.45,
  wet_asphalt: 0.7,
};
export const muOf = (surface: string | undefined): number => (surface ? SURFACE_MU[surface] : undefined) ?? 1.0;

/** 저속 기구학 → 고속 동역학 섞임 비율(0 = 기구학) */
export const DYN_V0 = 3;
export const DYN_V1 = 6;
export function dynBlend(v: number): number {
  if (v <= DYN_V0) return 0;
  if (v >= DYN_V1) return 1;
  const t = (v - DYN_V0) / (DYN_V1 - DYN_V0);
  return t * t * (3 - 2 * t);
}

export interface DynState {
  vy: number;
  r: number;
}
export interface DynOut {
  vy: number;
  r: number;
  /** 횡력에 의한 종방향 감속(m/s², 미끄러지면 음수): vy·r − Fyf·sinδ/m — 미끄러지는 차는 속도를 잃는다 */
  dvx: number;
  /** 앞/뒤 타이어 슬립각(rad) */
  af: number;
  ar: number;
  /** 횡가속도(m/s²) */
  ay: number;
  /** 접지 한계 사용률 0~1(앞/뒤 큰 쪽) */
  usage: number;
}
const G = 9.81;
/** 앞 타이어 접지 한계 배율(뒤 대비) */
export const FRONT_MU = 0.9;

/**
 * 동역학 단일 궤도 모델 한 스텝(전진 vx > 0 전용). 좌표: 차량 로컬 +x = 왼쪽(vy 왼쪽 +), r 왼쪽 회전 +.
 * ax = 종가속도(하중 이동·마찰원), mu = 노면 마찰 배율. 내부에서 4ms 이하로 나눠 적분(뻣뻣한 타이어 방정식 안정).
 */
export function dynStep(h: Handling, wheelbase: number, st: DynState, vx: number, steer: number, ax: number, mu: number, dt: number): DynOut {
  const L = wheelbase;
  const a = L * (1 - h.frontWeight); // 무게중심 → 앞축
  const b = L * h.frontWeight; // 무게중심 → 뒷축
  const m = h.mass;
  const Iz = m * (h.ry * L) ** 2;
  const dTr = (m * ax * h.cgHeight) / L; // 가속 → 뒤로, 감속 → 앞으로 하중 이동
  const Fzf = Math.max(0.15 * m * G, (m * G * b) / L - dTr);
  const Fzr = Math.max(0.15 * m * G, (m * G * a) / L + dTr);
  const Cf = h.kf * Fzf;
  const Cr = h.kr * Fzr;
  // 마찰원: 가감속에 쓴 몫만큼 횡력 한계가 줄어든다
  const lon = Math.min(0.95, Math.abs(ax) / (mu * G));
  const latK = Math.sqrt(1 - lon * lon);
  // 앞 타이어 접지 한계를 뒤보다 약간 낮게(FRONT_MU): 한계에서 앞이 먼저 미끄러져 언더스티어(일반 승용차 세팅).
  // 앞·뒤 한계가 같으면 둘 다 포화될 때 요 모멘트가 0 이 되어 약한 감속에도 스핀한다(분석: docs/V062.md).
  const capF = FRONT_MU * mu * Fzf * latK;
  const capR = mu * Fzr * latK;
  const sat = (C: number, al: number, cap: number): number => cap * Math.tanh((C * al) / Math.max(1, cap));
  let vy = st.vy;
  let r = st.r;
  const n = Math.max(1, Math.ceil(dt / 0.004));
  const h2 = dt / n;
  let af = 0;
  let ar = 0;
  let Fyf = 0;
  let Fyr = 0;
  let dvxAcc = 0;
  const cd = Math.cos(steer);
  const sd = Math.sin(steer);
  // 차체 자세 제어(ESC) 근사: 조향이 요구하는 요 레이트(선형 언더스티어 이론, 접지 한계로 제한)를 넘게 돌면(오버스티어/스핀 시작)
  // 넘는 만큼 요를 줄이고, 차체 횡미끄럼각이 7° 를 넘으면 줄인다. 언더스티어(덜 도는 쪽)에는 개입하지 않는다.
  const K = understeerGradient(h, L);
  const rMax = (0.9 * mu * G) / Math.max(1, vx);
  const rRef = Math.max(-rMax, Math.min(rMax, (vx * steer) / (L + K * vx * vx)));
  const BETA = 0.12;
  for (let i = 0; i < n; i++) {
    af = steer - Math.atan2(vy + a * r, vx);
    ar = -Math.atan2(vy - b * r, vx);
    Fyf = sat(Cf, af, capF);
    Fyr = sat(Cr, ar, capR);
    const dvy = (Fyf * cd + Fyr) / m - vx * r;
    const dr = (a * Fyf * cd - b * Fyr) / Iz;
    dvxAcc += (vy * r - (Fyf * sd) / m) * h2;
    vy += dvy * h2;
    r += dr * h2;
    if (h.esc) {
      const over = Math.abs(r) - Math.abs(rRef) - 0.03;
      if (over > 0 && (Math.sign(r) === Math.sign(rRef) || Math.abs(rRef) < 1e-3)) r -= Math.sign(r) * Math.min(over, over * 10 * h2);
      const lim = BETA * vx;
      if (Math.abs(vy) > lim) vy -= Math.sign(vy) * Math.min(Math.abs(vy) - lim, (Math.abs(vy) - lim) * 20 * h2);
    }
  }
  const ay = (Fyf * cd + Fyr) / m;
  return { vy, r, dvx: dvxAcc / dt, af, ar, ay, usage: Math.max(Math.abs(Fyf) / Math.max(1, capF), Math.abs(Fyr) / Math.max(1, capR)) };
}

/** 정상 원선회 이론 언더스티어 구배 K(rad/(m/s²)): δ = L/R + K·ay. K > 0 언더스티어 */
export function understeerGradient(h: Handling, wheelbase: number): number {
  const L = wheelbase;
  const a = L * (1 - h.frontWeight);
  const b = L * h.frontWeight;
  const Fzf = (h.mass * G * b) / L;
  const Fzr = (h.mass * G * a) / L;
  return (Fzf / (h.kf * Fzf) - Fzr / (h.kr * Fzr)) / G;
}
