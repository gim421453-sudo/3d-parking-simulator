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
      for (const c of q.corners) expect(worldToLocal(pose.x, pose.z, pose.heading, c.x, c.z).z).toBeLessThan(-spec.length / 2 + 0.2); // 모서리 센서(넓은 시야)의 비스듬한 구역 허용
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
    for (const q of z) expect(Object.keys(q).sort()).toEqual(['colliderIds', 'corners', 'group', 'hits', 'level', 'sensorId']);
  });
});

import { buildBoundaryCells, buildCameraTiles, CELL_MAX, CELL_MAX_GAP, TILE_COUNT } from '../src/pdc/overlay';
import { guideCutDistance } from '../src/pdc/guidelines';
import { localToWorld as l2w } from '../src/core/math';

describe('전/후방 카메라 타일 (가로 6칸)', () => {
  const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
  const rearWall = (gap: number, w = 12, cx = 0): Collider => wall(cx, -(spec.length / 2 + gap + 0.25), w, 0.5);
  it('넓은 벽: 감지된 칸만 점등, 최대 6칸, 각 타일은 차체 뒤쪽 바닥에 있고 장애물 표면과 일치', () => {
    const sn = snapOf([rearWall(1.0)]);
    const t = buildCameraTiles(sn, spec, body, 'rear', 3, 0.5);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(TILE_COUNT);
    for (const q of t) {
      for (const c of q.corners) {
        const l = worldToLocal(0, 0, 0, c.x, c.z);
        expect(l.z).toBeLessThan(-spec.length / 2 + 1e-6);
        expect(l.z).toBeGreaterThanOrEqual(-spec.length / 2 - 1.0 - 0.01); // 표면(간격 1.0m)을 넘지 않는다
      }
    }
  });
  it('좁은 장애물(폭 0.6m 중앙): 해당 칸만 점등되고 나머지 칸은 소등', () => {
    const t = buildCameraTiles(snapOf([rearWall(0.8, 0.6, 0)]), spec, body, 'rear', 3, 0.5);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThan(TILE_COUNT);
  });
  it('왼쪽에만 장애물이 있으면 왼쪽(+x) 칸만, 오른쪽만이면 오른쪽 칸만', () => {
    const left = buildCameraTiles(snapOf([rearWall(0.8, 1.0, 0.8)]), spec, body, 'rear', 3, 0.5);
    const right = buildCameraTiles(snapOf([rearWall(0.8, 1.0, -0.8)]), spec, body, 'rear', 3, 0.5);
    const cx = (z: { corners: { x: number; z: number }[] }) => z.corners.reduce((a, c) => a + c.x, 0) / 4;
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect(left.every((q) => cx(q) > 0)).toBe(true);
    expect(right.every((q) => cx(q) < 0)).toBe(true);
  });
  it('가까울수록 단계가 높아지고, 감지 없음/전방 장애물만이면 후방 타일 없음', () => {
    const rank = { far: 1, mid: 2, near: 3, critical: 4 } as const;
    const lv = (g: number) => Math.max(...buildCameraTiles(snapOf([rearWall(g)]), spec, body, 'rear', 3, 0.5).map((q) => rank[q.level]));
    expect(lv(0.3)).toBeGreaterThan(lv(2.2));
    expect(buildCameraTiles(snapOf([]), spec, body, 'rear', 3, 0.5)).toEqual([]);
    expect(buildCameraTiles(snapOf([wall(0, spec.length / 2 + 1.0 + 0.25, 8, 0.5)]), spec, body, 'rear', 3, 0.5)).toEqual([]);
    expect(buildCameraTiles(null, spec, body, 'rear', 3, 0.5)).toEqual([]);
  });
  it('전방 타일은 앞쪽(+z) 바닥', () => {
    const t = buildCameraTiles(snapOf([wall(0, spec.length / 2 + 0.9 + 0.25, 8, 0.5)]), spec, body, 'front', 3, 0.5);
    expect(t.length).toBeGreaterThan(0);
    for (const q of t) for (const c of q.corners) expect(c.z).toBeGreaterThan(spec.length / 2 - 1e-6);
  });
});

