import { describe, expect, it } from 'vitest';
import { MAP_SPIRAL, SPIRAL_END, SP_TERRAIN } from '../src/maps/mapSpiral';
import { groundAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { localToWorld } from '../src/core/math';
import { line, makeSim } from './helpers/driveSim';

const colliders = mapColliders(MAP_SPIRAL);
const sim = makeSim(SP_TERRAIN, colliders);

describe('나선형 경사로 테스트 맵', () => {
  it('경사/폭: 평균 경사 10% 이하, 폭 5m 이상', () => {
    const sp = SP_TERRAIN.surfaces.find((s) => s.kind === 'spiral')!;
    if (sp.kind !== 'spiral') throw new Error();
    const arc = (sp.th1 - sp.th0) * ((sp.r0 + sp.r1) / 2);
    expect((sp.y1 - sp.y0) / arc).toBeLessThan(0.1);
    expect(sp.r1 - sp.r0).toBeGreaterThanOrEqual(4.99);
  });
  it('지상/상층 구분, 코어(중심)에는 지면이 없다(기둥)', () => {
    expect(groundAt(SP_TERRAIN, 6.7, -10, 0)).toBe(0);
    expect(groundAt(SP_TERRAIN, SPIRAL_END.x, SPIRAL_END.z, 3.2)).toBeCloseTo(3.2, 1);
  });
  for (const id of ['suv-x6', 'sedan', 'compact']) {
    it(`${id}: 지상 진입로 → 나선 1바퀴 → 상층 착지 데크 도착, 충돌/이탈 없음`, () => {
      const sp = SP_TERRAIN.surfaces.find((q) => q.kind === 'spiral')!;
      if (sp.kind !== 'spiral') throw new Error();
      const rm = (sp.r0 + sp.r1) / 2;
      const p: [number, number][] = [...line(rm, -16, rm, -1.5, 1)];
      for (let th = 0.1; th <= 1.85 * Math.PI; th += 0.07) p.push([rm * Math.cos(th), rm * Math.sin(th)]);
      const e = localToWorld(SPIRAL_END.x, SPIRAL_END.z, SPIRAL_END.heading, 0, 4);
      p.push([e.x, e.z]);
      const r = sim.drive(id, { x: rm, z: -16, h: 0, y: 0 }, p, (c) => c.y > 3.15 && Math.hypot(c.x - e.x, c.z - e.z) < 3, 2.0, 300, 3.0);
      expect(r.reached, `${id}: y=${r.car.y.toFixed(2)} x=${r.car.x.toFixed(1)} z=${r.car.z.toFixed(1)} col=${r.collisions} hit=${r.lastHit}`).toBe(true);
      expect(r.collisions).toBe(0);
      expect(r.offGround).toBe(0);
    });
  }
});
