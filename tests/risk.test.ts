import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { DEFAULT_SENSOR_CONFIG, proximityLevel, readSensors } from '../src/sensors/sensorSystem';
import { getVehicle } from '../src/vehicle/spec';
import { DEFAULT_RISK, RiskTracker, pointToObbGap } from '../src/pdc/risk';

const spec = getVehicle('suv-x6');
const wall = (x: number, z: number, w: number, d: number, tag = 'wall'): Collider => ({ kind: 'box', id: tag + x + z, tag, x, z, w, d, rot: 0, y0: 0, h: 1.4 });
const body = (x: number, z: number, h = 0) => ({ x, z, rot: h, hw: spec.width / 2, hl: spec.length / 2 });
const snap = (cols: Collider[], x: number, z: number, h = 0, cfg = DEFAULT_SENSOR_CONFIG) => readSensors({ x, z, heading: h }, spec.sensors, spec.sensorHeight, cols, { ...cfg, collectRays: false });

describe('차체 외곽 기준 간격', () => {
  it('점~OBB 거리: 측면/정면/모서리/내부', () => {
    const o = body(0, 0);
    expect(pointToObbGap(spec.width / 2 + 0.7, 0, o)).toBeCloseTo(0.7, 5);
    expect(pointToObbGap(0, spec.length / 2 + 1.2, o)).toBeCloseTo(1.2, 5);
    expect(pointToObbGap(spec.width / 2 + 0.3, spec.length / 2 + 0.4, o)).toBeCloseTo(0.5, 5);
    expect(pointToObbGap(0, 0, o)).toBe(0);
  });
  it('왼쪽 벽의 실제 측면 간격을 ±0.05m 로 복원 (센서 히트점 → 차체 외곽)', () => {
    const lateral = 0.9;
    const x = spec.width / 2 + lateral + 0.25;
    const t = new RiskTracker();
    let out = t.update(0.05, snap([wall(x, 0, 0.5, 6)], 0, 0), body(0, 0), spec);
    out = t.update(0.05, snap([wall(x, 0, 0.5, 6)], 0, 0), body(0, 0), spec);
    expect(out.groups.left.gap).not.toBeNull();
    expect(Math.abs(out.groups.left.gap! - lateral)).toBeLessThan(0.05);
  });
});

describe('위험 판단 (경고 단계와 독립)', () => {
  const run = (cols: Collider[], pose: [number, number], steps = 10, dt = 0.05) => {
    const t = new RiskTracker();
    let out = t.update(dt, snap(cols, pose[0], pose[1]), body(pose[0], pose[1]), spec);
    for (let i = 0; i < steps; i++) out = t.update(dt, snap(cols, pose[0], pose[1]), body(pose[0], pose[1]), spec);
    return out;
  };
  it('측면 1.1m: 위험(좌), 다른 방향은 위험 아님', () => {
    const out = run([wall(spec.width / 2 + 1.1 + 0.25, 0, 0.5, 6)], [0, 0]);
    expect(out.threatened).toEqual(['left']);
  });
  it('측면 1.6m: 정적 상태에서는 아직 위험 아님(오탐 방지)', () => {
    const out = run([wall(spec.width / 2 + 1.6 + 0.25, 0, 0.5, 6)], [0, 0]);
    expect(out.threatened).toEqual([]);
  });
  it('좌우 모두 근접하면 좁은 공간(narrow)', () => {
    const out = run([wall(spec.width / 2 + 0.7 + 0.25, 0, 0.5, 6), wall(-(spec.width / 2 + 0.7 + 0.25), 0, 0.5, 6)], [0, 0]);
    expect(out.narrow).toBe(true);
    expect(out.threatened).toEqual(expect.arrayContaining(['left', 'right']));
  });
  it('매우 가까운 측면(0.4m)은 veryClose', () => {
    const out = run([wall(spec.width / 2 + 0.4 + 0.25, 0, 0.5, 6)], [0, 0]);
    expect(out.groups.left.veryClose).toBe(true);
  });
  it('기둥(pillar) 태그는 pillar=true', () => {
    const out = run([{ kind: 'cyl', id: 'p', tag: 'pillar', x: spec.width / 2 + 0.7, z: spec.length * 0.2, r: 0.3, y0: 0, h: 3 }], [0, 0]);
    expect(out.groups.left.pillar).toBe(true);
  });
  it('히스테리시스: 위험 진입 후 exitGap 이내에서는 유지, 벗어나면 해제', () => {
    const t = new RiskTracker();
    const mk = (g: number) => snap([wall(spec.width / 2 + g + 0.25, 0, 0.5, 6)], 0, 0);
    for (let i = 0; i < 8; i++) t.update(0.05, mk(1.0), body(0, 0), spec);
    expect(t.update(0.05, mk(1.5), body(0, 0), spec).groups.left.threat).toBe(true); // 1.3 초과지만 1.7 이내
    expect(t.update(0.05, mk(2.3), body(0, 0), spec).groups.left.threat).toBe(false);
  });
  it('센서가 감지하지 않으면 위험을 만들지 않는다 (null 스냅샷/빈 장면)', () => {
    expect(new RiskTracker().update(0.05, null, body(0, 0), spec).threatened).toEqual([]);
    expect(run([], [0, 0]).threatened).toEqual([]);
  });
  it('0.2초 미만의 순간 감지는 위험으로 인정하지 않음 (지속 시간)', () => {
    const t = new RiskTracker();
    const near = snap([wall(spec.width / 2 + 0.9 + 0.25, 0, 0.5, 6)], 0, 0);
    const out = t.update(0.05, near, body(0, 0), spec);
    expect(out.groups.left.threat).toBe(false);
  });
});

