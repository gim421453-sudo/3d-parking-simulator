import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../src/core/geometry';
import { BASE_MAPS, MAPS, MECH_ANNEX, getMap, mapColliders } from '../src/maps';
import { FACILITY_FOOTPRINT, facilityKit, footprintObb } from '../src/maps/mechKit';
import { capacityOf, frameOf, headingToLocal, headingToWorld, makeFacility, toLocalXZ, toWorldXZ } from '../src/mech/facility';
import { MechController } from '../src/mech/controller';
import { SLOTS, STATION, freeSlots, hasSlot, newMachine, startStore, toggleOccupant } from '../src/mech/machine';
import { VEHICLES } from '../src/vehicle/spec';

describe('시설 좌표 변환', () => {
  it('월드↔로컬 왕복이 항등이고 heading 이 yaw 만큼 이동', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.37]) {
      const f = { x: 12, z: -7, yaw };
      const w = toWorldXZ(f, 3.2, -1.4);
      const l = toLocalXZ(f, w.x, w.z);
      expect(l.x).toBeCloseTo(3.2, 9);
      expect(l.z).toBeCloseTo(-1.4, 9);
      expect(headingToLocal(f, headingToWorld(f, 0.5))).toBeCloseTo(0.5, 9);
    }
  });
  it('yaw 90°: 로컬 +x(차량 진행 방향) → 월드 -z, 문(-7,0) → 원점의 +z 쪽', () => {
    const f = { x: 0, z: 0, yaw: Math.PI / 2 };
    const e = toWorldXZ(f, 1, 0);
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.z).toBeCloseTo(-1, 9);
    const door = toWorldXZ(f, STATION.doorX, 0);
    expect(door.z).toBeCloseTo(7, 9);
  });
  it('90° 배수가 아닌 회전은 키트가 거부한다', () => {
    expect(() => facilityKit({ x: 0, z: 0, rotationY: 0.4 })).toThrow();
  });
  it('회전된 키트의 볼라드는 회전된 진입 중심선 좌우 대칭이고 차량 진행선과 같은 간격', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const cfg = { x: 20, z: 5, rotationY: yaw };
      const k = facilityKit(cfg, { idPrefix: 'a:' });
      const f = frameOf(cfg);
      const bol = k.obstacles.filter((o) => o.tag === 'bollard').map((o) => toLocalXZ(f, o.x, o.z));
      expect(bol.length).toBe(4);
      for (const b of bol) expect(Math.abs(b.z)).toBeCloseTo(1.3, 9);
      expect(bol.filter((b) => b.z > 0).length).toBe(2);
    }
  });
});

describe('층수가 다른 시설의 슬롯', () => {
  it('6층 시설: 슬롯 10개(2F~6F), 7F 이상은 존재하지 않는다', () => {
    const m = newMachine(6);
    expect(Object.keys(m.slots).length).toBe(10);
    expect(capacityOf(6)).toBe(10);
    expect(hasSlot(m, '06B')).toBe(true);
    expect(hasSlot(m, '07A')).toBe(false);
    expect(freeSlots(m).length).toBe(10);
    expect(Object.keys(newMachine().slots).length).toBe(SLOTS.length);
  });
  it('6층 시설에서 12F 슬롯 입고는 거부된다', () => {
    const m = newMachine(6);
    const spec = VEHICLES[1];
    const s = { x: STATION.stopperX - spec.wheelbase, z: 0, heading: STATION.heading, v: 0, gear: 'P' as const, handbrake: true, engineOn: false };
    toggleOccupant(s, m);
    expect(startStore(spec, s, m, '12A')).toBe(false);
    expect(m.message).toContain('없는 슬롯');
  });
  it('시설 두 개는 상태가 서로 독립이다 (한쪽 입고가 다른 쪽에 영향 없음)', () => {
    const a = new MechController(12, { x: 0, z: 0, yaw: 0 });
    const b = new MechController(6, { x: 40, z: -30, yaw: Math.PI / 2 });
    a.seedStored('02A', 'sedan', 'fwd', VEHICLES[1]);
    expect(Object.values(a.m.slots).filter(Boolean).length).toBe(1);
    expect(Object.values(b.m.slots).filter(Boolean).length).toBe(0);
    expect(a.m).not.toBe(b.m);
    expect(Object.keys(a.m.slots).length).toBe(22);
    expect(Object.keys(b.m.slots).length).toBe(10);
  });
  it('회전된 시설에서 월드 pose 로 정렬/입고 판정이 된다', () => {
    const f = { x: 41, z: -26, yaw: Math.PI / 2 };
    const c = new MechController(12, f);
    const spec = VEHICLES[1];
    // 로컬 정위치(앞차축 정지 홈)를 월드로 옮긴 차량
    const lp = { x: STATION.stopperX - spec.wheelbase, z: 0 };
    const w = toWorldXZ(f, lp.x, lp.z);
    const car = { x: w.x, z: w.z, y: 0, heading: headingToWorld(f, STATION.heading), v: 0, gear: 'P' as const, handbrake: true } as never;
    const items = c.input(spec, car);
    expect(items.x).toBeCloseTo(lp.x, 6);
    expect(items.heading).toBeCloseTo(STATION.heading, 6);
    c.m.occupant = 'out';
    c.items = [];
    expect(c.storedPoseW('02A', c.seedStored('02A', 'sedan', 'fwd', spec)).y).toBe(3);
  });
});

