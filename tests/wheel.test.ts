import { describe, expect, it } from 'vitest';
import { WHEEL_LOCK_DEG, WheelModel, unwrapDeg } from '../src/core/wheel';

/** 반지름 r 인 원 위에서 각도를 stepDeg 씩 총 totalDeg(시계 +) 돌리는 포인터 시퀀스 */
const drag = (w: WheelModel, startDeg: number, totalDeg: number, stepDeg = 8) => {
  w.begin(startDeg);
  const n = Math.ceil(Math.abs(totalDeg) / stepDeg);
  for (let i = 1; i <= n; i++) w.move(startDeg + Math.sign(totalDeg) * Math.min(Math.abs(totalDeg), i * stepDeg), 1);
};

describe('1080° 핸들 모델', () => {
  it('unwrapDeg 는 (-180,180] 로 정규화', () => {
    expect(unwrapDeg(350 - 10)).toBe(-20);
    expect(unwrapDeg(-350 + 10)).toBe(20);
    expect(unwrapDeg(180)).toBe(180);
  });
  it('시계방향으로 돌리면 오른쪽(음수), 반시계는 왼쪽(양수)', () => {
    const w = new WheelModel();
    drag(w, 0, 90);
    expect(w.angle).toBeCloseTo(-90, 3);
    w.reset();
    drag(w, 0, -90);
    expect(w.angle).toBeCloseTo(90, 3);
  });
  it('좌우 각각 540° 까지 (Lock-to-Lock 1080°), 그 이상은 막힘', () => {
    const w = new WheelModel();
    drag(w, 0, -2000);
    expect(w.angle).toBe(WHEEL_LOCK_DEG);
    expect(w.steer()).toBe(1);
    w.end();
    drag(w, 0, 3000);
    expect(w.angle).toBe(-WHEEL_LOCK_DEG);
    expect(w.steer()).toBe(-1);
    expect(WHEEL_LOCK_DEG * 2).toBe(1080);
  });
  it('여러 바퀴(각도 연속 추적): 포인터가 360° 를 넘어 돌아도 누적된다', () => {
    const w = new WheelModel();
    drag(w, 30, -540); // 1.5 바퀴 반시계
    expect(w.angle).toBeCloseTo(540, 3);
    const w2 = new WheelModel();
    drag(w2, 30, -400);
    expect(w2.angle).toBeCloseTo(400, 3);
    expect(w2.steer()).toBeCloseTo(400 / 540, 5);
  });
  it('급격한 점프(추적 오류)는 무시하고 기준점을 재설정', () => {
    const w = new WheelModel();
    w.begin(0);
    w.move(10, 1);
    const before = w.angle;
    expect(w.move(10 + 150, 1)).toBe(0); // 150° 점프
    expect(w.angle).toBe(before);
    w.move(10 + 150 + 12, 1);
    expect(w.angle).toBeCloseTo(before - 12, 3);
  });
  it('중심 근처 입력은 무시', () => {
    const w = new WheelModel();
    w.begin(0);
    expect(w.move(60, 0.05)).toBe(0);
    expect(w.angle).toBe(0);
  });
  it('놓으면 중앙으로 복귀 — 속도가 빠르고 복귀 배율이 클수록 빠르다', () => {
    const t = (speed: number, rate: number) => {
      const w = new WheelModel();
      drag(w, 0, -300);
      w.end();
      let sec = 0;
      while (w.angle !== 0 && sec < 20) {
        w.update(0.02, speed, rate);
        sec += 0.02;
      }
      return sec;
    };
    expect(t(8, 1)).toBeLessThan(t(0, 1));
    expect(t(0, 2)).toBeLessThan(t(0, 1));
    expect(t(0, 1)).toBeLessThan(5);
  });
  it('드래그 중에는 복귀하지 않는다', () => {
    const w = new WheelModel();
    w.begin(0);
    w.move(-20, 1);
    const a = w.angle;
    w.update(1, 5, 1);
    expect(w.angle).toBe(a);
  });
  it('감도 배율: 같은 각도에서 steer 가 비례(최대 ±1 제한)', () => {
    const w = new WheelModel();
    drag(w, 0, -270);
    expect(w.steer(1)).toBeCloseTo(0.5, 5);
    expect(w.steer(1.5)).toBeCloseTo(0.75, 5);
    expect(w.steer(3)).toBe(1);
  });
});
