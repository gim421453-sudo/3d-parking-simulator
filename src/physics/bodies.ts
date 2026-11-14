/**
 * 밀려나는 물체(동적 강체, v0.6.0 — 순수 로직). 충돌로 속도를 받은 콘/드럼/주차 차량을 바닥 마찰로 감속시키며 움직인다.
 *  - 평면 운동(x, z, 회전) + 쿨롱 마찰(감속 μ·g) + 회전 감쇠
 *  - 다른 충돌체와 겹치면 그 스텝 이동을 취소하고 반발(속도 반전 × e) — 벽을 뚫고 지나가지 않는다
 *  - 충분히 느려지면 정지(sleep) → 다시 부딪힐 때까지 계산하지 않는다
 * 물체의 충돌체(`collider`)는 이 모듈이 직접 위치를 바꾸는 **복사본**이다(맵 원본 데이터는 그대로).
 */
import { findVehicleCollision, type Collider } from '../core/geometry';

export interface Body {
  id: string;
  collider: Collider;
  mass: number;
  vx: number;
  vz: number;
  /** 회전 속도(rad/s, heading 증가 = 왼쪽) */
  w: number;
  /** 바닥 마찰 계수 */
  mu: number;
  /** 다른 물체와 부딪힐 때 반발계수 */
  e: number;
  sleeping: boolean;
  /** 누적 이동 거리(m) — 테스트/디버그 */
  moved: number;
}

export const G = 9.81;
const SLEEP_V = 0.04;

export function makeBody(collider: Collider, mass: number, opts: { mu?: number; e?: number } = {}): Body {
  return { id: collider.id, collider: { ...collider }, mass, vx: 0, vz: 0, w: 0, mu: opts.mu ?? 0.7, e: opts.e ?? 0.2, sleeping: true, moved: 0 };
}

/** 충격 속도 더하기 */
export function kick(b: Body, vx: number, vz: number, w = 0): void {
  b.vx += vx;
  b.vz += vz;
  b.w += w;
  b.sleeping = false;
}

const asObb = (c: Collider): { x: number; z: number; rot: number; hw: number; hl: number } =>
  c.kind === 'box' ? { x: c.x, z: c.z, rot: c.rot, hw: c.w / 2, hl: c.d / 2 } : { x: c.x, z: c.z, rot: 0, hw: c.r * 0.92, hl: c.r * 0.92 };

/**
 * 한 스텝. `others` 는 이 물체가 부딪힐 수 있는 충돌체(자기 자신 제외 — 같은 id 는 무시한다).
 * 반환: 이번 스텝에 다른 물체에 부딪혔는가
 */
export function stepBody(b: Body, dt: number, others: readonly Collider[]): boolean {
  if (b.sleeping) return false;
  const sp = Math.hypot(b.vx, b.vz);
  // 마찰 감속 (속도 방향 반대), 회전 감쇠
  const dec = b.mu * G * dt;
  if (sp <= dec) {
    b.vx = 0;
    b.vz = 0;
  } else {
    b.vx -= (b.vx / sp) * dec;
    b.vz -= (b.vz / sp) * dec;
  }
  b.w *= Math.exp(-3 * dt);
  if (Math.abs(b.w) < 0.02) b.w = 0;
  if (Math.hypot(b.vx, b.vz) < SLEEP_V && b.w === 0) {
    b.vx = 0;
    b.vz = 0;
    b.sleeping = true;
    return false;
  }
  const c = b.collider;
  const px = c.x;
  const pz = c.z;
  const prot = c.kind === 'box' ? c.rot : 0;
  c.x += b.vx * dt;
  c.z += b.vz * dt;
  if (c.kind === 'box') c.rot += b.w * dt;
  const near = others.filter((o) => o.id !== b.id);
  const hit = findVehicleCollision(asObb(c), near, c.y0, c.h);
  if (hit) {
    c.x = px;
    c.z = pz;
    if (c.kind === 'box') c.rot = prot;
    b.vx *= -b.e;
    b.vz *= -b.e;
    b.w *= -b.e;
    return true;
  }
  b.moved += Math.hypot(c.x - px, c.z - pz);
  return false;
}
