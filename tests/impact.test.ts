import { describe, expect, it } from 'vitest';
import type { BoxCollider, Collider } from '../src/core/geometry';
import {
  BOUNCE_MIN_VN,
  CAR_DAMAGE_FULL_E,
  CAR_DAMAGE_MIN_E,
  applyCarDamage,
  carDamageEffects,
  carSeverity,
  carZoneOf,
  closestPointOn,
  isSystemCollider,
  materialOf,
  newCarDamage,
  resolveImpact,
  vehicleMassKg,
} from '../src/physics/impact';
import { getVehicle } from '../src/vehicle/spec';

const box = (tag: string, o: Partial<BoxCollider> = {}): BoxCollider => ({ kind: 'box', id: `${tag}-1`, tag, x: 0, z: 10, w: 4, d: 0.3, rot: 0, y0: 0, h: 1.2, ...o });
const kmh = (v: number): number => v / 3.6;
/** 차량(차체 중심 z=10-0.15-2.45, 정면이 벽 앞면에 닿은 자세)으로 +z 방향 충돌 */
const carAt = (hl = 2.45): { x: number; z: number; heading: number; hw: number; hl: number } => ({ x: 0, z: 10 - 0.15 - hl + 0.02, heading: 0, hw: 0.92, hl });
const hit = (c: Collider, v: number, damage = 0, m = 1500): ReturnType<typeof resolveImpact> => resolveImpact({ car: carAt(), v, carMass: m, collider: c, damage });

describe('재질/질량', () => {
  it('차량 질량 근사: 세단 약 1.5t, 0.9~2.6t 범위', () => {
    const m = vehicleMassKg(getVehicle('sedan'));
    expect(m).toBeGreaterThan(1200);
    expect(m).toBeLessThan(1900);
    expect(vehicleMassKg({ length: 2, width: 1, height: 1 })).toBe(900);
    expect(vehicleMassKg({ length: 9, width: 3, height: 3 })).toBe(2600);
  });
  it('태그별 파손 방식: 콘/드럼/주차차량 = 밀림, 방호벽/화분 = 부서짐, 가로등/나무/볼라드 = 넘어짐, 벽 = 구멍, 건물/기둥 = 균열만', () => {
    expect(materialOf(box('cone')).mode).toBe('push');
    expect(materialOf(box('drum')).mode).toBe('push');
    expect(materialOf(box('car')).mode).toBe('push');
    expect(materialOf(box('barrier')).mode).toBe('shatter');
    expect(materialOf(box('planter')).mode).toBe('shatter');
    for (const t of ['lamp', 'tree', 'bollard']) expect(materialOf(box(t)).mode).toBe('topple');
    expect(materialOf(box('wall')).mode).toBe('hole');
    expect(materialOf(box('building')).mode).toBe('scar');
    expect(materialOf(box('pillar')).mode).toBe('scar');
  });
  it('장치가 관리하는 충돌체(셔터/리프트 기둥/가이드/카메라 전용)는 파손 대상이 아니다', () => {
    for (const id of ['mech:shutter', 'out-mech-east:door', 'lift-a-postL', 'lift-b-postLF', 'ms-front-n', 'tw-mech:ms-back']) expect(isSystemCollider({ id, tag: 'wall' }), id).toBe(true);
    expect(isSystemCollider({ id: 'x', tag: 'guide' })).toBe(true);
    expect(materialOf(box('wall', { id: 'mech:shutter' })).mode).toBe('none');
    expect(isSystemCollider({ id: 'edge-n', tag: 'wall' })).toBe(false);
  });
  it('두꺼운 벽일수록 내구도가 크다', () => {
    expect(materialOf(box('wall', { d: 0.6 })).hp).toBeGreaterThan(materialOf(box('wall', { d: 0.3 })).hp * 1.9);
  });
});