describe('경고가 늦는 문제 / 화면 전환이 늦는 문제 측정 (벽을 향해 5km/h 접근)', () => {
  const v = 5 / 3.6;
  // 후방으로 벽에 접근: 벽은 z = -R. 차량 중심 z 를 줄여 간다.
  const measure = () => {
    const wallZ = -10;
    const cols = [wall(0, wallZ - 0.25, 12, 0.5)];
    const t = new RiskTracker();
    let oldView: number | null = null;
    let newView: number | null = null;
    let rearWarn: number | null = null; // 경고음/색 시작(설정 range)
    for (let z = -3; z > wallZ; z -= v * 0.02) {
      const gap = z - spec.length / 2 - (wallZ);
      const sn = snap(cols, 0, z);
      const out = t.update(0.02, sn, body(0, z), spec);
      const dRear = sn.readings.filter((r) => r.group === 'rear').reduce<number | null>((m, r) => (r.distance !== null && (m === null || r.distance < m) ? r.distance : m), null);
      if (rearWarn === null && proximityLevel(dRear, 3.0, 0.5) !== 'none') rearWarn = gap;
      // 이전 정책: near(범위 2.5, critical 0.3) 이상 + 3개 광선
      const oldLevel = proximityLevel(dRear, 2.5, 0.3);
      if (oldView === null && (oldLevel === 'near' || oldLevel === 'critical')) oldView = gap;
      if (newView === null && out.groups.rear.threat) newView = gap;
    }
    return { oldView, newView, rearWarn };
  };
  it('새 정책이 이전(near)보다 더 먼 간격에서 화면 준비를 시작한다', () => {
    const m = measure();
    // 보고용 로그
    // eslint-disable-next-line no-console
    console.log('측정(후방 접근 5km/h): 이전 near 진입 간격', m.oldView?.toFixed(2), 'm → 새 위험 진입', m.newView?.toFixed(2), 'm, 경고 시작', m.rearWarn?.toFixed(2), 'm');
    expect(m.oldView).not.toBeNull();
    expect(m.newView).not.toBeNull();
    expect(m.newView!).toBeGreaterThan(m.oldView! + 0.3);
    expect(m.rearWarn!).toBeGreaterThan(m.oldView!);
  });
  it('critical 0.5m: 주차 속도(≈3.7km/h)에서 반응 0.3s + 제동 3m/s² 의 정지 여유와 같은 규모', () => {
    const stop = (kmh: number) => {
      const u = kmh / 3.6;
      return u * 0.3 + (u * u) / (2 * 3);
    };
    expect(stop(3.7)).toBeGreaterThan(0.45);
    expect(stop(3.7)).toBeLessThan(0.55);
    expect(stop(2.7)).toBeLessThan(0.4); // 이전 0.3m 는 약 2.2km/h 수준에서만 충분
    expect(DEFAULT_RISK.veryCloseEnter).toBe(0.75); // 측면 3D 뷰로 틈이 보이는 최소 간격(화면 검수 기준)
  });
});
