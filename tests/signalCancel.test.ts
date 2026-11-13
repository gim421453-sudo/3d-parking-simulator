import { describe, expect, it } from 'vitest';
import { SIGNAL_ARM_DEG, SIGNAL_RELEASE_DEG, newSignalCancel, updateSignalCancel } from '../src/vehicle/signalCancel';

const seq = (signal: 'left' | 'right' | null, degs: number[]): boolean[] => {
  const s = newSignalCancel();
  return degs.map((d) => updateSignalCancel(s, signal, d));
};

describe('방향지시등 자동 해제 (핸들 180° 이상 돌린 뒤 풀릴 때)', () => {
  it('좌회전: 왼쪽으로 180° 이상 돌렸다가 풀리면 해제', () => {
    const r = seq('left', [0, 90, 179, 180, 300, 200, 100, 46, 45, 0]);
    expect(r.indexOf(true)).toBe(8); // 45° 이하로 돌아온 순간
    expect(r.filter(Boolean).length).toBe(1);
  });
  it('우회전: 오른쪽(음수)으로 180° 이상 돌렸다가 풀리면 해제', () => {
    const r = seq('right', [0, -200, -400, -100, -30]);
    expect(r).toEqual([false, false, false, false, true]);
  });
  it('180° 미만으로만 돌렸다가 풀면(차선 변경) 꺼지지 않는다', () => {
    expect(seq('left', [0, 60, 170, 179.9, 100, 0, -20]).some(Boolean)).toBe(false);
  });
  it('반대 방향으로 아무리 돌려도 꺼지지 않는다', () => {
    expect(seq('left', [0, -200, -540, -100, 0]).some(Boolean)).toBe(false);
  });
  it('크게 돌린 채 유지하는 동안에는 켜져 있다(풀릴 때만 해제)', () => {
    expect(seq('right', [-300, -300, -300, -250, -200]).some(Boolean)).toBe(false);
  });
  it('깜빡이가 꺼져 있으면 아무 일도 없고, 다시 켜면 처음부터(이전 장전 상태가 남지 않는다)', () => {
    const s = newSignalCancel();
    updateSignalCancel(s, 'left', 300);
    expect(s.armed).toBe(true);
    updateSignalCancel(s, null, 300);
    expect(s.armed).toBe(false);
    expect(updateSignalCancel(s, 'left', 20)).toBe(false); // 새로 켠 뒤 아직 180° 를 넘지 않았다
  });
  it('방향을 바꾸면 장전이 초기화된다', () => {
    const s = newSignalCancel();
    updateSignalCancel(s, 'left', 300);
    expect(updateSignalCancel(s, 'right', 10)).toBe(false);
    expect(s.armed).toBe(false);
  });
  it('기준값', () => {
    expect(SIGNAL_ARM_DEG).toBe(180);
    expect(SIGNAL_RELEASE_DEG).toBeLessThan(SIGNAL_ARM_DEG);
  });
});
