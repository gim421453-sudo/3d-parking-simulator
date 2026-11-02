import { describe, expect, it } from 'vitest';
import { RelatchGate, fromLocalFrame, toLocalFrame } from '../src/pdc/latch';
import type { FrameResult } from '../src/pdc/framing';

const frame: FrameResult = { pos: { x: 5, y: 8, z: -3 }, look: { x: 5, y: 0, z: -2 }, up: { x: 0, y: 0, z: 1 }, fov: 52, visible: true };

describe('안정화된 카메라 구도(래치)', () => {
  it('로컬 변환 왕복: 같은 pose 에서는 원래 구도와 동일', () => {
    const pose = { x: 2, z: -1, heading: 0.7 };
    const back = fromLocalFrame(toLocalFrame('top', frame, pose), pose);
    expect(back.pos.x).toBeCloseTo(frame.pos.x, 6);
    expect(back.pos.z).toBeCloseTo(frame.pos.z, 6);
    expect(back.pos.y).toBe(8);
    expect(back.fov).toBe(52);
  });
  it('차량이 이동·회전해도 차량 기준 위치/높이/FOV 는 일정 (카메라가 차를 그대로 따라감)', () => {
    const p0 = { x: 0, z: 0, heading: 0 };
    const lf = toLocalFrame('top', frame, p0);
    for (const p of [{ x: 10, z: 4, heading: 0 }, { x: -3, z: 7, heading: 1.2 }, { x: 0, z: 0, heading: -2.5 }]) {
      const w = fromLocalFrame(lf, p);
      const rel = { dx: w.pos.x - p.x, dz: w.pos.z - p.z };
      const d0 = Math.hypot(frame.pos.x, frame.pos.z);
      expect(Math.hypot(rel.dx, rel.dz)).toBeCloseTo(d0, 6);
      expect(w.pos.y).toBe(8);
      expect(w.fov).toBe(52);
      // 탑뷰의 위쪽은 항상 진행 방향
      expect(w.up.x).toBeCloseTo(Math.sin(p.heading), 6);
      expect(w.up.z).toBeCloseTo(Math.cos(p.heading), 6);
    }
  });
  it('3D 시점은 월드 위쪽 유지', () => {
    const f3: FrameResult = { ...frame, up: { x: 0, y: 1, z: 0 } };
    const w = fromLocalFrame(toLocalFrame('left', f3, { x: 0, z: 0, heading: 0 }), { x: 4, z: 4, heading: 2 });
    expect(w.up).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('재구성 게이트: 화면 밖이 짧게 지속되면 재구성하지 않고, 충분히 지속+쿨다운 후에만 허용', () => {
    const g = new RelatchGate(0.6, 2.0);
    let fired = 0;
    // 0.3초 화면 밖 → 무시
    for (let i = 0; i < 6; i++) fired += g.update(0.05, true) ? 1 : 0;
    for (let i = 0; i < 20; i++) fired += g.update(0.05, false) ? 1 : 0;
    expect(fired).toBe(0);
    // 계속 화면 밖: 쿨다운(2.0s) 이후 1회, 그 뒤로도 최소 2초 간격
    let times: number[] = [];
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 0.05;
      if (g.update(0.05, true)) times.push(t);
    }
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(2.0 - 1e-6);
  });
});
