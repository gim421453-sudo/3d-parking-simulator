import { describe, expect, it } from 'vitest';
import { G5_LEVEL_Y, G5_TERRAIN, MAP_GARAGE5 } from '../src/maps/mapGarage5';
import { groundAt, levelAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { arc, line, makeSim } from './helpers/driveSim';

const colliders = mapColliders(MAP_GARAGE5);
const sim = makeSim(G5_TERRAIN, colliders);
const L = 4.6;

/** 1F 입구 → 경사로 1(동) → 동쪽 U턴 → 경사로 2(서) → 서쪽 U턴 → … (n: 올라갈 경사로 수) */
function route(n: number): [number, number][] {
  const p: [number, number][] = [...line(-35, 0, -8, 0), ...line(-6, -1.5, -4, -L, 1)];
  for (let k = 1; k <= n; k++) {
    if (k % 2 === 1) {
      p.push(...line(0, -L, 27, -L));
      if (k < n) p.push(...arc(27, 0, L, -Math.PI / 2, Math.PI / 2, 0.5)); // 동쪽 U턴: (27,-L) → (27,+L)
    } else {
      p.push(...line(27, L, -5, L));
      if (k < n) p.push(...arc(-5, 0, L, Math.PI / 2, (3 * Math.PI) / 2, 0.5)); // 서쪽 U턴: (-5,+L) → (-5,-L)
    }
  }
  return p;
}

describe('5층 주차타워 지형', () => {
  it('5개 층(층고 3m), 경사로 4개 모두 14% 이하', () => {
    expect(G5_TERRAIN.levels.map((l) => l.name)).toEqual(['1F', '2F', '3F', '4F', '5F']);
    expect(G5_LEVEL_Y).toEqual([0, 3, 6, 9, 12]);
    const ramps = G5_TERRAIN.surfaces.filter((s) => s.kind === 'ramp');
    expect(ramps).toHaveLength(4);
    for (const r of ramps) if (r.kind === 'ramp') expect((r.y1 - r.y0) / r.length).toBeLessThan(0.14);
  });
  it('같은 평면 좌표에서 층 구분 (층 점프 방지) + 경사로 위 개구부', () => {
    for (const [i, y] of G5_LEVEL_Y.entries()) expect(groundAt(G5_TERRAIN, -20, 0, y), `${i + 1}F`).toBe(y);
    expect(groundAt(G5_TERRAIN, -20, 0, 1.5)).toBeNull();
    expect(levelAt(G5_TERRAIN, 8.8).name).toBe('4F');
    // 경사로1 위(z=-4.6, x=11)는 2F 바닥이 뚫려 있고, 경사로 높이가 선형
    expect(groundAt(G5_TERRAIN, 11, -L, 1.5)).toBeCloseTo(1.5, 6);
    expect(groundAt(G5_TERRAIN, 11, -L, 3)).toBeNull(); // 허공(개구부)
  });
});

describe('5층 주차타워 실제 주행 (순수 추종 시뮬레이션)', () => {
  for (const id of ['suv-x6', 'sedan', 'compact']) {
    it(`${id}: 1F 입구에서 4개 경사로를 모두 올라 5F(옥상)에 도달 — 충돌/지면 이탈 없음`, () => {
      const p = route(4);
      p.push(...line(-5, L, -8, L)); // 5F 도착
      const r = sim.drive(id, { x: -35, z: 0, h: Math.PI / 2, y: 0 }, p, (c) => c.y > 11.95 && c.x < -1, 2.0, 600, id === 'suv-x6' ? 3.4 : 3.0);
      expect(r.reached, `${id}: y=${r.car.y.toFixed(2)} x=${r.car.x.toFixed(1)} z=${r.car.z.toFixed(1)} h=${r.car.heading.toFixed(2)} col=${r.collisions} off=${r.offGround} hit=${r.lastHit}`).toBe(true);
      expect(r.collisions, `${id} 충돌`).toBe(0);
      expect(r.offGround, `${id} 이탈`).toBe(0);
    });
  }
  it('경사로 위 피치 ±(7.7°) 이내, 층 사이 허공으로 떨어지지 않음', () => {
    const { car } = sim.place('suv-x6', 11, -L, Math.PI / 2, 1.5);
    expect(car.pitch).toBeGreaterThan(0.12);
    expect(car.pitch).toBeLessThan(0.15);
  });
});
