import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../src/core/geometry';
import { footprintBoxes, mainAxis, pointInPoly, polyArea, type Pt } from '../src/world/footprint';

const rotPoly = (p: Pt[], a: number, ox = 0, oz = 0): Pt[] => p.map(([x, z]) => [ox + x * Math.cos(a) - z * Math.sin(a), oz + x * Math.sin(a) + z * Math.cos(a)]);
/** 상자 꼭짓점 (게임 규칙: 로컬 x 축 = (cos rot, −sin rot), 로컬 z 축 = (sin rot, cos rot)) */
const corners = (b: { x: number; z: number; w: number; d: number; rot: number }): Pt[] => {
  const ax: Pt = [Math.cos(b.rot), -Math.sin(b.rot)];
  const az: Pt = [Math.sin(b.rot), Math.cos(b.rot)];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => [b.x + (ax[0] * sx * b.w) / 2 + (az[0] * sz * b.d) / 2, b.z + (ax[1] * sx * b.w) / 2 + (az[1] * sz * b.d) / 2]);
};

describe('건물 바닥 → 충돌 상자 (v0.6.0)', () => {
  it('회전한 직사각형(20×12m, 0.6rad)은 상자 1개, 크기/방향이 같다', () => {
    const p = rotPoly(
      [
        [-10, -6],
        [10, -6],
        [10, 6],
        [-10, 6],
      ],
      0.6,
      30,
      -40,
    );
    const bs = footprintBoxes(p, 1);
    expect(bs.length).toBe(1);
    const b = bs[0];
    expect(b.x).toBeCloseTo(30, 6);
    expect(b.z).toBeCloseTo(-40, 6);
    expect(Math.max(b.w, b.d)).toBeCloseTo(20, 6);
    expect(Math.min(b.w, b.d)).toBeCloseTo(12, 6);
    // 꼭짓점이 원래 다각형 꼭짓점과 일치
    for (const q of corners(b)) expect(Math.min(...p.map((r) => Math.hypot(r[0] - q[0], r[1] - q[1])))).toBeLessThan(1e-6);
  });
  it('ㄱ자 건물은 여러 상자로 나뉘고, 빈 모서리를 막지 않으며 면적이 거의 같다', () => {
    const L: Pt[] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ];
    const bs = footprintBoxes(L, 1);
    expect(bs.length).toBeGreaterThanOrEqual(2);
    const total = bs.reduce((a, b) => a + b.w * b.d, 0);
    expect(total).toBeGreaterThan(polyArea(L) * 0.95);
    expect(total).toBeLessThan(polyArea(L) * 1.05);
    // 비어 있는 모서리(20,20) 부근에 상자가 없다
    for (const b of bs) expect(obbOverlap({ x: 20, z: 20, rot: 0, hw: 4, hl: 4 }, { x: b.x, z: b.z, rot: b.rot, hw: b.w / 2, hl: b.d / 2 })).toBe(false);
    // 모든 상자 중심은 다각형 안
    for (const b of bs) expect(pointInPoly(L, b.x, b.z)).toBe(true);
  });
  it('주축: 긴 변 방향(최소 면적 사각형)', () => {
    const p = rotPoly(
      [
        [-15, -3],
        [15, -3],
        [15, 3],
        [-15, 3],
      ],
      1.1,
    );
    const a = mainAxis(p);
    expect(Math.abs(Math.sin(a - 1.1) * Math.cos(a - 1.1))).toBeLessThan(1e-6); // 1.1 또는 1.1±π/2
  });
  it('작은 건물(4×5m)도 사라지지 않는다', () => {
    const bs = footprintBoxes(
      [
        [0, 0],
        [4, 0],
        [4, 5],
        [0, 5],
      ],
      1,
    );
    expect(bs.reduce((a, b) => a + b.w * b.d, 0)).toBeCloseTo(20, 3);
  });
});
