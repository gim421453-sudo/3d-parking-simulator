import { describe, expect, it, vi } from 'vitest';
import { findVehicleCollision, obbOverlap, type Collider } from '../src/core/geometry';
import { MAPS, mapColliders } from '../src/maps';
import { groundAt, headroomAt, rampProfile, surfaceHeight } from '../src/maps/terrain';
import type { MapData } from '../src/maps/types';
import { obbOf } from '../src/vehicle/physics';
import { startState } from '../src/sim/autodrive';
import { getVehicle } from '../src/vehicle/spec';

vi.setConfig({ testTimeout: 120000 });

/**
 * 맵 자동 검사 (v0.5.4): 모든 맵의 구조 데이터를 같은 규칙으로 검사한다. 새 맵은 MAPS 에 추가하면 자동으로 검사된다.
 */
const boxOf = (c: Collider): { x: number; z: number; rot: number; hw: number; hl: number } | null => (c.kind === 'box' ? { x: c.x, z: c.z, rot: c.rot, hw: c.w / 2, hl: c.d / 2 } : null);
const vOverlap = (a: Collider, b: Collider): boolean => a.y0 < b.y0 + b.h - 0.05 && b.y0 < a.y0 + a.h - 0.05;
const spawnsOf = (m: MapData): { x: number; z: number; heading: number; y?: number; id: string }[] => [{ ...m.spawn, id: 'spawn' }, ...m.missions.filter((q) => q.spawn).map((q) => ({ ...q.spawn!, id: q.id }))];

