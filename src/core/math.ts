/**
 * 좌표 규칙 (프로젝트 전체 공통)
 * - 월드: x, z 평면이 지면, y가 위.
 * - heading(h): 0일 때 차량 앞쪽 = +z. 앞 벡터 = (sin h, cos h). h가 증가하면 왼쪽으로 회전.
 * - 차량 로컬: +z = 앞, +x = 차량의 왼쪽(운전자 기준), -x = 오른쪽.
 */
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const MS_TO_KMH = 3.6;

export interface Vec2 {
  x: number;
  z: number;
}

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 각도를 [-π, π]로 정규화 */
export function normAngle(a: number): number {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

/** a - b 의 최소 각도차 */
export const angleDiff = (a: number, b: number): number => normAngle(a - b);

export const forwardOf = (h: number): Vec2 => ({ x: Math.sin(h), z: Math.cos(h) });

/** 로컬(lx: 왼쪽+, lz: 앞+) → 월드 */
export function localToWorld(px: number, pz: number, h: number, lx: number, lz: number): Vec2 {
  const c = Math.cos(h);
  const s = Math.sin(h);
  return { x: px + lx * c + lz * s, z: pz - lx * s + lz * c };
}

/** 월드 → 로컬(lx, lz) */
export function worldToLocal(px: number, pz: number, h: number, wx: number, wz: number): Vec2 {
  const dx = wx - px;
  const dz = wz - pz;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}
