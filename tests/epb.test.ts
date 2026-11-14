import { describe, expect, it } from 'vitest';
import { EPB_RELEASE_THROTTLE, epbAutoRelease, epbOnShift } from '../src/vehicle/epb';
import { shiftGear } from '../src/vehicle/transmission';
import { createVehicleState } from '../src/vehicle/physics';
import { getVehicle } from '../src/vehicle/spec';

describe('전자식 주차 브레이크 자동 동작 (v0.6.0)', () => {
  it('P 로 변속하면 자동 체결, 다른 기어로는 체결하지 않는다', () => {
    for (const g of ['R', 'N', 'D'] as const) {
      const s = { handbrake: false };
      expect(epbOnShift(s, g)).toBe(false);
      expect(s.handbrake).toBe(false);
    }
    const s = { handbrake: false };
    expect(epbOnShift(s, 'P')).toBe(true);
    expect(s.handbrake).toBe(true);
    expect(epbOnShift(s, 'P')).toBe(false); // 이미 체결
  });
  it('shiftGear(→P) 를 거치면 주차 브레이크가 걸린다 (키보드/레버/게임패드/시동 OFF 자동 P 공통 경로)', () => {
    const c = createVehicleState(getVehicle('sedan'), 0, 0, 0);
    c.gear = 'D';
    c.handbrake = false;
    expect(shiftGear(c, 'P', true).ok).toBe(true);
    expect(c.handbrake).toBe(true);
  });
  it('D/R + 시동 + 가속 페달 → 자동 해제', () => {
    for (const g of ['D', 'R'] as const) {
      const s = { handbrake: true, gear: g };
      expect(epbAutoRelease(s, 0.5, true)).toBe(true);
      expect(s.handbrake).toBe(false);
    }
  });
  it('해제하지 않는 경우: P/N, 시동 OFF, 페달을 살짝(임계 이하)만 밟음, 이미 해제', () => {
    const cases: [{ handbrake: boolean; gear: 'P' | 'R' | 'N' | 'D' }, number, boolean][] = [
      [{ handbrake: true, gear: 'P' }, 1, true],
      [{ handbrake: true, gear: 'N' }, 1, true],
      [{ handbrake: true, gear: 'D' }, 1, false],
      [{ handbrake: true, gear: 'D' }, EPB_RELEASE_THROTTLE, true],
      [{ handbrake: false, gear: 'D' }, 1, true],
    ];
    for (const [s, t, on] of cases) {
      const before = s.handbrake;
      expect(epbAutoRelease(s, t, on)).toBe(false);
      expect(s.handbrake).toBe(before);
    }
  });
});
