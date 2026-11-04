import { describe, expect, it } from 'vitest';
import { C3_LEVEL_Y, C3_TERRAIN, MAP_CARPARK3 } from '../src/maps/mapCarpark3';
import { groundAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { arc, line, makeSim } from './helpers/driveSim';

const colliders = mapColliders(MAP_CARPARK3);
const sim = makeSim(C3_TERRAIN, colliders);
const LZ = 11.25;
const LX = 20.25;
const R = 5.25;

/** 1F 입구 → 경사로1(동) → 동쪽 코너 2개(좌회전×2) → 경사로2(서) */
const route: [number, number][] = [
  ...line(-28, -LZ, 15, -LZ),
  ...arc(15, -LZ + R, R, -Math.PI / 2, 0, 0.5),
  ...line(LX, -6 + 0.5, LX, 6 - 0.5),
  ...arc(15, 6, R, 0, Math.PI / 2, 0.5),
  ...line(14, LZ, -9, LZ),
];

describe('3층 순환형 주차장', () => {
  it('3개 층, 경사로 2개 14% 이하, 층 구분', () => {
    expect(C3_TERRAIN.levels.map((l) => l.name)).toEqual(['1F', '2F', '3F']);
    for (const r of C3_TERRAIN.surfaces) if (r.kind === 'ramp') expect((r.y1 - r.y0) / r.length).toBeLessThan(0.14);
    for (const y of C3_LEVEL_Y) expect(groundAt(C3_TERRAIN, 0, 0, y)).toBe(y);
    expect(groundAt(C3_TERRAIN, 0, -LZ, 3)).toBeNull(); // 경사로1 위 2F 개구부
  });
  for (const id of ['suv-x6', 'sedan', 'compact']) {
    it(`${id}: 입구 → 경사로1 → 순환 도로(직각 회전 2회) → 경사로2 → 3F 도달, 충돌/이탈 없음`, () => {
      const r = sim.drive(id, { x: -28, z: -LZ, h: Math.PI / 2, y: 0 }, route, (c) => c.y > 5.95 && c.x < -4, 2.0, 400, 3.2);
      expect(r.reached, `${id}: y=${r.car.y.toFixed(2)} x=${r.car.x.toFixed(1)} z=${r.car.z.toFixed(1)} col=${r.collisions} hit=${r.lastHit}`).toBe(true);
      expect(r.collisions).toBe(0);
      expect(r.offGround).toBe(0);
    });
  }
});
