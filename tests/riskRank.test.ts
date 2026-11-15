import { describe, expect, it } from 'vitest';
import type { BoxCollider, Collider, CylCollider } from '../src/core/geometry';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { RiskRanker, futureBody } from '../src/pdc/riskRank';
import { getVehicle } from '../src/vehicle/spec';
import { createVehicleState, stepVehicle, centerOf } from '../src/vehicle/physics';

const spec = getVehicle('sedan');
const hw = spec.width / 2;
const hl = spec.length / 2;
const body = { x: 0, z: 0, rot: 0, hw, hl };
const pose = { x: 0, z: 0, heading: 0 };
const rank = (cols: Collider[], gear: 'P' | 'R' | 'N' | 'D', steer = 0, v = 0) => new RiskRanker().update(1 / 60, { snap: readSensors(pose, spec.sensors, spec.sensorHeight, cols, DEFAULT_SENSOR_CONFIG), spec, body, gear, v, steer });
/** 왼쪽(+x) 벽: 차체 왼쪽 면에서 gap 떨어진 길이 L 의 벽 */
const leftWall = (gap: number, id = 'L', L = 4): BoxCollider => ({ kind: 'box', id, tag: 'wall', x: hw + gap + 0.15, z: 0, w: 0.3, d: L, rot: 0, y0: 0, h: 2 });
const rightWall = (gap: number, id = 'R', L = 4): BoxCollider => ({ kind: 'box', id, tag: 'wall', x: -(hw + gap + 0.15), z: 0, w: 0.3, d: L, rot: 0, y0: 0, h: 2 });
const frontWall = (gap: number, id = 'F'): BoxCollider => ({ kind: 'box', id, tag: 'wall', x: 0, z: hl + gap + 0.15, w: 3, d: 0.3, rot: 0, y0: 0, h: 2 });
const rearWall = (gap: number, id = 'B'): BoxCollider => ({ kind: 'box', id, tag: 'wall', x: 0, z: -(hl + gap + 0.15), w: 3, d: 0.3, rot: 0, y0: 0, h: 2 });

