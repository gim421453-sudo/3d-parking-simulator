import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { RiskTracker } from '../src/pdc/risk';
import { SELECTABLE_VEHICLES } from '../src/vehicle/spec';

const box = (id: string, x: number, z: number, w: number, d: number, tag = 'pillar'): Collider => ({ kind: 'box', id, tag, x, z, w, d, rot: 0, y0: 0, h: 3 });
const cyl = (id: string, x: number, z: number, r: number): Collider => ({ kind: 'cyl', id, tag: 'lamp', x, z, r, y0: 0, h: 6 });

describe('기둥/가는 물체 감지 (모든 차량, 센서 사각지대 없음)', () => {
  for (const spec of SELECTABLE_VEHICLES) {
    const hw = spec.width / 2;
    const hl = spec.length / 2;
    const run = (cols: Collider[]) => {
      const pose = { x: 0, z: 0, heading: 0 };
      const body = { x: 0, z: 0, rot: 0, hw, hl };
      const t = new RiskTracker();
      let out = t.update(0.05, readSensors(pose, spec.sensors, spec.sensorHeight, cols, { ...DEFAULT_SENSOR_CONFIG, range: 3, critical: 0.5, collectRays: false }), body, spec);
      for (let i = 0; i < 10; i++) out = t.update(0.05, readSensors(pose, spec.sensors, spec.sensorHeight, cols, { ...DEFAULT_SENSOR_CONFIG, range: 3, critical: 0.5, collectRays: false }), body, spec);
      return out;
    };
    describe(spec.id, () => {
      for (const side of [1, -1]) {
        const g = side > 0 ? 'left' : 'right';
        for (const zf of [-0.9, -0.5, 0, 0.5, 0.9]) {
          it(`${g} 옆 0.6m, 길이 방향 ${zf >= 0 ? '+' : ''}${(zf * hl).toFixed(1)}m 의 0.5m 기둥 → 감지·위험`, () => {
            const o = run([box('p', side * (hw + 0.6 + 0.25), zf * hl, 0.5, 0.5)]);
            expect(o.groups[g].gap, 'gap').not.toBeNull();
            expect(o.groups[g].threat, 'threat').toBe(true);
            expect(o.groups[g].pillar).toBe(true);
          });
        }
      }
      it('전방 통로 1.0m 의 가는 원기둥(r=0.14, 가로등) 감지', () => {
        const o = run([cyl('l', 0.3, hl + 1.0, 0.14)]);
        expect(o.groups.front.gap).not.toBeNull();
        expect(o.groups.front.threat).toBe(true);
      });
      it('후방 통로 1.0m 의 0.5m 기둥(좌우 어느 쪽에 치우쳐도) 감지', () => {
        for (const lx of [-0.8, -0.3, 0, 0.3, 0.8]) {
          const o = run([box('r', lx, -hl - 1.0 - 0.25, 0.5, 0.5)]);
          expect(o.groups.rear.gap, `lx=${lx}`).not.toBeNull();
          expect(o.groups.rear.threat, `lx=${lx}`).toBe(true);
        }
      });
    });
  }
});
