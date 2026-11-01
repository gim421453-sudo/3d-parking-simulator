import { clamp } from '../core/math';
import type { Gear } from './physics';

/**
 * 차량 조명 모델 (엔진 독립, 단위 테스트 대상).
 * 모드 규칙 (게임 시각효과용 설정값):
 *  - OFF      : DRL 자동 제어 (P 가 아니면 DRL 100%), 하향등 OFF
 *  - 미등     : DRL 100%, 하향등 OFF, 미등/후미등 ON
 *  - 하향등   : DRL 30%, 하향등 ON
 *  - 상향등   : DRL 30%, 하향등 + 상향등 ON
 *  - AUTO     : 주변이 어두우면 하향등 규칙, 밝으면 OFF 규칙
 * 오토 상향등(Auto High Beam)은 전방 차량 감지가 필요하므로 아직 구현하지 않았다. (docs 참고)
 */
export type LightMode = 'off' | 'position' | 'low' | 'high' | 'auto';
export const LIGHT_MODE_ORDER: LightMode[] = ['off', 'position', 'low', 'high', 'auto'];
export const LIGHT_MODE_NAME: Record<LightMode, string> = { off: 'OFF', position: '미등', low: '하향등', high: '상향등', auto: 'AUTO' };

export interface LightingInput {
  mode: LightMode;
  gear: Gear;
  ambientDark: boolean;
}
export interface LightingOutput {
  /** 실제 적용되는 규칙(AUTO 는 판정 결과) */
  effective: Exclude<LightMode, 'auto'>;
  drl: number; // 0..1
  tail: number; // 0..1 (미등/후미 주간등)
  low: boolean;
  high: boolean;
}

export function nextLightMode(m: LightMode): LightMode {
  return LIGHT_MODE_ORDER[(LIGHT_MODE_ORDER.indexOf(m) + 1) % LIGHT_MODE_ORDER.length];
}

export function computeLighting(i: LightingInput): LightingOutput {
  const effective: Exclude<LightMode, 'auto'> = i.mode === 'auto' ? (i.ambientDark ? 'low' : 'off') : i.mode;
  switch (effective) {
    case 'off':
      return { effective, drl: i.gear === 'P' ? 0 : 1, tail: 0, low: false, high: false };
    case 'position':
      return { effective, drl: 1, tail: 1, low: false, high: false };
    case 'low':
      return { effective, drl: 0.3, tail: 1, low: true, high: false };
    case 'high':
      return { effective, drl: 0.3, tail: 1, low: true, high: true };
  }
}

// ---------------------------------------------------------------- AUTO Leveling (근사)
/**
 * 서스펜션/피치 물리가 없으므로 "가속도 기반 근사 보정"이다. (실제 차체 피치 센서 값이 아님)
 * 가속하면 차체 앞이 들려 빔이 위로 향하므로 아래로(−), 제동하면 앞이 숙여 빔이 아래로 향하므로 위로(+) 보정한다.
 * 데드밴드, 1차 지연, 최대 각도 제한으로 떨림을 막는다.
 */
export const LEVELING_MAX = 0.035; // rad (≈2°)
export const LEVELING_GAIN = 0.012; // rad per (m/s²)
export const LEVELING_DEADBAND = 0.25; // m/s²
export const LEVELING_TAU = 0.45; // s

export function levelingTarget(accel: number, loadFactor = 0): number {
  const a = Math.abs(accel) < LEVELING_DEADBAND ? 0 : accel - Math.sign(accel) * LEVELING_DEADBAND;
  // loadFactor(0..1): 하중이 클수록(뒤 적재) 기본적으로 빔이 올라가 약간 아래로 보정
  return clamp(-a * LEVELING_GAIN - loadFactor * 0.01, -LEVELING_MAX, LEVELING_MAX) || 0; // -0 방지
}

export function stepLeveling(current: number, accel: number, dt: number, loadFactor = 0): number {
  const target = levelingTarget(accel, loadFactor);
  const k = 1 - Math.exp(-dt / LEVELING_TAU);
  return clamp(current + (target - current) * k, -LEVELING_MAX, LEVELING_MAX);
}
