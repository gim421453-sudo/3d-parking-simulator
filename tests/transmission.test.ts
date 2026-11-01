import { describe, expect, it } from 'vitest';
import { createVehicleState, type Gear } from '../src/vehicle/physics';
import { AUTOMATIC_GEARBOX, MANUAL_GEARBOX_STUB, allowedShifts, evaluateShift, gearboxFor, shiftGear } from '../src/vehicle/transmission';
import { getVehicle } from '../src/vehicle/spec';

const ev = (current: Gear, target: Gear, v = 0, brake = true) => evaluateShift({ current, target, v, brake });

describe('브레이크 인터록 변속 정책', () => {
  it('P 에서 R/N/D 로 나가려면 브레이크가 필요하다 (N 제외: N 은 항상 가능)', () => {
    expect(ev('P', 'R', 0, false)).toMatchObject({ ok: false, code: 'brake_required' });
    expect(ev('P', 'D', 0, false)).toMatchObject({ ok: false, code: 'brake_required' });
    expect(ev('P', 'N', 0, false).ok).toBe(true); // N 은 안전한 방향
    expect(ev('P', 'R', 0, true).ok).toBe(true);
    expect(ev('P', 'D', 0, true).ok).toBe(true);
  });
  it('N→R/D, D↔R 도 브레이크가 필요하다', () => {
    expect(ev('N', 'D', 0, false).code).toBe('brake_required');
    expect(ev('N', 'R', 0, false).code).toBe('brake_required');
    expect(ev('D', 'R', 0, false).code).toBe('brake_required');
    expect(ev('R', 'D', 0, false).code).toBe('brake_required');
    expect(ev('D', 'R', 0, true).ok).toBe(true);
    expect(ev('R', 'D', 0, true).ok).toBe(true);
  });
  it('거부 사유 문구가 제공된다', () => {
    expect(ev('P', 'D', 0, false).reason).toContain('브레이크');
  });
  it('P 로 가려면 정지에 가까워야 한다 (브레이크는 불필요)', () => {
    expect(ev('D', 'P', 3, true)).toMatchObject({ ok: false, code: 'must_stop_for_park' });
    expect(ev('R', 'P', -3, true).ok).toBe(false);
    expect(ev('D', 'P', 0.1, false).ok).toBe(true);
  });
  it('주행 중 반대 방향으로는 변속할 수 없다', () => {
    expect(ev('D', 'R', 5, true)).toMatchObject({ ok: false, code: 'moving_forward' });
    expect(ev('R', 'D', -5, true)).toMatchObject({ ok: false, code: 'moving_backward' });
  });
  it('N 은 주행 중에도 항상 가능', () => {
    expect(ev('D', 'N', 8, false).ok).toBe(true);
    expect(ev('R', 'N', -3, false).ok).toBe(true);
  });
  it('같은 기어로의 변경은 항상 ok', () => {
    expect(ev('D', 'D', 9, false).ok).toBe(true);
  });
  it('allowedShifts: 레버 UI 용 위치별 가능 여부', () => {
    const noBrake = allowedShifts('P', 0, false);
    expect(noBrake.D.ok).toBe(false);
    expect(noBrake.N.ok).toBe(true);
    expect(noBrake.P.ok).toBe(true);
    const brake = allowedShifts('P', 0, true);
    expect(brake.D.ok && brake.R.ok && brake.N.ok).toBe(true);
  });
  it('shiftGear: 인터록을 통과해야만 실제 기어가 바뀐다 (거부 시 상태 불변)', () => {
    const s = createVehicleState(getVehicle('sedan'), 0, 0, 0);
    expect(shiftGear(s, 'D', false).ok).toBe(false);
    expect(s.gear).toBe('P');
    expect(shiftGear(s, 'D', true).ok).toBe(true);
    expect(s.gear).toBe('D');
    s.v = 4;
    expect(shiftGear(s, 'R', true).ok).toBe(false);
    expect(s.gear).toBe('D');
  });
  it('변속기 모듈: 자동은 구현, 수동은 구조만 있고 미구현임을 명시한다', () => {
    expect(gearboxFor('auto')).toBe(AUTOMATIC_GEARBOX);
    expect(AUTOMATIC_GEARBOX.implemented).toBe(true);
    expect(gearboxFor('manual')).toBe(MANUAL_GEARBOX_STUB);
    expect(MANUAL_GEARBOX_STUB.implemented).toBe(false);
    expect(MANUAL_GEARBOX_STUB.evaluate({ current: 'N', target: 'D', v: 0, brake: true }).ok).toBe(false);
  });
});
