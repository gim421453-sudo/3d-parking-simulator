import { describe, expect, it } from 'vitest';
import { BEEP_VOICES, chooseBeepTarget } from '../src/sensors/beepPlan';
import type { SensorSnapshot } from '../src/sensors/sensorSystem';

const snap = (m: Partial<Record<'front' | 'rear' | 'left' | 'right', number | null>>): SensorSnapshot => ({
  readings: [],
  groupMin: { front: null, rear: null, left: null, right: null, ...m },
  range: 3,
  critical: 0.5,
});
const ALL = ['front', 'rear', 'left', 'right'] as const;

describe('방향별 경고음', () => {
  it('전후좌우 목소리가 서로 구분된다 (좌우는 패닝, 전후는 음높이/길이)', () => {
    expect(BEEP_VOICES.left.pan).toBeLessThan(0);
    expect(BEEP_VOICES.right.pan).toBeGreaterThan(0);
    expect(BEEP_VOICES.front.pan).toBe(0);
    expect(BEEP_VOICES.rear.pan).toBe(0);
    expect(BEEP_VOICES.front.freq).not.toBe(BEEP_VOICES.rear.freq);
    expect(BEEP_VOICES.front.len).not.toBe(BEEP_VOICES.rear.len);
    // 너무 다르지 않게: 주파수 차이가 1옥타브 미만
    const fs = Object.values(BEEP_VOICES).map((v) => v.freq);
    expect(Math.max(...fs) / Math.min(...fs)).toBeLessThan(2);
    // 패닝은 완전 한쪽이 아님
    expect(Math.abs(BEEP_VOICES.left.pan)).toBeLessThan(1);
  });
  it('가장 가까운 방향 하나를 선택', () => {
    expect(chooseBeepTarget(snap({ front: 1.2, left: 0.6 }), ALL, null)).toEqual({ group: 'left', distance: 0.6 });
    expect(chooseBeepTarget(snap({ rear: 0.9 }), ALL, null)).toEqual({ group: 'rear', distance: 0.9 });
  });
  it('감지가 없으면 null, 활성 그룹이 아닌 방향은 무시', () => {
    expect(chooseBeepTarget(snap({}), ALL, null)).toBeNull();
    expect(chooseBeepTarget(snap({ left: 0.4 }), ['front', 'rear'], null)).toBeNull();
  });
  it('거의 같은 거리에서는 이전 방향을 유지해 번갈아 바뀌지 않는다', () => {
    expect(chooseBeepTarget(snap({ left: 0.80, right: 0.75 }), ALL, 'left')!.group).toBe('left');
    expect(chooseBeepTarget(snap({ left: 0.80, right: 0.40 }), ALL, 'left')!.group).toBe('right');
  });
});
