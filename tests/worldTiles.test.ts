import { describe, expect, it } from 'vitest';
import { FloatingOrigin, TileStreamer, VIEW_RADIUS, WorldGrid, tileKey } from '../src/world/tiles';

describe('월드 타일 좌표', () => {
  const g = new WorldGrid(64);
  it('전역 ↔ 타일 로컬 왕복 (음수 좌표 포함), 로컬은 항상 0 ≤ v < size', () => {
    for (const [x, z] of [[0, 0], [63.99, 0.01], [64, 64], [-0.01, -64], [-130.5, 257.25], [12345.678, -98765.4321]]) {
      const l = g.toLocal(x, z);
      expect(l.lx).toBeGreaterThanOrEqual(0);
      expect(l.lx).toBeLessThan(64);
      expect(l.lz).toBeGreaterThanOrEqual(0);
      expect(l.lz).toBeLessThan(64);
      const w = g.toGlobal(l.tile, l.lx, l.lz);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.z).toBeCloseTo(z, 9);
    }
    expect(g.tileOf(-0.01, 0)).toEqual({ ix: -1, iz: 0 });
    expect(g.keyOf(64, -1)).toBe(tileKey(1, -1));
  });
  it('반경 안 타일: 일부라도 걸치면 포함, 멀면 제외', () => {
    const ts = g.tilesWithin(0, 0, 10).map((t) => tileKey(t.ix, t.iz)).sort();
    expect(ts).toEqual(['-1,-1', '-1,0', '0,-1', '0,0']);
    expect(g.tileWithin({ ix: 3, iz: 0 }, 0, 0, 100)).toBe(false); // 타일 3 은 x 192~256
    expect(g.tileWithin({ ix: 1, iz: 0 }, 0, 0, 100)).toBe(true);
  });
});

describe('타일 스트리밍(히스테리시스)', () => {
  it('가까워지면 로드, 멀어지면 언로드, 경계에서 왕복해도 깜박이지 않는다', () => {
    const g = new WorldGrid(64);
    const s = new TileStreamer(g, 100, 140);
    const u0 = s.update(0, 0);
    expect(u0.loaded.length).toBeGreaterThan(0);
    expect(u0.unloaded).toEqual([]);
    const far = '3,0'; // x 192~256
    expect(s.active.has(far)).toBe(false);
    s.update(100, 0); // 192-100 = 92 < 100 → 로드
    expect(s.active.has(far)).toBe(true);
    // 경계 왕복: 거리 92 ↔ 122 (언로드 반경 140 안) → 유지
    let flips = 0;
    for (let i = 0; i < 20; i++) {
      const u = s.update(i % 2 ? 100 : 70, 0);
      if (u.loaded.includes(far) || u.unloaded.includes(far)) flips++;
    }
    expect(flips).toBe(0);
    const u2 = s.update(0, 0); // 192 > 140 → 언로드
    expect(u2.unloaded).toContain(far);
    expect(s.active.has(far)).toBe(false);
  });
  it('내용이 있는 타일만 활성화 대상', () => {
    const g = new WorldGrid(64);
    const s = new TileStreamer(g, 200, 240, new Set(['0,0', '5,5']));
    s.update(0, 0);
    expect([...s.active]).toEqual(['0,0']);
  });
  it('화질별 가시 반경: 낮음 < 보통 < 높음, 언로드 > 로드', () => {
    expect(VIEW_RADIUS.low.load).toBeLessThan(VIEW_RADIUS.medium.load);
    expect(VIEW_RADIUS.medium.load).toBeLessThan(VIEW_RADIUS.high.load);
    for (const q of Object.values(VIEW_RADIUS)) expect(q.unload).toBeGreaterThan(q.load);
  });
});

describe('플로팅 오리진', () => {
  it('카메라가 step 안에 있으면 원점 유지, 벗어나면 격자점으로 이동', () => {
    const o = new FloatingOrigin(1024);
    expect(o.update(500, -900)).toBe(false);
    expect(o.update(1500, 0)).toBe(true);
    expect([o.x, o.z]).toEqual([1024, 0]);
    expect(o.update(1600, 100)).toBe(false);
    expect(o.shifts).toBe(1);
  });
  it('전역 100km 지점: float32 로 직접 쓰면 mm 단위 오차, 원점 이동 후 렌더 좌표는 0.1mm 미만 오차', () => {
    const o = new FloatingOrigin(1024);
    const gx = 100_000.123456;
    const gz = -87_654.654321;
    o.update(gx, gz);
    const direct = Math.abs(Math.fround(gx) - gx);
    const r = o.toRender(gx, gz);
    const shifted = Math.abs(Math.fround(r.x) - r.x);
    expect(direct).toBeGreaterThan(0.001); // float32 간격: 100km 에서 약 7.8mm (이 점은 1.5mm 오차)
    expect(shifted).toBeLessThan(0.0001);
    expect(Math.abs(r.x)).toBeLessThanOrEqual(1024);
    // 전역 좌표는 손상되지 않는다(왕복)
    const back = o.toGlobal(r.x, r.z);
    expect(back.x).toBeCloseTo(gx, 9);
    expect(back.z).toBeCloseTo(gz, 9);
  });
});
