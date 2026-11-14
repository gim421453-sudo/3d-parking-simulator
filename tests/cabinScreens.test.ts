import { describe, expect, it } from 'vitest';
import { speedScale } from '../src/infotainment/cabinScreens';

describe('계기판 속도계 눈금 (v0.5.5)', () => {
  it('주차 속도에서는 0~60, 55km/h 를 넘으면 차량 최고속도 눈금(40 배수 올림, 최소 120)', () => {
    expect(speedScale(0, 60, 150)).toBe(60);
    expect(speedScale(54, 60, 150)).toBe(60);
    expect(speedScale(56, 60, 150)).toBe(160);
    expect(speedScale(56, 60, 180)).toBe(200);
    expect(speedScale(56, 60, 90)).toBe(120);
  });
  it('히스테리시스: 넓은 눈금에서는 40km/h 아래로 내려가야 60 눈금으로 돌아온다(경계에서 깜빡이지 않음)', () => {
    expect(speedScale(50, 160, 150)).toBe(160);
    expect(speedScale(41, 160, 150)).toBe(160);
    expect(speedScale(39, 160, 150)).toBe(60);
  });
});
