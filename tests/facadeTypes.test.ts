import { describe, expect, it } from 'vitest';
import { ATLAS_COLS, ATLAS_ROWS, FACADE_CELLS, cellOffset, facadeStyleOf, hipRoof } from '../src/world/facadeTypes';

describe('v0.6.3 건물 외벽 유형(아틀라스)', () => {
  it('아틀라스 칸 12개가 4×3 격자 안에 겹치지 않게 놓인다', () => {
    expect(FACADE_CELLS.length).toBe(ATLAS_COLS * ATLAS_ROWS);
    const seen = new Set<string>();
    for (const c of FACADE_CELLS) {
      const [u, v] = cellOffset(c);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(u + 1 / ATLAS_COLS).toBeLessThanOrEqual(1 + 1e-9);
      expect(v + 1 / ATLAS_ROWS).toBeLessThanOrEqual(1 + 1e-9);
      seen.add(`${u},${v}`);
    }
    expect(seen.size).toBe(FACADE_CELLS.length);
  });
  it('OSM 건물 종류별 외벽: 아파트·주택(모임지붕)·상가(1층 출입구)·공장·창고·학교·주차', () => {
    expect(facadeStyleOf({ k: 'apartments', h: 46 }, 900).main).toBe('apartment');
    const house = facadeStyleOf({ k: 'house', h: 6.8 }, 90);
    expect(house.main).toBe('house');
    expect(house.roof).toBe('hip');
    const shop = facadeStyleOf({ k: 'retail', h: 10 }, 300);
    expect(shop.main).toBe('shop');
    expect(shop.ground).toBe('shopGround');
    expect(facadeStyleOf({ k: 'industrial', h: 7 }, 800).main).toBe('factory');
    expect(facadeStyleOf({ k: 'warehouse', h: 8 }, 1200).main).toBe('warehouse');
    expect(facadeStyleOf({ k: 'school', h: 13 }, 1500).main).toBe('school');
    expect(facadeStyleOf({ k: 'parking', h: 15, lv: 5 }, 900).main).toBe('parking');
    expect(facadeStyleOf({ k: 'office', h: 40 }, 700).main).toBe('office');
  });
  it('층고는 층수 태그가 있으면 높이/층수(2.6~4.5m) — 층마다 창이 하나씩 반복', () => {
    expect(facadeStyleOf({ k: 'apartments', h: 15 * 3 + 1, lv: 15 }, 800).floor).toBeCloseTo((46 - 0.8) / 15, 5);
    expect(facadeStyleOf({ k: 'yes', h: 100, lv: 2 }, 800).floor).toBe(4.5);
  });
  it('생성 건물(실제 아님)은 실제 건물 칸을 쓰지 않는다(genBlock/genIndustrial — 창문·반사 없음)', () => {
    for (const gk of ['house', 'villa', 'shop', 'factory', 'warehouse']) {
      const st = facadeStyleOf({ k: 'gen', g: 1, gk, h: 9, lv: 3 }, 100);
      expect(['genBlock', 'genIndustrial']).toContain(st.main);
      expect(['genBlock', 'genIndustrial']).toContain(st.ground);
    }
  });
  it('모임지붕: 직사각형만, 모든 처마점이 바닥 높이·용마루는 위, 넓이 기준 삼각형 수 4~6', () => {
    const o: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 7],
      [0, 7],
    ];
    const t = hipRoof(o, 5)!;
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(6);
    for (const tri of t) for (const p of tri) expect(p[1]).toBeGreaterThanOrEqual(5);
    expect(Math.max(...t.flat().map((p) => p[1]))).toBeCloseTo(5 + Math.min(2.2, 7 * 0.3), 5);
    expect(hipRoof([[0, 0], [5, 0], [2, 4]], 0)).toBeNull();
  });
});
