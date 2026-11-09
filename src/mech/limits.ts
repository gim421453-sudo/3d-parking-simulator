import type { VehicleSpec } from '../vehicle/spec';

/**
 * 승강기식(팔레트형) 기계식 주차장 시뮬레이션 장치의 허용 차량 / 팔레트 치수.
 *
 * 참고한 한국 기준(주차장법 시행규칙 제16조의2·제16조의5, 2026-07-27 시행본 검토 기준 — 법정 **최소** 수치):
 *  - 일반 기계식 출입구: 너비 2.4m / 높이 1.9m 이상
 *  - 중형 주차구획: 너비 2.3 × 길이 5.3 × 높이 1.6m, 대형: 너비 2.3 × 길이 5.45 × 높이 1.6m
 *  - 운반기(팔레트) 바닥 폭: 중형 2.0m, 대형 2.15m, 사람 통로: 너비 0.5m × 높이 1.8m
 * 이 게임의 장치는 **대형 팔레트(바닥 폭 2.15m)** 로 설계한 가상 장치이며, 실제 제조사 인증 사양서가 아니다.
 * 따라서 "법규에 적합한 설비"를 주장하지 않는다 — 아래 허용치는 이 시뮬레이터의 판정 기준이다.
 */
export const MECH_LIMITS = {
  /** 허용 차량: 길이/폭/높이(m), 중량(kg) */
  maxLength: 5.2,
  maxWidth: 1.95,
  maxHeight: 1.55,
  maxMassKg: 2300,
  /** 출입구(모터 셔터) 개구부 */
  doorWidth: 2.4,
  doorHeight: 1.9,
  /** 팔레트: 길이/바닥 폭, 바퀴 홈 중심(축에서 좌우 오프셋)/반폭 */
  palletLength: 5.6,
  palletWidth: 2.15,
  grooveOffset: 0.8,
  grooveHalfWidth: 0.19,
  /** 타이어 폭의 절반(가이드 간섭 판정용 근사) */
  tireHalfWidth: 0.11,
  /** 사람 통로(참고용 표기) */
  personPassage: { width: 0.5, height: 1.8 },
} as const;

/** 차량 중량(kg) — 물리 엔진에는 없는 **근사 제원**(장치 허용 중량 판정에만 사용) */
const MASS_KG: Record<string, number> = {
  compact: 1150,
  sedan: 1550,
  'sedan-glb': 1550,
  suv: 2050,
  'coupe-m4': 1700,
  'suv-x6': 2200,
  'concept-coupe': 1650,
};
export const massKgOf = (spec: Pick<VehicleSpec, 'id' | 'category'>): number => MASS_KG[spec.id] ?? (spec.category === 'suv' ? 2000 : spec.category === 'compact' ? 1150 : 1500);

export interface LimitCheck {
  ok: boolean;
  reasons: string[];
  /** 항목별 판정 (UI/테스트용) */
  width: boolean;
  height: boolean;
  length: boolean;
  mass: boolean;
}

/** 장치 허용 차량인지 판정. 하나라도 초과하면 입고 거부 */
export function checkVehicleLimits(spec: Pick<VehicleSpec, 'id' | 'category' | 'length' | 'width' | 'height'>): LimitCheck {
  const width = spec.width <= MECH_LIMITS.maxWidth;
  const height = spec.height <= MECH_LIMITS.maxHeight;
  const length = spec.length <= MECH_LIMITS.maxLength;
  const mass = massKgOf(spec) <= MECH_LIMITS.maxMassKg;
  const reasons: string[] = [];
  if (!width) reasons.push(`차폭 ${spec.width.toFixed(2)}m 가 허용 ${MECH_LIMITS.maxWidth.toFixed(2)}m 를 초과`);
  if (!height) reasons.push(`차고 ${spec.height.toFixed(2)}m 가 허용 ${MECH_LIMITS.maxHeight.toFixed(2)}m 를 초과`);
  if (!length) reasons.push(`전장 ${spec.length.toFixed(2)}m 가 허용 ${MECH_LIMITS.maxLength.toFixed(2)}m 를 초과`);
  if (!mass) reasons.push(`중량 약 ${massKgOf(spec)}kg 이 허용 ${MECH_LIMITS.maxMassKg}kg 를 초과`);
  return { ok: reasons.length === 0, reasons, width, height, length, mass };
}
