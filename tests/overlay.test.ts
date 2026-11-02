import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { worldToLocal } from '../src/core/math';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { getVehicle } from '../src/vehicle/spec';
import { buildObstacleZones } from '../src/pdc/overlay';

const spec = getVehicle('suv-x6');
const wall = (x: number, z: number, w: number, d: number): Collider => ({ kind: 'box', id: 'w', tag: 'wall', x, z, w, d, rot: 0, y0: 0, h: 1.2 });
const pose = { x: 0, z: 0, heading: 0 };
const snapOf = (cols: Collider[]) => readSensors(pose, spec.sensors, spec.sensorHeight, cols, { ...DEFAULT_SENSOR_CONFIG, collectRays: false });

describe('카메라 영상용 장애물 구역(overlay)', () => {
  it('장애물이 없으면 구역이 없다 (임의 표시 금지)', () => {
    expect(buildObstacleZones(snapOf([]), spec, pose, ['rear', 'front'])).toEqual([]);
    expect(buildObstacleZones(null, spec, pose, ['rear'])).toEqual([]);
  });
  it('뒤 벽: 후방 센서 구역만 생기고 차량 뒤쪽에 위치', () => {
    const z = buildObstacleZones(snapOf([wall(0, -(spec.length / 2 + 0.9 + 0.25), 8, 0.5)]), spec, pose, ['rear']);
    expect(z.length).toBeGreaterThan(0);
    for (const q of z) {
      expect(q.group).toBe('rear');
      for (const c of q.corners) expect(worldToLocal(pose.x, pose.z, pose.heading, c.x, c.z).z).toBeLessThan(-spec.length / 2 + 0.05);
    }
  });
  it('요청한 그룹만 반환 (전방 카메라에는 후방 구역 없음)', () => {
    const z = buildObstacleZones(snapOf([wall(0, -(spec.length / 2 + 0.9 + 0.25), 8, 0.5)]), spec, pose, ['front']);
    expect(z).toEqual([]);
  });
  it('구역 폭은 실제 히트 범위 + 여유 (벽 폭을 넘어서 부풀리지 않음)', () => {
    const z = buildObstacleZones(snapOf([wall(0, -(spec.length / 2 + 0.6 + 0.25), 0.6, 0.5)]), spec, pose, ['rear']);
    expect(z.length).toBeGreaterThan(0);
    for (const q of z) {
      const xs = q.corners.map((c) => c.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.6);
    }
  });
  it('가까울수록 단계가 높아진다', () => {
    const rank = { far: 1, mid: 2, near: 3, critical: 4 } as const;
    const lv = (gap: number) => Math.max(...buildObstacleZones(snapOf([wall(0, -(spec.length / 2 + gap + 0.25), 8, 0.5)]), spec, pose, ['rear']).map((q) => rank[q.level]));
    expect(lv(0.2)).toBeGreaterThanOrEqual(lv(1.2));
    expect(lv(1.2)).toBeGreaterThanOrEqual(lv(2.2));
  });
  it('출력 구조에 거리 필드가 없다', () => {
    const z = buildObstacleZones(snapOf([wall(0, -3.5, 8, 0.5)]), spec, pose, ['rear']);
    for (const q of z) expect(Object.keys(q).sort()).toEqual(['corners', 'group', 'hits', 'level', 'sensorId']);
  });
});
