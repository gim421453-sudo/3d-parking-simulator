import { describe, expect, it } from 'vitest';
import { getVehicle, PROFILE_VEHICLES, VEHICLES, FULL_ASSIST } from '../src/vehicle/spec';
import { allowedViews, autoViewAllowed, cameraCycle, clampView, restrictAssist } from '../src/pdc/capabilities';
import { AssistController, DEFAULT_ASSIST } from '../src/pdc/assistPolicy';
import { isValidKrPlate } from '../src/vehicle/plate';

const m4 = getVehicle('coupe-m4');
const x6 = getVehicle('suv-x6');

describe('차량별 주차 보조 지원 기능', () => {
  it('M4: 후방카메라 전용 (전방/3D/자동 시점 없음)', () => {
    expect(m4.assist.rearCamera).toBe(true);
    expect(m4.assist.frontCamera).toBe(false);
    expect(m4.assist.virtualSurround3D).toBe(false);
    expect(m4.assist.panelLayout).toBe('rear');
    expect(allowedViews(m4.assist)).toEqual(['rear']);
    expect(cameraCycle(m4.assist)).toEqual([]);
    expect(autoViewAllowed(m4.assist)).toBe(false);
  });
  it('X6: 메인 카메라 6시점 (전체 탑뷰는 서라운드 전용)', () => {
    expect(allowedViews(x6.assist)).toEqual(['rear', 'front', 'left', 'right', 'topFront', 'topRear']);
    expect(cameraCycle(x6.assist)[0]).toBe('auto');
    expect(autoViewAllowed(x6.assist)).toBe(true);
    expect(x6.assist.panelLayout).toBe('surround');
  });
  it('기존 3대 차량은 전 기능 유지 (회귀 방지)', () => {
    for (const v of VEHICLES) expect(v.assist).toEqual(FULL_ASSIST);
  });
  it('프로필 차량은 맵의 주차 차량 배치(VEHICLES)에 섞이지 않는다', () => {
    for (const p of PROFILE_VEHICLES) expect(VEHICLES.find((v) => v.id === p.id)).toBeUndefined();
  });
  it('M4: D 를 선택해도 주차(전방카메라) 화면을 열지 않음, R 은 연다', () => {
    const a = new AssistController();
    const s = restrictAssist(DEFAULT_ASSIST, m4.assist);
    a.update({ gear: 'P', speedKmh: 0, dt: 0.1 }, s);
    expect(a.update({ gear: 'D', speedKmh: 2, dt: 0.1 }, s).active).toBe(false);
    expect(a.update({ gear: 'R', speedKmh: 2, dt: 0.1 }, s).active).toBe(true);
  });
  it('X6: D 저속은 전방 화면', () => {
    const a = new AssistController();
    const s = restrictAssist(DEFAULT_ASSIST, x6.assist);
    a.update({ gear: 'P', speedKmh: 0, dt: 0.1 }, s);
    const o = a.update({ gear: 'D', speedKmh: 2, dt: 0.1 }, s);
    expect(o.active && o.camera === 'front').toBe(true);
  });
  it('지원하지 않는 시점은 지원 시점으로 보정', () => {
    expect(clampView('front', m4.assist)).toBe('rear');
    expect(clampView('left', m4.assist)).toBe('rear');
    expect(clampView('left', x6.assist)).toBe('left');
  });
  it('제원: M4/X6 실제 크기 범위, 센서 12개 유지, 변속기 자동', () => {
    expect(m4.length).toBeGreaterThan(4.7);
    expect(x6.height).toBeGreaterThan(1.65);
    expect(m4.sensors.length).toBe(12);
    expect(x6.sensors.length).toBe(12);
    expect(m4.transmission).toBe('auto');
  });
  it('한국형 번호판 형식 검사', () => {
    expect(isValidKrPlate(m4.plate!)).toBe(true);
    expect(isValidKrPlate(x6.plate!)).toBe(true);
    expect(isValidKrPlate('ABC-1234')).toBe(false);
  });
});
