import { describe, expect, it } from 'vitest';
import type { BoxCollider } from '../src/core/geometry';
import { G, kick, makeBody, stepBody } from '../src/physics/bodies';
import { burst, displayScale, newDebris, stepDebris } from '../src/physics/debris';

const wall: BoxCollider = { kind: 'box', id: 'w', tag: 'wall', x: 0, z: 10, w: 20, d: 0.6, rot: 0, y0: 0, h: 2 };
const car = (): BoxCollider => ({ kind: 'box', id: 'parked', tag: 'car', x: 0, z: 0, w: 1.8, d: 4.6, rot: 0, y0: 0, h: 1.4 });

describe('밀려나는 물체 (동적 강체)', () => {
  it('마찰로 감속해 정지한다: 이동 거리 ≈ v²/(2μg)', () => {
    const b = makeBody(car(), 1400, { mu: 0.7 });
    kick(b, 0, 3);
    for (let i = 0; i < 600 && !b.sleeping; i++) stepBody(b, 1 / 120, []);
    expect(b.sleeping).toBe(true);
    const expected = (3 * 3) / (2 * 0.7 * G);
    expect(b.collider.z).toBeGreaterThan(expected * 0.9);
    expect(b.collider.z).toBeLessThan(expected * 1.1);
  });
  it('벽을 뚫지 않는다: 벽 앞에서 멈추고 반대로 튕긴다', () => {
    const b = makeBody(car(), 1400, { mu: 0.1, e: 0.3 });
    kick(b, 0, 12);
    let bounced = false;
    for (let i = 0; i < 1200 && !b.sleeping; i++) if (stepBody(b, 1 / 120, [wall])) bounced = true;
    expect(bounced).toBe(true);
    expect(b.collider.z + 2.3).toBeLessThanOrEqual(10 - 0.3 + 1e-6); // 앞면이 벽 앞면을 넘지 않음
  });
  it('원본 충돌체 객체는 바꾸지 않는다(복사본만 이동)', () => {
    const src = car();
    const b = makeBody(src, 1400);
    kick(b, 1, 1, 0.5);
    for (let i = 0; i < 30; i++) stepBody(b, 1 / 120, []);
    expect(src.x).toBe(0);
    expect(src.z).toBe(0);
    expect(b.collider.x).toBeGreaterThan(0);
    expect((b.collider as BoxCollider).rot).not.toBe(0);
  });
});

describe('파편 입자', () => {
  it('분출 → 중력으로 떨어져 바닥 위에서 멈춘다(바닥 아래로 내려가지 않음)', () => {
    const s = newDebris(500, 1);
    const n = burst(s, { x: 0, y: 1, z: 0, dirX: 0, dirZ: 1, strength: 0.8, color: 0x888888, ground: 0 });
    expect(n).toBeGreaterThan(20);
    for (let i = 0; i < 60 * 8; i++) stepDebris(s, 1 / 60);
    expect(s.list.length).toBe(n);
    for (const p of s.list) {
      expect(p.y).toBeGreaterThanOrEqual(p.size * 0.5 - 1e-9);
      expect(p.resting).toBe(true);
    }
    // 주 방향(+z)으로 퍼진다
    expect(s.list.reduce((a, p) => a + p.z, 0) / n).toBeGreaterThan(0.5);
  });
  it('세게 부딪힐수록 파편이 많다', () => {
    const a = newDebris();
    const b = newDebris();
    expect(burst(b, { x: 0, y: 1, z: 0, dirX: 1, dirZ: 0, strength: 1, color: 0, ground: 0 })).toBeGreaterThan(burst(a, { x: 0, y: 1, z: 0, dirX: 1, dirZ: 0, strength: 0.1, color: 0, ground: 0 }) * 3);
  });
  it('상한을 넘으면 오래된 것부터 버린다, 수명이 다하면 사라진다', () => {
    const s = newDebris(50);
    for (let i = 0; i < 10; i++) burst(s, { x: i, y: 1, z: 0, dirX: 1, dirZ: 0, strength: 1, color: 0, ground: 0 });
    expect(s.list.length).toBe(50);
    expect(s.list[s.list.length - 1].x).toBeGreaterThan(8);
    for (let i = 0; i < 60 * 30; i++) stepDebris(s, 1 / 60);
    expect(s.list.length).toBe(0);
  });
  it('연기는 떠오르며 커지고 표시 크기는 끝에서 0 으로', () => {
    const s = newDebris();
    burst(s, { x: 0, y: 1, z: 0, dirX: 0, dirZ: 1, strength: 0.5, color: 0x555555, ground: 0, kind: 'smoke', count: 3 });
    const y0 = s.list[0].y;
    const s0 = s.list[0].size;
    for (let i = 0; i < 60; i++) stepDebris(s, 1 / 60);
    expect(s.list[0].y).toBeGreaterThan(y0);
    expect(s.list[0].size).toBeGreaterThan(s0);
    const p = { ...s.list[0], age: s.list[0].life };
    expect(displayScale(p)).toBeCloseTo(0, 6);
  });
});
