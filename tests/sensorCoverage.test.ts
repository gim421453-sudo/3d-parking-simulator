import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { RiskTracker } from '../src/pdc/risk';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { SELECTABLE_VEHICLES } from '../src/vehicle/spec';

const cfg = { ...DEFAULT_SENSOR_CONFIG, range: 3, critical: 0.5, collectRays: false };
const pole = (x: number, z: number, r: number, h = 3, y0 = 0, tag = 'pillar'): Collider => ({ kind: 'cyl', id: 'o', tag, x, z, r, y0, h });
const snap = (spec: (typeof SELECTABLE_VEHICLES)[number], cols: Collider[], y = 0) => readSensors({ x: 0, z: 0, heading: 0, y }, spec.sensors, spec.sensorHeight, cols, cfg);

/** 360° 감지 범위 진단: 차체 외곽에서 gap 만큼 떨어진 둘레 전체(0.2m 간격)에 가는 기둥을 하나씩 세우고 센서가 놓치는 지점을 센다 */
export function blindSpots(spec: (typeof SELECTABLE_VEHICLES)[number], gap: number, r: number): string[] {
  const hw = spec.width / 2;
  const hl = spec.length / 2;
  const pts: { x: number; z: number; t: string }[] = [];
  for (let t = -hw - gap; t <= hw + gap + 1e-6; t += 0.2) {
    pts.push({ x: t, z: hl + gap, t: '전방' });
    pts.push({ x: t, z: -hl - gap, t: '후방' });
  }
  for (let t = -hl; t <= hl + 1e-6; t += 0.2) {
    pts.push({ x: hw + gap, z: t, t: '좌측' });
    pts.push({ x: -hw - gap, z: t, t: '우측' });
  }
  return pts.filter((p) => snap(spec, [pole(p.x, p.z, r)]).readings.every((q) => q.distance === null)).map((p) => `${p.t}(${p.x.toFixed(1)},${p.z.toFixed(1)})`);
}

describe('PDC 360° 감지 범위 (모든 차량, v0.4.9 사각지대 보정)', () => {
  for (const spec of SELECTABLE_VEHICLES) {
    for (const gap of [0.5, 1.0, 2.0]) {
      for (const r of [0.15, 0.3]) {
        it(`${spec.id}: 둘레 ${gap}m, 반지름 ${r}m 기둥 — 전방/모서리/측면/후방 어디서도 놓치지 않음`, () => {
          expect(blindSpots(spec, gap, r)).toEqual([]);
        });
      }
    }
  }
});

describe('방향별 분류와 오검출 (v0.4.9)', () => {
  for (const spec of SELECTABLE_VEHICLES) {
    const hw = spec.width / 2;
    const hl = spec.length / 2;
    const risk = (cols: Collider[], y = 0) => {
      const t = new RiskTracker();
      const body = { x: 0, z: 0, rot: 0, hw, hl };
      let o = t.update(0.05, snap(spec, cols, y), body, spec);
      for (let i = 0; i < 10; i++) o = t.update(0.05, snap(spec, cols, y), body, spec);
      return o;
    };
    it(`${spec.id}: 나란히 주차된 옆 차량(길이 방향 전체)은 좌/우 위험이지 전방/후방 위험이 아니다`, () => {
      const car: Collider = { kind: 'box', id: 'c', tag: 'car', x: hw + 0.7 + 0.95, z: 0, w: 1.9, d: 4.6, rot: 0, y0: 0, h: 1.4 };
      const o = risk([car]);
      expect(o.groups.left.threat).toBe(true);
      expect(o.groups.front.threat).toBe(false);
      expect(o.groups.rear.threat).toBe(false);
    });
    it(`${spec.id}: 전방 모서리의 기둥(차체 폭 바깥 0.3m)도 전방 또는 좌측으로 분류되어 감지된다`, () => {
      const o = risk([pole(hw + 0.3, hl + 0.8, 0.25)]);
      expect(o.groups.front.gap !== null || o.groups.left.gap !== null).toBe(true);
    });
    it(`${spec.id}: 다른 층(±3m)의 장애물은 감지되지 않는다 / 같은 층 낮은 연석(0.15m)은 감지 안 됨이 정상 / 볼라드(0.9m)는 감지`, () => {
      expect(snap(spec, [pole(0, hl + 1.0, 0.3, 3, 3.0)], 0).readings.every((q) => q.distance === null)).toBe(true);
      expect(snap(spec, [pole(0, hl + 1.0, 0.3, 3, -3.5)], 0).readings.every((q) => q.distance === null)).toBe(true);
      expect(snap(spec, [pole(0, hl + 1.0, 0.3, 0.15, 0, 'curb')]).readings.every((q) => q.distance === null)).toBe(true);
      expect(snap(spec, [pole(0, hl + 1.0, 0.1, 0.9, 0, 'bollard')]).readings.some((q) => q.distance !== null)).toBe(true);
    });
    it(`${spec.id}: 장애물이 사라지면 미감지 상태로 복귀`, () => {
      const t = new RiskTracker();
      const body = { x: 0, z: 0, rot: 0, hw, hl };
      for (let i = 0; i < 6; i++) t.update(0.05, snap(spec, [pole(0, hl + 0.6, 0.3)]), body, spec);
      let o = t.update(0.05, snap(spec, [pole(0, hl + 0.6, 0.3)]), body, spec);
      expect(o.groups.front.threat).toBe(true);
      for (let i = 0; i < 40; i++) o = t.update(0.05, snap(spec, []), body, spec);
      expect(o.groups.front.threat).toBe(false);
      expect(o.groups.front.gap).toBeNull();
    });
  }
});
