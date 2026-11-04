import { describe, expect, it } from 'vitest';
import { findVehicleCollision, obbOverlap } from '../src/core/geometry';
import { MAPS, mapColliders } from '../src/maps';
import { evaluateParking } from '../src/mission/parking';
import { centerOf, createVehicleState, obbOf } from '../src/vehicle/physics';
import { VEHICLES } from '../src/vehicle/spec';

describe('맵 데이터 무결성', () => {
  it('기존 맵 4개 + 신규 맵(v0.4.9)이 등록되고 id가 고유하다', () => {
    for (const id of ['lot', 'underground', 'outdoor', 'tower']) expect(MAPS.some((m) => m.id === id), id).toBe(true);
    expect(MAPS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(MAPS.map((m) => m.id)).size).toBe(MAPS.length);
  });

  for (const map of MAPS) {
    describe(map.name, () => {
      const colliders = mapColliders(map);

      it('충돌체 id가 고유하다', () => {
        expect(new Set(colliders.map((c) => c.id)).size).toBe(colliders.length);
      });

      it('모든 차량이 시작 위치에서 장애물과 겹치지 않는다', () => {
        for (const v of VEHICLES) {
          const s = createVehicleState(v, map.spawn.x, map.spawn.z, map.spawn.heading);
          expect(findVehicleCollision(obbOf(s, v), colliders, map.terrain ? (map.spawn.y ?? 0) : undefined, map.terrain ? v.height : undefined), `${v.id} @ spawn`).toBeNull();
          for (const m of map.missions) {
            if (!m.spawn) continue;
            const ms = createVehicleState(v, m.spawn.x, m.spawn.z, m.spawn.heading);
            expect(findVehicleCollision(obbOf(ms, v), colliders, map.terrain ? (m.spawn.y ?? 0) : undefined, map.terrain ? v.height : undefined), `${v.id} @ ${m.id}`).toBeNull();
          }
        }
      });

      it('미션 목표 구획이 존재하고 비어 있으며 모든 차량이 규정 자세로 들어갈 수 있다', () => {
        for (const m of map.missions) {
          const slot = map.slots.find((s) => s.id === m.slotId);
          expect(slot, m.id).toBeDefined();
          for (const v of VEHICLES) {
            const heading =
              m.kind === 'perpendicular-reverse' ? slot!.dir + Math.PI : slot!.dir;
            const s = createVehicleState(v, slot!.x, slot!.z, heading);
            expect(findVehicleCollision(obbOf(s, v), colliders, map.terrain ? (slot!.y ?? 0) : undefined, map.terrain ? v.height : undefined), `${m.id}/${v.id} 구획이 막힘`).toBeNull();
            const c = centerOf(s, v);
            const r = evaluateParking({ x: c.x, z: c.z, heading, length: v.length, width: v.width, y: slot!.y }, slot!, m.kind);
            expect(r.poseOk, `${m.id}/${v.id} 성공 자세 불가`).toBe(true);
          }
        }
      });

      it('모든 장애물이 경계 안쪽에 있고 서로 겹치지 않는다(외벽/벽 제외)', () => {
        const b = map.bounds;
        const objs = map.obstacles.filter((o) => o.tag === 'car');
        for (const o of objs) {
          expect(o.x).toBeGreaterThan(b.minX);
          expect(o.x).toBeLessThan(b.maxX);
          expect(o.z).toBeGreaterThan(b.minZ);
          expect(o.z).toBeLessThan(b.maxZ);
        }
        for (let i = 0; i < objs.length; i++) {
          for (let j = i + 1; j < objs.length; j++) {
            const a = objs[i];
            const c = objs[j];
            if ((a.y0 ?? 0) !== (c.y0 ?? 0)) continue; // 다른 층은 같은 평면 좌표여도 겹침이 아니다
            const ov = obbOverlap(
              { x: a.x, z: a.z, rot: a.rot ?? 0, hw: a.w! / 2, hl: a.d! / 2 },
              { x: c.x, z: c.z, rot: c.rot ?? 0, hw: c.w! / 2, hl: c.d! / 2 },
            );
            expect(ov, `${a.id} ↔ ${c.id}`).toBe(false);
          }
        }
      });
    });
  }
});
