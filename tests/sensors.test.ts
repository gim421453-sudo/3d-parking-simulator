import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { DEG, localToWorld } from '../src/core/math';
import {
  DEFAULT_SENSOR_CONFIG,
  activeGroupsFor,
  beepIntervalMs,
  proximityLevel,
  readSensors,
  type SensorConfig,
} from '../src/sensors/sensorSystem';
import { getVehicle } from '../src/vehicle/spec';

const spec = getVehicle('sedan');
const cfg: SensorConfig = { ...DEFAULT_SENSOR_CONFIG, range: 2.5, critical: 0.3, collectRays: true };
const box = (id: string, x: number, z: number, w: number, d: number, h = 1.2, y0 = 0, rot = 0): Collider => ({
  kind: 'box', id, tag: 'wall', x, z, w, d, rot, y0, h,
});

describe('주차 센서 거리 계산', () => {
  it('전방 벽까지의 거리를 정확히 계산한다 (범퍼 기준)', () => {
    // 차 중심 (0,0), 앞 범퍼 z=2.3 → 벽 면이 z=3.0 이면 0.7m
    const wall = box('w', 0, 3.25, 6, 0.5);
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [wall], cfg);
    expect(snap.groupMin.front).not.toBeNull();
    expect(snap.groupMin.front!).toBeCloseTo(0.7, 2);
    expect(snap.groupMin.rear).toBeNull();
    expect(snap.groupMin.left).toBeNull();
  });

  it('후방 벽은 rear 그룹에서만 감지된다', () => {
    const wall = box('w', 0, -3.25, 6, 0.5);
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [wall], cfg);
    expect(snap.groupMin.rear!).toBeCloseTo(0.7, 2);
    expect(snap.groupMin.front).toBeNull();
  });

  it('좌/우 측면 장애물을 올바른 쪽 센서가 감지한다 (좌=+x)', () => {
    const left = box('l', 1.4, 0, 0.5, 4); // 면이 x=1.15 → 차 옆면(0.925)과 0.225m
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [left], cfg);
    expect(snap.groupMin.left!).toBeCloseTo(1.15 - spec.width / 2, 2);
    expect(snap.groupMin.right).toBeNull();
    const right = box('r', -1.4, 0, 0.5, 4);
    const snap2 = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [right], cfg);
    expect(snap2.groupMin.right!).toBeCloseTo(1.15 - spec.width / 2, 2);
    expect(snap2.groupMin.left).toBeNull();
  });

  it('차량을 회전해도 센서 방향이 차량을 따라간다', () => {
    for (const heading of [90 * DEG, 180 * DEG, -90 * DEG, 33 * DEG]) {
      // 차량 앞쪽 2.3+0.7 = 3.0m 지점에 벽 (월드 좌표)
      const p = localToWorld(0, 0, heading, 0, 3.25);
      const wall = box('w', p.x, p.z, 6, 0.5, 1.2, 0, heading);
      const snap = readSensors({ x: 0, z: 0, heading }, spec.sensors, spec.sensorHeight, [wall], cfg);
      expect(snap.groupMin.front, `heading=${heading}`).not.toBeNull();
      expect(snap.groupMin.front!).toBeCloseTo(0.7, 1);
      expect(snap.groupMin.rear).toBeNull();
    }
  });

  it('지면 높이의 얇은 물체/낮은 연석은 감지하지 않는다 (지면 오감지 방지)', () => {
    const curb = box('curb', 0, 3.0, 6, 0.5, 0.15); // 높이 0.15 < 센서 높이 0.55
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [curb], cfg);
    expect(snap.groupMin.front).toBeNull();
  });

  it('천장에 매달린 물체(y0가 센서보다 높음)는 감지하지 않는다', () => {
    const beam = box('beam', 0, 3.0, 6, 0.5, 0.5, 2.0);
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [beam], cfg);
    expect(snap.groupMin.front).toBeNull();
  });

  it('자차는 충돌체 목록에 없으므로 자기 자신을 감지하지 않는다', () => {
    const snap = readSensors({ x: 5, z: 5, heading: 1 }, spec.sensors, spec.sensorHeight, [], cfg);
    expect(snap.readings.every((r) => r.distance === null)).toBe(true);
  });

  it('감지 범위를 넘는 장애물은 감지하지 않는다', () => {
    const wall = box('w', 0, 8, 6, 0.5);
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [wall], cfg);
    expect(snap.groupMin.front).toBeNull();
  });

  it('원기둥(콘)도 감지하며 거리가 정확하다', () => {
    const cyl: Collider = { kind: 'cyl', id: 'c', tag: 'cone', x: 0, z: 2.3 + 1.0 + 0.2, r: 0.2, y0: 0, h: 0.7 };
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [cyl], cfg);
    expect(snap.groupMin.front!).toBeCloseTo(1.0, 1);
  });

  it('디버그 광선 정보에 충돌 대상과 거리가 담긴다', () => {
    const wall = box('wallX', 0, 3.25, 6, 0.5);
    const snap = readSensors({ x: 0, z: 0, heading: 0 }, spec.sensors, spec.sensorHeight, [wall], cfg);
    const hitRay = snap.readings.flatMap((r) => r.rays).find((r) => r.hit);
    expect(hitRay?.colliderId).toBe('wallX');
    expect(hitRay!.length).toBeGreaterThan(0.6);
  });

  it('센서 12개가 앞4/뒤4/좌2/우2로 배치된다', () => {
    const c = (g: string): number => spec.sensors.filter((s) => s.group === g).length;
    expect([c('front'), c('rear'), c('left'), c('right')]).toEqual([4, 4, 2, 2]);
  });
});

describe('경고 단계와 경고음 간격', () => {
  it('가까울수록 경고음 간격이 짧아진다', () => {
    const a = beepIntervalMs(2.0, 2.5, 0.3)!;
    const b = beepIntervalMs(1.2, 2.5, 0.3)!;
    const c = beepIntervalMs(0.5, 2.5, 0.3)!;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(0);
  });
  it('위험 거리 이하에서는 연속음(0), 범위 밖/미검출은 무음(null)', () => {
    expect(beepIntervalMs(0.3, 2.5, 0.3)).toBe(0);
    expect(beepIntervalMs(0.1, 2.5, 0.3)).toBe(0);
    expect(beepIntervalMs(null, 2.5, 0.3)).toBeNull();
    expect(beepIntervalMs(2.6, 2.5, 0.3)).toBeNull();
  });
  it('경고 단계는 거리 순서대로 none→far→mid→near→critical', () => {
    const lv = [2.4, 1.6, 0.9, 0.2].map((d) => proximityLevel(d, 2.5, 0.3));
    expect(lv).toEqual(['far', 'mid', 'near', 'critical']);
    expect(proximityLevel(null, 2.5, 0.3)).toBe('none');
  });
  it('R 기어에서는 후방+측면, D 저속에서는 전방+측면이 경고 대상이다', () => {
    expect(activeGroupsFor('R', 2)).toEqual(['rear', 'left', 'right']);
    expect(activeGroupsFor('D', 5)).toContain('front');
    expect(activeGroupsFor('D', 30)).toEqual([]);
    expect(activeGroupsFor('P', 0)).toEqual([]);
  });
});
