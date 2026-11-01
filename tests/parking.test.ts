import { describe, expect, it } from 'vitest';
import { DEG, localToWorld } from '../src/core/math';
import {
  HOLD_SECONDS,
  MissionRunner,
  computeScore,
  evaluateParking,
  type MissionDef,
  type ParkingSlot,
} from '../src/mission/parking';

const slot: ParkingSlot = { id: 's', x: 10, z: 20, w: 2.6, l: 5.2, dir: 0 };
const car = (dx = 0, dz = 0, headDeg = 0) => ({ x: slot.x + dx, z: slot.z + dz, heading: headDeg * DEG, length: 4.6, width: 1.85 });

describe('주차 판정', () => {
  it('정렬된 전면 주차는 성공 자세', () => {
    const r = evaluateParking(car(), slot, 'perpendicular-front');
    expect(r.allInside).toBe(true);
    expect(r.headingOk).toBe(true);
    expect(r.poseOk).toBe(true);
    expect(r.accuracy).toBeGreaterThan(95);
  });
  it('중심점만 구획 안이고 모서리가 나가면 실패한다', () => {
    const r = evaluateParking(car(0.6, 0, 0), slot, 'perpendicular-front'); // 옆으로 0.6m: 중심은 안, 모서리는 밖
    expect(Math.abs(r.lateralOffset)).toBeLessThan(slot.w / 2);
    expect(r.allInside).toBe(false);
    expect(r.poseOk).toBe(false);
  });
  it('각도가 틀어지면(모서리가 나가거나 방향 오차) 실패한다', () => {
    const r = evaluateParking(car(0, 0, 15), slot, 'perpendicular-front');
    expect(r.headingOk).toBe(false);
    expect(r.poseOk).toBe(false);
  });
  it('앞으로 주차 미션에서 반대 방향(180°)은 실패, 후진 미션에서는 성공', () => {
    expect(evaluateParking(car(0, 0, 180), slot, 'perpendicular-front').headingOk).toBe(false);
    expect(evaluateParking(car(0, 0, 180), slot, 'perpendicular-reverse').poseOk).toBe(true);
    expect(evaluateParking(car(0, 0, 0), slot, 'perpendicular-reverse').headingOk).toBe(false);
  });
  it('평행주차는 두 방향 모두 허용하되 8° 이내여야 한다', () => {
    const p: ParkingSlot = { id: 'p', x: 0, z: 0, w: 2.5, l: 6.4, dir: Math.PI / 2 };
    const mk = (deg: number) => ({ x: 0, z: 0, heading: Math.PI / 2 + deg * DEG, length: 4.6, width: 1.85 });
    expect(evaluateParking(mk(0), p, 'parallel').poseOk).toBe(true);
    expect(evaluateParking(mk(180), p, 'parallel').poseOk).toBe(true);
    expect(evaluateParking(mk(12), p, 'parallel').poseOk).toBe(false);
  });
  it('구획 앞/뒤로 튀어나오면 실패한다', () => {
    expect(evaluateParking(car(0, 1.0, 0), slot, 'perpendicular-front').allInside).toBe(false);
  });
  it('회전된 구획에서도 네 모서리를 올바르게 검사한다', () => {
    const rs: ParkingSlot = { id: 'r', x: -5, z: 3, w: 2.6, l: 5.2, dir: 1.1 };
    const c = localToWorld(rs.x, rs.z, rs.dir, 0, 0);
    expect(evaluateParking({ x: c.x, z: c.z, heading: 1.1, length: 4.6, width: 1.85 }, rs, 'perpendicular-front').poseOk).toBe(true);
    expect(evaluateParking({ x: c.x, z: c.z, heading: 0, length: 4.6, width: 1.85 }, rs, 'perpendicular-front').poseOk).toBe(false);
  });
});

describe('미션 진행/점수', () => {
  const def: MissionDef = { id: 'm', name: 'm', kind: 'perpendicular-front', slotId: 's', desc: '', parTimeSec: 30, timeLimitSec: 100 };

  it('정차 유지 시간을 채워야 성공한다', () => {
    const m = new MissionRunner(def, slot);
    for (let t = 0; t < HOLD_SECONDS - 0.2; t += 0.1) m.update(0.1, car(), 0);
    expect(m.status).toBe('running');
    for (let t = 0; t < 0.5; t += 0.1) m.update(0.1, car(), 0);
    expect(m.status).toBe('success');
    expect(m.score!.total).toBeGreaterThan(700);
  });
  it('움직이는 동안은 유지 시간이 초기화된다', () => {
    const m = new MissionRunner(def, slot);
    for (let i = 0; i < 12; i++) m.update(0.1, car(), 0);
    m.update(0.1, car(), 1.0); // 움직임
    expect(m.hold).toBe(0);
    expect(m.status).toBe('running');
  });
  it('자세가 맞지 않으면 정차해도 성공하지 않는다', () => {
    const m = new MissionRunner(def, slot);
    for (let i = 0; i < 40; i++) m.update(0.1, car(0.7, 0, 0), 0);
    expect(m.status).toBe('running');
  });
  it('제한 시간이 지나면 실패한다', () => {
    const m = new MissionRunner(def, slot);
    for (let i = 0; i < 1100; i++) m.update(0.1, car(2, 0, 0), 0);
    expect(m.status).toBe('failed');
  });
  it('충돌 횟수만큼 점수가 감점된다', () => {
    const a = computeScore({ accuracy: 90, timeSec: 20, parTimeSec: 30, collisions: 0 });
    const b = computeScore({ accuracy: 90, timeSec: 20, parTimeSec: 30, collisions: 2 });
    expect(a.total - b.total).toBe(200);
    expect(a.stars).toBeGreaterThanOrEqual(b.stars);
  });
  it('시간이 늦을수록 시간 점수가 줄어든다', () => {
    const fast = computeScore({ accuracy: 80, timeSec: 20, parTimeSec: 30, collisions: 0 });
    const slow = computeScore({ accuracy: 80, timeSec: 90, parTimeSec: 30, collisions: 0 });
    expect(fast.timePoints).toBeGreaterThan(slow.timePoints);
  });
});