describe('접촉점/부위', () => {
  it('회전한 상자의 가장 가까운 점은 표면 위에 있다', () => {
    const c = box('wall', { x: 3, z: -2, rot: 0.7, w: 4, d: 1 });
    const p = closestPointOn(c, 10, 5);
    expect(p.inside).toBe(false);
    // 표면 점은 상자 안쪽 경계(로컬 좌표 |x|≤2, |z|≤0.5 의 경계)
    const lx = (p.x - 3) * Math.cos(0.7) - (p.z + 2) * Math.sin(0.7);
    const lz = (p.x - 3) * Math.sin(0.7) + (p.z + 2) * Math.cos(0.7);
    expect(Math.max(Math.abs(lx) / 2, Math.abs(lz) / 0.5)).toBeCloseTo(1, 6);
  });
  it('부위: 앞/뒤/왼쪽(+x)/오른쪽', () => {
    const car = { x: 0, z: 0, heading: 0, hw: 0.9, hl: 2.4 };
    expect(carZoneOf(car, 0, 3)).toBe('front');
    expect(carZoneOf(car, 0.2, -3)).toBe('rear');
    expect(carZoneOf(car, 1.2, 0.5)).toBe('left');
    expect(carZoneOf(car, -1.2, -0.5)).toBe('right');
  });
});

describe('충돌 결과: 속도에 따라 달라진다', () => {
  it('주차 중 접촉(시속 3km)은 손상 없음, 막힘, 튕기지 않음(이전 동작과 같다)', () => {
    const r = hit(box('wall'), kmh(3));
    expect(r.action).toBe('block');
    expect(r.v).toBe(0);
    expect(r.damage).toBe(0);
    expect(r.zone).toBe('front');
    expect(r.vn).toBeCloseTo(kmh(3), 6);
  });
  it('벽(0.3m): 시속 40km 는 막히고 손상 누적·튕김, 시속 80km 는 구멍을 내고 통과하며 속도가 줄어든다', () => {
    const w = box('wall');
    const r40 = hit(w, kmh(40));
    expect(r40.action).toBe('block');
    expect(r40.broke).toBe(false);
    expect(r40.damage).toBeGreaterThan(50000);
    expect(r40.v).toBeLessThan(0); // 튕김
    expect(Math.abs(r40.v)).toBeLessThan(kmh(40) * 0.2);
    const r80 = hit(w, kmh(80));
    expect(r80.action).toBe('pass');
    expect(r80.broke).toBe(true);
    expect(r80.v).toBeGreaterThan(0);
    expect(r80.v).toBeLessThan(kmh(80));
  });
  it('반복 충돌로 손상이 누적되면 낮은 속도에서도 결국 부서진다', () => {
    const w = box('wall');
    const hp = materialOf(w).hp;
    expect(hit(w, kmh(40), hp * 0.9).broke).toBe(true);
    expect(hit(w, kmh(40), 0).broke).toBe(false);
  });
  it('비스듬히 스치면(접근 속도가 작아) 손상이 작다', () => {
    const w = box('wall', { w: 40 });
    const head = resolveImpact({ car: carAt(), v: kmh(50), carMass: 1500, collider: w, damage: 0 });
    const glance = resolveImpact({ car: { ...carAt(), heading: 1.35 }, v: kmh(50), carMass: 1500, collider: w, damage: 0 });
    expect(glance.energy).toBeLessThan(head.energy * 0.2);
  });
  it('건물/기둥은 아무리 빨라도 사라지지 않는다(균열만) — 차량은 막힌다', () => {
    for (const t of ['building', 'pillar']) {
      const r = hit(box(t, { w: 20, d: 20, z: 10 + 9.85 }), kmh(150));
      expect(r.action).toBe('block');
      expect(r.broke).toBe(false);
      expect(r.damage).toBeGreaterThan(0);
    }
  });
  it('장치 충돌체는 손상 없이 막기만 한다', () => {
    const r = hit(box('wall', { id: 'mech:shutter' }), kmh(60));
    expect(r.action).toBe('block');
    expect(r.damage).toBe(0);
  });
  it('방호벽: 시속 15km 버팀, 시속 50km 부서짐', () => {
    const b = box('barrier', { w: 3, d: 0.4, h: 0.9 });
    expect(hit(b, kmh(15)).broke).toBe(false);
    expect(hit(b, kmh(50)).broke).toBe(true);
  });
});