describe('3D/탑뷰 장애물 경계 셀', () => {
  const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
  it('차체 근처 히트만 셀로 표시하고 먼 장애물(>1.8m)은 표시하지 않는다', () => {
    const near = buildBoundaryCells(snapOf([wall(spec.width / 2 + 0.8 + 0.25, 0, 0.5, 6)]), body, 3, 0.5);
    expect(near.length).toBeGreaterThan(0);
    const far = buildBoundaryCells(snapOf([wall(spec.width / 2 + 2.6 + 0.25, 0, 0.5, 6)]), body, 3, 0.5);
    expect(far).toEqual([]);
    expect(CELL_MAX_GAP).toBe(1.8);
  });
  it('모든 셀은 실제 히트점이 있는 위치이며 개수 상한 이내, 감지 없으면 없음', () => {
    const cells = buildBoundaryCells(snapOf([wall(spec.width / 2 + 0.6 + 0.25, 0, 0.5, 9), wall(-(spec.width / 2 + 0.6 + 0.25), 0, 0.5, 9)]), body, 3, 0.5);
    expect(cells.length).toBeLessThanOrEqual(CELL_MAX);
    expect(buildBoundaryCells(snapOf([]), body, 3, 0.5)).toEqual([]);
    expect(buildBoundaryCells(null, body, 3, 0.5)).toEqual([]);
  });
  it('가까운 셀일수록 높은 단계', () => {
    const rank = { far: 1, mid: 2, near: 3, critical: 4 } as const;
    const a = buildBoundaryCells(snapOf([wall(spec.width / 2 + 0.3 + 0.25, 0, 0.5, 6)]), body, 3, 0.5);
    const b = buildBoundaryCells(snapOf([wall(spec.width / 2 + 1.5 + 0.25, 0, 0.5, 6)]), body, 3, 0.5);
    expect(Math.max(...a.map((q) => rank[q.level]))).toBeGreaterThan(Math.max(...b.map((q) => rank[q.level])));
  });
});

describe('예측선 장애물 직전 절단', () => {
  const pose = { x: 0, z: 0, heading: 0 };
  it('전방에 벽이 있으면 벽 앞까지만, 없으면 전체 길이', () => {
    expect(guideCutDistance(spec, 0, 1, pose, [], 0.55)).toBe(4.5);
    const cut = guideCutDistance(spec, 0, 1, pose, [wall(0, spec.length / 2 + 2.0 + 0.25, 8, 0.5)], 0.55);
    expect(cut).toBeGreaterThan(1.5);
    expect(cut).toBeLessThanOrEqual(2.0);
  });
  it('후진: 뒤쪽 벽 직전, 센서 높이에 닿지 않는 낮은 연석은 무시', () => {
    const cut = guideCutDistance(spec, 0, -1, pose, [wall(0, -(spec.length / 2 + 1.0 + 0.25), 8, 0.5)], 0.55);
    expect(cut).toBeLessThanOrEqual(1.0);
    const curb: Collider = { kind: 'box', id: 'c', tag: 'curb', x: 0, z: -(spec.length / 2 + 1.0), w: 8, d: 0.4, rot: 0, y0: 0, h: 0.15 };
    expect(guideCutDistance(spec, 0, -1, pose, [curb], 0.55)).toBe(4.5);
  });
  it('조향해도 경로 모양은 같고 길이만 잘린다 (물리와 동일한 경로)', () => {
    const cut = guideCutDistance(spec, 0.4, 1, pose, [wall(2.5, spec.length / 2 + 2.0, 6, 0.5)], 0.55);
    expect(cut).toBeLessThanOrEqual(4.5);
    expect(l2w(0, 0, 0, 1, 1).x).toBeCloseTo(1, 5);
  });
});

import { buildWarnLines, LINE_MAX_GAP } from '../src/pdc/overlay';
describe('서라운드/집중뷰 경고선 (외곽을 따라가는 선)', () => {
  const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
  it('감지가 없으면 선이 없고, 먼 장애물(>1.8m)은 선을 만들지 않는다', () => {
    expect(buildWarnLines(snapOf([]), body, 3, 0.5)).toEqual([]);
    expect(buildWarnLines(null, body, 3, 0.5)).toEqual([]);
    expect(buildWarnLines(snapOf([wall(spec.width / 2 + 2.4 + 0.25, 0, 0.5, 6)]), body, 3, 0.5)).toEqual([]);
    expect(LINE_MAX_GAP).toBe(1.8);
  });
  it('왼쪽 벽: 왼쪽 외곽(+x) 바깥쪽에만 선이 생기고 실제 벽 구간에만 있다', () => {
    const ls = buildWarnLines(snapOf([wall(spec.width / 2 + 0.8 + 0.25, 0, 0.5, 3)]), body, 3, 0.5);
    expect(ls.length).toBeGreaterThan(2);
    for (const l of ls) {
      expect(l.id.startsWith('wl-L')).toBe(true);
      for (const p of [l.a, l.b]) {
        expect(p.x).toBeGreaterThan(spec.width / 2);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(1.6); // 벽(길이 3m) 구간 + 센서 분해능
      }
    }
  });
  it('가까울수록 단계가 높고 선이 차체에 가깝다 (간격 비례 오프셋)', () => {
    const rank = { far: 1, mid: 2, near: 3, critical: 4 } as const;
    const near = buildWarnLines(snapOf([wall(spec.width / 2 + 0.3 + 0.25, 0, 0.5, 4)]), body, 3, 0.5);
    const far = buildWarnLines(snapOf([wall(spec.width / 2 + 1.5 + 0.25, 0, 0.5, 4)]), body, 3, 0.5);
    expect(Math.max(...near.map((l) => rank[l.level]))).toBeGreaterThan(Math.max(...far.map((l) => rank[l.level])));
    const off = (ls: typeof near) => Math.min(...ls.map((l) => l.a.x - spec.width / 2));
    expect(off(near)).toBeLessThan(off(far));
  });
  it('뒤 벽은 뒤쪽(-z), 앞 벽은 앞쪽(+z) 외곽에', () => {
    const b = buildWarnLines(snapOf([wall(0, -(spec.length / 2 + 0.7 + 0.25), 4, 0.5)]), body, 3, 0.5);
    expect(b.length).toBeGreaterThan(0);
    expect(b.some((l) => l.id.startsWith('wl-B'))).toBe(true);
    for (const l of b) for (const p of [l.a, l.b]) expect(p.z).toBeLessThan(-spec.length / 2 + 0.7); // 뒤쪽 반 (모서리 쪽 측면 선 포함)
    const f = buildWarnLines(snapOf([wall(0, spec.length / 2 + 0.7 + 0.25, 4, 0.5)]), body, 3, 0.5);
    expect(f.some((l) => l.id.startsWith('wl-F'))).toBe(true);
    for (const l of f) for (const p of [l.a, l.b]) expect(p.z).toBeGreaterThan(spec.length / 2 - 0.7);
  });
  it('작은 기둥도 선이 생긴다', () => {
    const ls = buildWarnLines(snapOf([wall(spec.width / 2 + 0.6 + 0.25, 0.3, 0.5, 0.5)]), body, 3, 0.5);
    expect(ls.length).toBeGreaterThan(0);
  });
});