describe('장애물별 위험 순위 (v0.6.1)', () => {
  it('좌측 0.2m + 전방 1.5m (D, 직진): 좌측이 1순위 — 전방 벽 때문에 측면 근접을 무시하지 않는다', () => {
    const r = rank([leftWall(0.2), frontWall(1.5)], 'D');
    expect(r[0].id).toBe('L');
    expect(r[0].cls).toBe(2);
    expect(r[0].group).toBe('left');
    const f = r.find((q) => q.id === 'F')!;
    expect(f.pathDist).not.toBeNull(); // 전방 벽은 경로와 교차(3등급)
    expect(f.cls).toBe(3);
  });
  it('우측 0.3m + 후방 1.2m (R): 우측 1순위, 후방은 경로 교차', () => {
    const r = rank([rightWall(0.28), rearWall(1.2)], 'R');
    expect(r[0].id).toBe('R');
    expect(r.find((q) => q.id === 'B')!.cls).toBe(3);
  });
  it('전방 0.4m + 좌측 0.8m (D): 전방(경로 교차)이 1순위', () => {
    const r = rank([frontWall(0.4), leftWall(0.8)], 'D');
    expect(r[0].id).toBe('F');
    expect(r[0].cls).toBe(3);
    expect(r.find((q) => q.id === 'L')!.cls).toBe(5);
  });
  it('좁은 통로(양쪽 0.25m/0.35m): 더 가까운 쪽이 1순위, 둘 다 매우 근접', () => {
    const r = rank([leftWall(0.35), rightWall(0.25)], 'D');
    expect(r[0].id).toBe('R');
    expect(r.filter((q) => q.cls <= 2).length).toBe(1); // 0.35 는 매우 근접(0.3) 밖
  });
  it('정차 중 핸들만 회전: 왼쪽으로 꺾으면 왼쪽 앞 기둥이 경로 교차로 올라오고, 직진이면 교차하지 않는다', () => {
    const pil: CylCollider = { kind: 'cyl', id: 'P', tag: 'pillar', x: hw + 0.55, z: hl + 0.6, r: 0.25, y0: 0, h: 3 };
    const straight = rank([pil], 'D', 0, 0);
    const left = rank([pil], 'D', spec.maxSteer, 0);
    expect(straight[0].pathDist).toBeNull();
    expect(left[0].pathDist).not.toBeNull();
    expect(left[0].cls).toBeLessThan(straight[0].cls);
  });
  it('후진 중 조향: 앞범퍼 바깥쪽이 스윙하며 옆 장애물에 닿는 것을 잡는다(4등급, 전륜 조향 기구학)', () => {
    // 오른쪽으로 꺾고 후진하면 앞부분은 왼쪽 바깥으로 스윙한다 → 왼쪽 앞 바깥 기둥
    const pil: CylCollider = { kind: 'cyl', id: 'S', tag: 'pillar', x: hw + 0.45, z: hl - 0.3, r: 0.15, y0: 0, h: 3 };
    const r = rank([pil], 'R', -spec.maxSteer, 0);
    const c = r.find((q) => q.id === 'S')!;
    expect(c.pathDist).not.toBeNull();
    expect(c.swing).toBe(true);
    // 반대로 꺾으면 앞부분이 오른쪽으로 → 닿지 않음
    const r2 = rank([pil], 'R', spec.maxSteer, 0);
    expect(r2.find((q) => q.id === 'S')!.pathDist).toBeNull();
  });
  it('작은 볼라드(0.25m) + 넓은 벽(1.0m) 동시: 가까운 볼라드가 1순위', () => {
    const bol: CylCollider = { kind: 'cyl', id: 'bol', tag: 'bollard', x: 0.3, z: hl + 0.25 + 0.1, r: 0.1, y0: 0, h: 0.95 };
    const r = rank([bol, frontWall(1.0)], 'D');
    expect(r[0].id).toBe('bol');
  });
  it('P/N 에서는 경로 교차를 계산하지 않는다(진행 방향 없음) — 근접만', () => {
    const r = rank([frontWall(0.5)], 'P');
    expect(r[0].pathDist).toBeNull();
    expect(r[0].cls).toBe(5);
  });
  it('미래 차체 기구학이 실제 물리(stepVehicle)의 궤적과 일치한다(진행 2m, 최대 조향, 전진/후진)', () => {
    for (const dir of [1, -1] as const) {
      const car = createVehicleState(spec, 0, 0, 0);
      car.gear = dir > 0 ? 'D' : 'R';
      car.steer = spec.maxSteer;
      car.v = dir * 0.8;
      let dist = 0;
      const c0 = centerOf(car, spec);
      while (dist < 2) {
        const px = car.x;
        const pz = car.z;
        stepVehicle(car, { throttle: 0, brake: 0, steerInput: 1 }, spec, 1 / 240);
        car.v = dir * 0.8;
        dist += Math.hypot(car.x - px, car.z - pz);
      }
      const c = centerOf(car, spec);
      const fb = futureBody(spec, car.steer, dir, dist);
      expect(c.x - c0.x).toBeCloseTo(fb.x, 1);
      expect(c.z - c0.z).toBeCloseTo(fb.z, 1);
      expect(car.heading).toBeCloseTo(fb.rot, 1);
    }
  });
});