describe('움직이는 물체: 운동량 보존', () => {
  const momentum = (r: ReturnType<typeof resolveImpact>, m1: number, m2: number, v0: number): { before: number; after: number } => ({
    before: m1 * v0,
    after: m1 * r.v + m2 * Math.hypot(r.push!.vx, r.push!.vz),
  });
  it('주차 차량(1.4t)을 시속 20km 로 정면 추돌: 차량은 느려지고 상대 차는 밀려나며, 진행 방향 운동량이 보존된다', () => {
    const c = box('car', { w: 1.8, d: 4.6, z: 10 + 2.15 });
    const r = hit(c, kmh(20));
    expect(r.action).toBe('pass');
    expect(r.push).not.toBeNull();
    expect(r.v).toBeGreaterThan(0);
    expect(r.v).toBeLessThan(kmh(20));
    expect(r.push!.vz).toBeGreaterThan(r.v); // 밀린 차가 더 빨라 서로 떨어진다(겹침 해소)
    const p = momentum(r, 1500, 1400, kmh(20));
    expect(p.after).toBeCloseTo(p.before, 3);
    expect(r.damage).toBeGreaterThan(0);
  });
  it('라바콘은 거의 감속 없이 튕겨 나간다', () => {
    const r = hit(box('cone', { w: 0.4, d: 0.4, z: 10 + 0.05 }), kmh(30));
    expect(r.v).toBeGreaterThan(kmh(30) * 0.98);
    expect(r.push!.vz).toBeGreaterThan(kmh(30) * 1.3);
  });
  it('이미 앞으로 밀려나는 물체(같은 속도)에는 접근 속도가 0 — 다시 충돌하지 않는다', () => {
    const c = box('car', { w: 1.8, d: 4.6, z: 10 + 2.15 });
    const r = resolveImpact({ car: carAt(), v: kmh(20), carMass: 1500, collider: c, damage: 0, bodyV: { x: 0, z: kmh(20) } });
    expect(r.vn).toBeCloseTo(0, 9);
    expect(r.energy).toBeCloseTo(0, 9);
  });
});

describe('차량 손상', () => {
  it('2kJ 미만(시속 6km 이하) 손상 없음, 부위별 누적, 최대 1', () => {
    const d = newCarDamage();
    expect(applyCarDamage(d, 'front', CAR_DAMAGE_MIN_E - 1)).toBe(0);
    applyCarDamage(d, 'front', (CAR_DAMAGE_FULL_E + CAR_DAMAGE_MIN_E) / 2);
    expect(d.front).toBeCloseTo(0.5, 6);
    expect(d.rear).toBe(0);
    applyCarDamage(d, 'front', CAR_DAMAGE_FULL_E * 3);
    expect(d.front).toBe(1);
    expect(d.left).toBeGreaterThan(0); // 큰 충격은 인접 부위로 전달
  });
  it('속도가 클수록 손상이 크다 (에너지 ∝ v²)', () => {
    const at = (kh: number): number => {
      const d = newCarDamage();
      applyCarDamage(d, 'front', hit(box('wall', { d: 2 }), kmh(kh)).energy);
      return d.front;
    };
    expect(at(5)).toBe(0);
    expect(at(20)).toBeGreaterThan(0.03);
    expect(at(40)).toBeGreaterThan(at(20) * 3);
    expect(at(60)).toBeGreaterThan(0.9);
  });
  it('효과: 30% 까지 성능 영향 없음, 심하면 출력/최고속도 감소·연기, 100% 면 운행 불가', () => {
    const d = newCarDamage();
    expect(carDamageEffects(d).level).toBe('none');
    d.front = 0.25;
    let e = carDamageEffects(d);
    expect(e.power).toBe(1);
    expect(e.level).toBe('minor');
    d.front = 0.8;
    e = carDamageEffects(d);
    expect(e.power).toBeLessThan(0.9);
    expect(e.topSpeed).toBeLessThan(0.9);
    expect(e.headlightsBroken).toBe(true);
    expect(e.smoke).toBe(true);
    expect(e.disabled).toBe(false);
    d.front = 1;
    e = carDamageEffects(d);
    expect(e.disabled).toBe(true);
    expect(e.level).toBe('wrecked');
    expect(e.power).toBe(0);
    expect(carSeverity(d)).toBe(1);
  });
  it('측면이 찌그러지면 그쪽으로 조향이 쏠린다', () => {
    const d = newCarDamage();
    d.left = 0.6;
    expect(carDamageEffects(d).steerPull).toBeGreaterThan(0);
    d.left = 0;
    d.right = 0.6;
    expect(carDamageEffects(d).steerPull).toBeLessThan(0);
  });
});

void BOUNCE_MIN_VN;