describe('맵 자동 검사: 모든 맵', () => {
  for (const m of MAPS) {
    describe(m.id, () => {
      const cols = mapColliders(m);
      it('충돌체 ID 가 유일하고 완전히 겹친 중복 충돌체가 없다', () => {
        const ids = cols.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        const sig = new Map<string, string>();
        for (const c of cols) {
          const k = c.kind === 'box' ? `b|${c.x.toFixed(3)}|${c.z.toFixed(3)}|${c.w.toFixed(3)}|${c.d.toFixed(3)}|${c.rot.toFixed(3)}|${c.y0.toFixed(2)}|${c.h.toFixed(2)}` : `c|${c.x.toFixed(3)}|${c.z.toFixed(3)}|${c.r.toFixed(3)}|${c.y0.toFixed(2)}`;
          expect(sig.get(k), `${m.id}: ${c.id} = ${sig.get(k)}`).toBeUndefined();
          sig.set(k, c.id);
        }
      });
      it('시작 위치(맵/미션)는 지면 위이고 세단·대형 SUV 가 어떤 충돌체와도 겹치지 않는다', () => {
        for (const sp of spawnsOf(m)) {
          for (const id of ['sedan', 'suv-x6']) {
            const spec = getVehicle(id);
            const car = startState(m, spec, sp.x, sp.z, sp.heading, sp.y ?? 0);
            if (m.terrain) expect(groundAt(m.terrain, car.x, car.z, sp.y ?? 0), `${m.id}/${sp.id}`).not.toBeNull();
            const lv = !!(m.terrain || m.mech);
            const hit = findVehicleCollision(obbOf(car, spec), cols, lv ? car.y : undefined, lv ? spec.height : undefined);
            expect(hit?.id, `${m.id}/${sp.id}/${id}`).toBeUndefined();
          }
        }
      });
      it('주차칸: 크기가 정상 범위이고 맵 경계 안이며(다층은 그 층 바닥 위), 벽/기둥/건물이 칸 중심을 막지 않는다', () => {
        for (const s of m.slots) {
          expect(s.w, `${m.id}/${s.id} 폭`).toBeGreaterThanOrEqual(1.9);
          expect(s.w).toBeLessThanOrEqual(3.6);
          expect(s.l, `${m.id}/${s.id} 길이`).toBeGreaterThanOrEqual(4.5);
          expect(s.l).toBeLessThanOrEqual(7);
          expect(s.x).toBeGreaterThan(m.bounds.minX);
          expect(s.x).toBeLessThan(m.bounds.maxX);
          expect(s.z).toBeGreaterThan(m.bounds.minZ);
          expect(s.z).toBeLessThan(m.bounds.maxZ);
          const y = s.y ?? 0;
          if (m.terrain) {
            const g = groundAt(m.terrain, s.x, s.z, y, 0.3);
            expect(g, `${m.id}/${s.id} 바닥`).not.toBeNull();
            expect(headroomAt(m.terrain, s.x, s.z, y), `${m.id}/${s.id} 천장`).toBeGreaterThanOrEqual(1.75);
          }
          // 칸 중심 0.6m 사각형 안에 고정 구조물(주차 차량/낮은 가이드 제외)이 없어야 한다
          const probe = { x: s.x, z: s.z, rot: s.dir, hw: 0.3, hl: 0.3 };
          for (const c of cols) {
            if (c.tag === 'car' || c.tag === 'guide' || c.tag === 'curb') continue;
            if (c.y0 + c.h <= y + 0.2 || c.y0 >= y + 1.5) continue;
            const b = boxOf(c);
            if (b) expect(obbOverlap(probe, b), `${m.id}/${s.id} 안에 ${c.id}`).toBe(false);
            else if (c.kind === 'cyl') expect(Math.hypot(c.x - s.x, c.z - s.z) > c.r + 0.3, `${m.id}/${s.id} 안에 ${c.id}`).toBe(true);
          }
        }
      });
      it('주차된 차량은 벽/기둥/건물/다른 주차 차량과 겹치지 않는다(같은 층)', () => {
        const cars = cols.filter((c) => c.tag === 'car');
        const solids = cols.filter((c) => ['wall', 'pillar', 'building'].includes(c.tag));
        for (const a of cars) {
          const ba = boxOf(a)!;
          // 차체 외곽에서 5cm 안쪽으로 줄여 접촉(딱 붙음)은 허용
          const shr = { ...ba, hw: ba.hw - 0.05, hl: ba.hl - 0.05 };
          for (const b of solids) {
            if (!vOverlap(a, b)) continue;
            const bb = boxOf(b);
            if (bb) expect(obbOverlap(shr, bb), `${m.id}: ${a.id} ∩ ${b.id}`).toBe(false);
          }
          for (const b of cars) {
            if (b === a || !vOverlap(a, b) || a.id > b.id) continue;
            expect(obbOverlap(shr, boxOf(b)!), `${m.id}: ${a.id} ∩ ${b.id}`).toBe(false);
          }
        }
      });
      if (m.terrain) {
        const t = m.terrain;
        it('층: 이름/높이가 정의되어 있고, 위아래로 겹친 층 바닥(데크)은 층고 ≥ 2.4m', () => {
          expect(t.levels.length).toBeGreaterThanOrEqual(2);
          for (const l of t.levels) expect(l.name.length).toBeGreaterThan(0);
          const decks = t.surfaces.filter((q) => q.kind === 'deck');
          for (const up of decks) {
            if (up.kind !== 'deck') continue;
            // 위 데크의 표본점 아래에 다른 데크가 있으면(평면상 겹침) 높이 차가 충분해야 한다. 같은 높이(이어 붙인 바닥/지붕 슬래브)는 제외
            for (const [fx, fz] of [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) {
              const x = up.rect.x + fx * up.rect.w;
              const z = up.rect.z + fz * up.rect.d;
              if (surfaceHeight(up, x, z) === null) continue;
              for (const lo of decks) {
                if (lo === up || lo.kind !== 'deck') continue;
                const h = surfaceHeight(lo, x, z);
                if (h === null || h >= up.y - 0.05) continue;
                // 아래 공간이 1.4m 미만이면 차량이 들어갈 수 없는 단(연단/플랫폼)이다 — 천장 높이 검사(headroomAt)가 진입을 막는다. 그 사이(1.4~2.4m)는 금지
                const gap = up.y - (up.thickness ?? 0.3) - h;
                if (gap < 1.4) continue;
                expect(up.y - h, `${m.id}: ${lo.id}(${h}) 위 ${up.id}(${up.y})`).toBeGreaterThanOrEqual(2.4);
              }
            }
          }
        });
        it('경사로/나선의 양 끝이 다른 면(데크/경사로)과 높이가 이어진다(단차 ≤ 15cm)', () => {
          for (const s of t.surfaces) {
            if (s.kind === 'deck') continue;
            const ends: { x: number; z: number; y: number; name: string }[] = [];
            if (s.kind === 'ramp') {
              const fx = Math.sin(s.rot);
              const fz = Math.cos(s.rot);
              ends.push({ x: s.x - fx * 0.4, z: s.z - fz * 0.4, y: s.y0, name: 'start' }, { x: s.x + fx * (s.length + 0.4), z: s.z + fz * (s.length + 0.4), y: s.y1, name: 'end' });
              // 경사로 자체의 양 끝 높이
              expect(s.y0 + (s.y1 - s.y0) * rampProfile(0, s.length, s.ease)).toBeCloseTo(s.y0, 9);
              expect(s.y0 + (s.y1 - s.y0) * rampProfile(s.length, s.length, s.ease)).toBeCloseTo(s.y1, 9);
            } else {
              const rm = (s.r0 + s.r1) / 2;
              const dir = Math.sign(s.th1 - s.th0);
              for (const [th, y, sg, name] of [[s.th0, s.y0, -1, 'start'], [s.th1, s.y1, 1, 'end']] as const) {
                ends.push({ x: s.cx + rm * Math.cos(th) + -Math.sin(th) * dir * sg * 0.5, z: s.cz + rm * Math.sin(th) + Math.cos(th) * dir * sg * 0.5, y, name });
              }
            }
            for (const e of ends) {
              const others = t.surfaces.filter((q) => q !== s).map((q) => surfaceHeight(q, e.x, e.z)).filter((h): h is number => h !== null);
              const best = others.length ? Math.min(...others.map((h) => Math.abs(h - e.y))) : Infinity;
              expect(best, `${m.id}/${s.id} ${e.name} (y=${e.y})`).toBeLessThanOrEqual(0.15);
            }
          }
        });
        it('천장 간격: 각 층 주차칸과 시작 위치에서 대형 SUV(1.70m)가 설 수 있다', () => {
          const suv = getVehicle('suv-x6');
          for (const sp of spawnsOf(m)) expect(headroomAt(t, sp.x, sp.z, sp.y ?? 0), `${m.id}/${sp.id}`).toBeGreaterThanOrEqual(suv.height);
        });
      }
      if (m.roads?.length) {
        it('도로 위(차로 폭)에 건물/벽/기둥/주차 차량이 없다', () => {
          const solids = cols.filter((c) => ['wall', 'pillar', 'building', 'car', 'planter'].includes(c.tag) && !/^edge|:edge/.test(c.id) && c.y0 < 1.2 && c.y0 + c.h > 0.25);
          for (const r of m.roads!) {
            if (r.kind === 'ramp') continue;
            const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
            const rot = Math.atan2(r.bx - r.ax, r.bz - r.az);
            // 도로 양 끝 1m 는 접속부(구역 입구 벽과 맞닿음)라 제외, 가장자리 0.4m 여유
            const o = { x: (r.ax + r.bx) / 2, z: (r.az + r.bz) / 2, rot, hw: r.width / 2 - 0.4, hl: Math.max(0.1, len / 2 - 1) };
            for (const c of solids) {
              const b = boxOf(c);
              if (b) expect(obbOverlap(o, b), `${m.id}: 도로 ${r.id} 위에 ${c.id}`).toBe(false);
            }
          }
        });
        it('도로끼리 이어져 있다: 모든 도로 구간의 양 끝이 다른 도로 위(또는 구역/경사로 접속점)에 닿는다', () => {
          const onAny = (x: number, z: number, self: string): boolean =>
            m.roads!.some((r) => {
              if (r.id === self) return false;
              const dx = r.bx - r.ax;
              const dz = r.bz - r.az;
              const l2 = dx * dx + dz * dz;
              const u = Math.max(0, Math.min(1, ((x - r.ax) * dx + (z - r.az) * dz) / l2));
              return Math.hypot(x - (r.ax + dx * u), z - (r.az + dz * u)) <= r.width / 2 + 0.5;
            });
          for (const r of m.roads!) {
            const a = onAny(r.ax, r.az, r.id);
            const b = onAny(r.bx, r.bz, r.id);
            // 진입로(access)/경사로는 한쪽 끝이 구역 입구/지하로 이어진다 → 한쪽만 도로에 닿으면 된다
            if (r.kind === 'access' || r.kind === 'ramp') expect(a || b, `${m.id}/${r.id}`).toBe(true);
            else expect(a && b, `${m.id}/${r.id}`).toBe(true);
          }
        });
      }
    });
  }
});
