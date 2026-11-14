/**
 * 파편/연기 입자 (v0.6.0 — 순수 로직, 렌더링은 fx/debrisView.ts). 충돌 지점에서 튀어나와 중력으로 떨어지고,
 * 바닥에서 튕기며(반발 0.3) 마찰로 멈춘다. 오래된 입자부터 사라지고 총 개수는 상한(`cap`)을 넘지 않는다.
 * 파편은 시각 효과일 뿐 충돌체가 아니다(차량/센서에 영향 없음).
 */
export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  size: number;
  color: number;
  /** 바닥 높이(생성 지점의 지면) */
  ground: number;
  age: number;
  life: number;
  /** 'chip' 파편(중력·바닥) / 'smoke' 연기(떠오르며 커짐) / 'spark' 불꽃(빠르게 사라짐) */
  kind: 'chip' | 'smoke' | 'spark';
  resting: boolean;
}

export interface DebrisSim {
  list: Particle[];
  cap: number;
  /** 결정적 난수(테스트 재현용) */
  seed: number;
  spawned: number;
}

export const newDebris = (cap = 420, seed = 7): DebrisSim => ({ list: [], cap, seed, spawned: 0 });

const rnd = (s: DebrisSim): number => {
  s.seed = (s.seed * 1664525 + 1013904223) >>> 0;
  return s.seed / 4294967296;
};

export interface BurstOpts {
  x: number;
  y: number;
  z: number;
  /** 튀는 주 방향(수평, 정규화 불필요) */
  dirX: number;
  dirZ: number;
  /** 0~1: 충돌 세기 → 개수/속도/크기 */
  strength: number;
  color: number;
  ground: number;
  kind?: Particle['kind'];
  count?: number;
}

/** 파편 분출. 생성한 개수를 반환 */
export function burst(s: DebrisSim, o: BurstOpts): number {
  const k = Math.max(0, Math.min(1, o.strength));
  const kind = o.kind ?? 'chip';
  const n = o.count ?? Math.round(kind === 'spark' ? 5 + 14 * k : 4 + 28 * k);
  const dl = Math.hypot(o.dirX, o.dirZ) || 1;
  const dx = o.dirX / dl;
  const dz = o.dirZ / dl;
  for (let i = 0; i < n; i++) {
    const spread = (rnd(s) - 0.5) * 2.2;
    const sp = (kind === 'spark' ? 2.5 : 0.8) + (kind === 'spark' ? 5 : 3.2) * k * (0.35 + rnd(s));
    const ca = Math.cos(spread);
    const sa = Math.sin(spread);
    const hx = dx * ca - dz * sa;
    const hz = dx * sa + dz * ca;
    s.list.push({
      x: o.x + (rnd(s) - 0.5) * 0.3,
      y: o.y + (rnd(s) - 0.5) * 0.3,
      z: o.z + (rnd(s) - 0.5) * 0.3,
      vx: hx * sp,
      vy: (kind === 'smoke' ? 0.6 : 1.0 + 2.6 * k) * (0.4 + rnd(s)),
      vz: hz * sp,
      rx: rnd(s) * 6,
      ry: rnd(s) * 6,
      rz: rnd(s) * 6,
      wx: (rnd(s) - 0.5) * 14,
      wy: (rnd(s) - 0.5) * 14,
      wz: (rnd(s) - 0.5) * 14,
      size: kind === 'smoke' ? 0.16 + 0.12 * rnd(s) : kind === 'spark' ? 0.025 + 0.025 * rnd(s) : 0.035 + (0.07 + 0.13 * k) * rnd(s),
      color: o.color,
      ground: o.ground,
      age: 0,
      life: kind === 'smoke' ? 2.2 + rnd(s) : kind === 'spark' ? 0.35 + 0.4 * rnd(s) : 18 + 8 * rnd(s),
      kind,
      resting: false,
    });
  }
  s.spawned += n;
  // 상한: 오래된 것부터 버린다
  if (s.list.length > s.cap) s.list.splice(0, s.list.length - s.cap);
  return n;
}

const GRAV = 9.81;

export function stepDebris(s: DebrisSim, dt: number): void {
  const out: Particle[] = [];
  for (const p of s.list) {
    p.age += dt;
    if (p.age >= p.life) continue;
    if (p.kind === 'smoke') {
      p.x += p.vx * dt * 0.3;
      p.z += p.vz * dt * 0.3;
      p.y += p.vy * dt;
      p.vy = Math.max(0.3, p.vy - 0.2 * dt);
      p.size += dt * 0.32;
      out.push(p);
      continue;
    }
    if (!p.resting) {
      p.vy -= GRAV * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rx += p.wx * dt;
      p.ry += p.wy * dt;
      p.rz += p.wz * dt;
      const floor = p.ground + p.size * 0.5;
      if (p.y <= floor) {
        p.y = floor;
        if (Math.abs(p.vy) < 0.8) {
          p.vy = 0;
          // 바닥 마찰
          const f = Math.exp(-6 * dt);
          p.vx *= f;
          p.vz *= f;
          p.wx *= f;
          p.wy *= f;
          p.wz *= f;
          if (Math.hypot(p.vx, p.vz) < 0.05) p.resting = true;
        } else {
          p.vy = -p.vy * 0.3;
          p.vx *= 0.7;
          p.vz *= 0.7;
        }
      }
    }
    out.push(p);
  }
  s.list = out;
}

/** 수명 끝으로 갈수록 작아지는 표시 크기 (연기는 커지고 마지막에 사라짐) */
export function displayScale(p: Particle): number {
  const t = p.age / p.life;
  if (p.kind === 'smoke') return p.size * (t < 0.8 ? 1 : (1 - t) / 0.2);
  if (p.kind === 'spark') return p.size * (1 - t);
  return p.size * (t < 0.9 ? 1 : (1 - t) / 0.1);
}
