import type { SensorGroup } from '../vehicle/spec';
import type { SensorSnapshot } from './sensorSystem';

/**
 * 방향별 경고음 "목소리" (독자 설계, 실제 차량 음원 복제 아님).
 * 전후방은 주파수/길이를 약간 다르게, 좌우는 작은 스테레오 패닝으로 구분한다. (pan: -1 왼쪽 … +1 오른쪽)
 * 모노 스피커/이어폰 한쪽에서는 좌우 분리감이 제한될 수 있다.
 */
export interface BeepVoice {
  freq: number;
  pan: number;
  len: number; // 비프 길이(초)
}
export const BEEP_VOICES: Record<SensorGroup, BeepVoice> = {
  front: { freq: 1250, pan: 0, len: 0.065 },
  rear: { freq: 920, pan: 0, len: 0.085 },
  left: { freq: 1080, pan: -0.7, len: 0.07 },
  right: { freq: 1080, pan: 0.7, len: 0.07 },
};

export interface BeepTarget {
  group: SensorGroup;
  distance: number;
}

/**
 * 여러 방향에서 동시에 감지되면 가장 가까운(위험한) 방향 하나만 울린다.
 * 직전 방향과 거의 같은 거리(margin 이내)면 직전 방향을 유지해 소리가 번갈아 바뀌지 않게 한다.
 */
export function chooseBeepTarget(snap: SensorSnapshot, groups: readonly SensorGroup[], prev: SensorGroup | null, margin = 0.15): BeepTarget | null {
  let best: BeepTarget | null = null;
  for (const g of groups) {
    const d = snap.groupMin[g];
    if (d === null || d === undefined) continue;
    if (!best || d < best.distance) best = { group: g, distance: d };
  }
  if (!best) return null;
  if (prev && prev !== best.group && groups.includes(prev)) {
    const dp = snap.groupMin[prev];
    if (dp !== null && dp !== undefined && dp <= best.distance + margin) return { group: prev, distance: dp };
  }
  return best;
}