describe('수직 경고 패널 데이터 (v0.4.8)', () => {
  const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
  const rearWall = (gap: number, w = 12, cx = 0, h = 1.2): Collider => ({ ...wall(cx, -(spec.length / 2 + gap + 0.25), w, 0.5), h });
  it('전/후방 타일은 모두 panelHeight 를 갖고(수직 패널), 밑변(corners[3]→[2])이 장애물 표면에 놓인다', () => {
    const t = buildCameraTiles(snapOf([rearWall(1.0)]), spec, body, 'rear', 3, 0.5);
    expect(t.length).toBeGreaterThan(0);
    for (const q of t) {
      expect(q.panelHeight).toBeGreaterThan(0.3);
      const a = worldToLocal(0, 0, 0, q.corners[3].x, q.corners[3].z);
      const b = worldToLocal(0, 0, 0, q.corners[2].x, q.corners[2].z);
      expect(a.z).toBeCloseTo(b.z, 6); // 폭 방향 밑변은 차체 폭과 평행
      expect(-a.z - spec.length / 2).toBeCloseTo(1.0, 0); // 표면까지 약 1.0m
    }
  });
  it('패널 높이는 실제 충돌체 윗면(topOf)에서 정해지고 상/하한으로 제한된다 — 없는 높이를 만들지 않음', () => {
    const sn = snapOf([rearWall(1.0, 12, 0, 1.2)]);
    const low = buildCameraTiles(sn, spec, body, 'rear', 3, 0.5, () => 0.6, 0);
    expect(low.every((q) => Math.abs((q.panelHeight ?? 0) - 0.6) < 1e-9)).toBe(true);
    const tall = buildCameraTiles(sn, spec, body, 'rear', 3, 0.5, () => 3.0, 0);
    expect(tall.every((q) => (q.panelHeight ?? 0) <= 1.3 + 1e-9)).toBe(true);
    const elevated = buildCameraTiles(sn, spec, body, 'rear', 3, 0.5, () => 4.6, 4.0); // 다층: 기준 높이 상대
    expect(elevated.every((q) => Math.abs((q.panelHeight ?? 0) - 0.6) < 1e-9)).toBe(true);
  });
  it('좁은 기둥: 인접한 감지 안 된 칸까지 패널을 늘리지 않는다', () => {
    const pillar = (gap: number): Collider => ({ kind: 'cyl', id: 'p', tag: 'pillar', x: 0, z: -(spec.length / 2 + gap + 0.15), r: 0.15, y0: 0, h: 3 });
    const t = buildCameraTiles(snapOf([pillar(0.8)]), spec, body, 'rear', 3, 0.5);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(2);
    for (const q of t) {
      const xs = [q.corners[2].x, q.corners[3].x];
      expect(Math.abs(xs[0] - xs[1])).toBeLessThan((spec.width + 0.7) / TILE_COUNT + 1e-6);
    }
  });
  it('후방 카메라 타일의 왼쪽/오른쪽이 뒤집히지 않는다 (왼쪽 장애물 → +x 쪽 칸)', () => {
    const left = buildCameraTiles(snapOf([rearWall(0.8, 1.0, 0.8)]), spec, body, 'rear', 3, 0.5);
    const cx = (z: { corners: { x: number }[] }) => (z.corners[2].x + z.corners[3].x) / 2;
    expect(left.every((q) => cx(q) > 0)).toBe(true);
  });
});