describe('맵에 설치된 기계식 시설 (데이터)', () => {
  const withFac = MAPS.filter((m) => (m.mechFacilities?.length ?? 0) > 0);
  it('v0.5.5: 모든 맵에 시설이 있고 mech 플래그와 일치한다 (자리가 없던 9개 맵은 옆에 붙인 부속 구역)', () => {
    expect(withFac.map((m) => m.id).sort()).toEqual(MAPS.map((m) => m.id).sort());
    for (const m of MAPS) expect(!!m.mech).toBe((m.mechFacilities?.length ?? 0) > 0);
    expect(getMap('mechpark').mechFacilities!.length).toBe(1);
    expect(getMap('outdoor').mechFacilities!.length).toBe(2);
    expect(getMap('megapark').mechFacilities!.length).toBe(3);
    for (const id of Object.keys(MECH_ANNEX)) {
      expect(getMap(id).mechFacilities!.length, id).toBe(1);
      expect(getMap(id).annex!.length, id).toBe(1);
      expect(getMap(id).mechUnavailable, id).toBeUndefined();
    }
  });
  it('원본 맵(BASE_MAPS)은 그대로다: megapark 합성이 쓰는 데이터에는 부속 구역이 없고 설치 불가 사유가 남아 있다', () => {
    for (const id of Object.keys(MECH_ANNEX)) {
      const b = BASE_MAPS.find((m) => m.id === id)!;
      expect(b.mechFacilities?.length ?? 0, id).toBe(0);
      expect(b.mechUnavailable, id).toBeTruthy();
      expect(b.annex, id).toBeUndefined();
    }
  });
  it('시설 ID 는 맵 안에서 유일하고 정원은 층수와 일치한다', () => {
    for (const m of withFac) {
      const ids = m.mechFacilities!.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const f of m.mechFacilities!) expect(f.capacity).toBe(capacityOf(f.floors));
    }
  });
  it('시설 풋프린트(진입로 포함)가 맵 경계 안이고 시설 자신의 구조물 외 어떤 충돌체와도 겹치지 않는다', () => {
    for (const m of withFac) {
      const cols = mapColliders(m);
      for (const f of m.mechFacilities!) {
        const o = footprintObb(f, FACILITY_FOOTPRINT, 0.3);
        const cs = [toWorldXZ(frameOf(f), FACILITY_FOOTPRINT.minX, FACILITY_FOOTPRINT.minZ), toWorldXZ(frameOf(f), FACILITY_FOOTPRINT.maxX, FACILITY_FOOTPRINT.maxZ)];
        for (const c of cs) {
          expect(c.x, `${m.id}/${f.id}`).toBeGreaterThan(m.bounds.minX);
          expect(c.x).toBeLessThan(m.bounds.maxX);
          expect(c.z).toBeGreaterThan(m.bounds.minZ);
          expect(c.z).toBeLessThan(m.bounds.maxZ);
        }
        for (const c of cols) {
          if (c.tag === 'curb' || /^edge|^perim/.test(c.id)) continue;
          if (c.id.includes(f.id.split(':').pop()!) || /^(ms-|pal-|bol-)/.test(c.id.split(':').pop()!)) continue; // 시설 자신의 구조물
          if (c.kind === 'box') expect(obbOverlap(o, { x: c.x, z: c.z, hw: c.w / 2, hl: c.d / 2, rot: c.rot }), `${m.id}/${f.id} vs ${c.id}`).toBe(false);
        }
      }
    }
  });
  it('outdoor 의 두 시설은 서로 다른 위치/층수이고 풋프린트가 겹치지 않는다', () => {
    const [a, b] = getMap('outdoor').mechFacilities!;
    expect(a.floors).not.toBe(b.floors);
    expect(obbOverlap(footprintObb(a), footprintObb(b))).toBe(false);
  });
  it('기존 미션 동선(스폰→목표칸)이 시설 풋프린트를 지나지 않는다 (outdoor)', () => {
    const m = getMap('outdoor');
    for (const f of m.mechFacilities!) {
      const fr = frameOf(f);
      for (const ms of m.missions) {
        const sp = ms.spawn ?? m.spawn;
        const tg = m.slots.find((s) => s.id === ms.slotId)!;
        for (let t = 0; t <= 1; t += 0.05) {
          const l = toLocalXZ(fr, sp.x + (tg.x - sp.x) * t, sp.z + (tg.z - sp.z) * t);
          const inside = l.x > FACILITY_FOOTPRINT.minX - 1 && l.x < FACILITY_FOOTPRINT.maxX + 1 && l.z > FACILITY_FOOTPRINT.minZ - 1 && l.z < FACILITY_FOOTPRINT.maxZ + 1;
          expect(inside, `${ms.id}`).toBe(false);
        }
      }
    }
  });
});

void makeFacility;