import { ViewPolicy, type ViewRisk } from '../src/pdc/viewPolicy';
describe('1순위 위험 → 시점 선택 (v0.6.1)', () => {
  const base = (top: ViewRisk['top'], blocked = { left: false, right: false }): ViewRisk => ({
    threat: { front: true, rear: false, left: false, right: false },
    veryClose: { front: false, rear: false, left: false, right: false },
    pillar: { front: false, rear: false, left: false, right: false },
    narrow: false,
    sideBlocked: blocked,
    top,
  });
  const run = (top: ViewRisk['top'], cam: 'front' | 'rear', blocked?: { left: boolean; right: boolean }, secs = 0.3) => {
    const p = new ViewPolicy();
    let d = p.update(0.05, cam, null, { risk: base(top, blocked), level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    for (let t = 0; t < secs; t += 0.05) d = p.update(0.05, cam, null, { risk: base(top, blocked), level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    return d.view;
  };
  it('S7: D 에서 전방에도 장애물이 있지만 1순위가 오른쪽 앞 매우 근접(2등급) → 0.3초 안에 우측 시점(전방 고집 안 함)', () => {
    expect(run({ group: 'right', place: 'frontRight', cls: 2, swing: false, id: 'guide' }, 'front')).toBe('right');
  });
  it('측면 시점이 가려지면 그 모서리가 보이는 집중 탑뷰', () => {
    expect(run({ group: 'right', place: 'frontRight', cls: 2, swing: false, id: 'g' }, 'front', { left: false, right: true })).toBe('topFront');
  });
  it('R 에서 앞 모서리 스윙(4등급) → 전방 집중 탑뷰(앞범퍼 바깥이 보이게)', () => {
    expect(run({ group: 'left', place: 'frontLeft', cls: 4, swing: true, id: 'p' }, 'rear', undefined, 0.8)).toBe('topFront');
  });
  it('진행 방향 정면 매우 근접 → 그 방향 집중 탑뷰, 경로 교차(3등급)만이면 기본 카메라 유지', () => {
    expect(run({ group: 'front', place: 'front', cls: 2, swing: false, id: 'w' }, 'front')).toBe('topFront');
    expect(run({ group: 'front', place: 'front', cls: 3, swing: false, id: 'w' }, 'front', undefined, 1)).toBe('front');
  });
  it('일반 근접/먼 장애물(5·6등급)은 시점을 바꾸지 않는다', () => {
    expect(run({ group: 'left', place: 'left', cls: 5, swing: false, id: 'w' }, 'front', undefined, 1.5)).toBe('front');
    expect(run(null, 'rear', undefined, 1.5)).toBe('rear');
  });
  it('회귀(스모크): 1순위가 5등급이어도 측면 위협(risk.ts)이 있으면 그 쪽 측면뷰 — 이전 측면 자동 시점 유지', () => {
    const p = new ViewPolicy();
    const risk = { ...base({ group: 'left', place: 'left', cls: 5, swing: false, id: 'w' }), threat: { front: false, rear: false, left: true, right: false } };
    let d = p.update(0.05, 'front', null, { risk, level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    for (let t = 0; t < 1.5; t += 0.05) d = p.update(0.05, 'front', null, { risk, level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    expect(d.view).toBe('left');
  });
  it('회귀(스모크 12a): 진행 방향 3등급이라도 risk.ts 매우 근접이면 그 방향 집중 탑뷰', () => {
    const p = new ViewPolicy();
    const risk = { ...base({ group: 'front', place: 'front', cls: 3, swing: false, id: 'w' }), veryClose: { front: true, rear: false, left: false, right: false } };
    let d = p.update(0.05, 'front', null, { risk, level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    for (let t = 0; t < 1.5; t += 0.05) d = p.update(0.05, 'front', null, { risk, level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    expect(d.view).toBe('topFront');
  });
  it('수동 카메라 선택은 항상 우선', () => {
    const p = new ViewPolicy();
    const d = p.update(0.05, 'front', 'rear', { risk: base({ group: 'left', place: 'left', cls: 1, swing: false, id: 'x' }), level: { front: 'none', rear: 'none', left: 'none', right: 'none' }, hits: { front: 0, rear: 0, left: 0, right: 0 } }, true);
    expect(d.view).toBe('rear');
  });
});
