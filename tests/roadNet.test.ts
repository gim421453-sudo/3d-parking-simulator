import { describe, expect, it } from 'vitest';
import { buildRoadNetGraph, findRoadNetRoute, largestComponent, nearestEdge, type RoadNet } from '../src/nav/roadNet';

/** 격자 도로망:  0 —— 1 —— 2
 *               |          |
 *               3 —— 4 —— 5   (1→4 없음, 4→5 일방통행 아님, 2→5 일방통행(아래로)) */
const net: RoadNet = {
  nodes: [
    [0, 0],
    [100, 0],
    [200, 0],
    [0, 100],
    [100, 100],
    [200, 100],
  ],
  edges: [
    [0, 1, 0],
    [1, 2, 0],
    [0, 3, 0],
    [3, 4, 0],
    [4, 5, 0],
    [2, 5, 1],
  ],
};
const g = buildRoadNetGraph(net);

describe('실제 도로망 경로 (v0.6.0)', () => {
  it('가장 가까운 간선 투영', () => {
    const h = nearestEdge(g, 150, 7)!;
    expect(h.z).toBeCloseTo(0, 9);
    expect(h.x).toBeCloseTo(150, 9);
    expect(h.d).toBeCloseTo(7, 9);
  });
  it('최단 경로: (10,0) → (200,60) 은 위쪽 길과 일방통행(2→5)을 탄다', () => {
    const r = findRoadNetRoute(g, { x: 10, z: 2 }, { x: 203, z: 60 })!;
    expect(r).not.toBeNull();
    expect(r.nodeIds).toEqual([1, 2]);
    expect(r.length).toBeLessThan(10 + 190 + 60 + 10);
  });
  it('일방통행 역주행 금지: (200,60) → (10,0) 는 2→5 를 거슬러 갈 수 없어 아래쪽으로 돈다', () => {
    const r = findRoadNetRoute(g, { x: 203, z: 60 }, { x: 10, z: 2 })!;
    expect(r).not.toBeNull();
    // 일방통행 간선(2→5) 위 출발 → 5 로만 나갈 수 있다 → 5,4,3,0
    expect(r.nodeIds).toEqual([5, 4, 3, 0]);
  });
  it('같은 간선 위 같은 방향이면 바로 간다', () => {
    const r = findRoadNetRoute(g, { x: 20, z: 1 }, { x: 80, z: -1 })!;
    expect(r.nodeIds).toEqual([]);
    expect(r.length).toBeCloseTo(62, 0);
  });
  it('도로망에서 너무 멀면 경로 없음', () => {
    expect(findRoadNetRoute(g, { x: 10, z: 2 }, { x: 600, z: 600 })).toBeNull();
  });
  it('연결 요소 크기', () => {
    expect(largestComponent(g)).toBe(6);
  });
});
