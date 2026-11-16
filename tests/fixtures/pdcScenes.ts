/**
 * PDC 자동 카메라 방향 검증 장면 (v0.6.3). 장애물은 차량 로컬 좌표(+x 왼쪽, +z 앞, 원점 = 차체 중심)로 정의하고
 * 임의의 heading/위치로 옮겨 월드 충돌체로 만든다. 단위 테스트(tests/autoView.test.ts)와 하네스(scripts/pdc-scenes.ts)가 같이 쓴다.
 *
 * allow  = 이 장면에서 최종적으로 보여도 되는 카메라
 * forbid = 자동 전환으로 한 번이라도 고르면 안 되는 카메라(실제 위험과 반대/무관한 방향)
 */
import type { Collider, Obb } from '../../src/core/geometry';
import { localToWorld, worldToLocal } from '../../src/core/math';
import type { VehicleSpec } from '../../src/vehicle/spec';

export type V = 'rear' | 'front' | 'left' | 'right' | 'topFront' | 'topRear';
export interface SceneObj {
  id: string;
  tag: string;
  kind: 'box' | 'cyl';
  /** 로컬 중심 (hw/hl 기준 함수로 받는다) */
  at: (hw: number, hl: number) => { x: number; z: number };
  w?: number;
  d?: number;
  r?: number;
  rot?: number;
  y0?: number;
  h?: number;
}
export interface Scene {
  id: string;
  name: string;
  gear: 'R' | 'D';
  steer0?: number;
  steerAt?: (t: number) => number;
  vAt?: (t: number) => number;
  dur: number;
  objs: SceneObj[];
  /** 위험 물체 ID(최종 화면에 보여야 함). null = 특정 위험 없음 */
  hazard: string | null;
  allow: V[];
  forbid: V[];
  maxSwitches?: number;
}

const ramp = (to: number, t0: number, t1: number) => (t: number): number => (t <= t0 ? 0 : t >= t1 ? to : (to * (t - t0)) / (t1 - t0));
const after = (v: number, t0: number) => (t: number): number => (t >= t0 ? v : 0);
const mirror = (s: Scene, id: string, name: string, swap: Record<string, string>): Scene => ({
  ...s,
  id,
  name,
  steer0: s.steer0 !== undefined ? -s.steer0 : undefined,
  steerAt: s.steerAt ? (t: number) => -s.steerAt!(t) : undefined,
  objs: s.objs.map((o) => ({ ...o, at: (hw: number, hl: number) => { const p = o.at(hw, hl); return { x: -p.x, z: p.z }; }, rot: o.rot !== undefined ? -o.rot : undefined })),
  allow: s.allow.map((v) => (swap[v] ?? v) as V),
  forbid: s.forbid.map((v) => (swap[v] ?? v) as V),
});
const LR = { left: 'right', right: 'left' };

const flPillar: Scene = {
  id: 'fl-pillar',
  name: '좌측 전방 기둥 (D, 왼쪽으로 조향하며 출발)',
  gear: 'D',
  steerAt: ramp(0.45, 0.2, 1.0),
  vAt: after(0.4, 1.5),
  dur: 5,
  objs: [{ id: 'pil', tag: 'pillar', kind: 'cyl', r: 0.3, at: (hw, hl) => ({ x: hw + 0.5, z: hl + 0.6 }) }],
  hazard: 'pil',
  allow: ['front', 'topFront', 'left'],
  forbid: ['right', 'rear', 'topRear'],
};
const rlWall: Scene = {
  id: 'rl-wall',
  name: '좌측 후방 벽 (R, 왼쪽 조향 후진 — 뒤가 왼쪽으로)',
  gear: 'R',
  steerAt: ramp(0.45, 0.1, 0.6),
  vAt: after(-0.4, 1.0),
  dur: 5,
  objs: [{ id: 'wall', tag: 'wall', kind: 'box', w: 0.25, d: 2.8, at: (hw, hl) => ({ x: hw + 0.5, z: -hl - 0.3 }) }],
  hazard: 'wall',
  allow: ['rear', 'topRear', 'left'],
  forbid: ['right', 'front', 'topFront'],
};
const frontWall: Scene = {
  id: 'front-wall',
  name: '정면 벽 (D, 직진)',
  gear: 'D',
  vAt: after(0.4, 0.5),
  dur: 5,
  objs: [{ id: 'wall', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: hl + 1.3 }) }],
  hazard: 'wall',
  allow: ['front', 'topFront'],
  forbid: ['left', 'right', 'rear', 'topRear'],
};
const rearWall: Scene = {
  id: 'rear-wall',
  name: '후면 벽 (R, 직진 후진)',
  gear: 'R',
  vAt: after(-0.4, 0.5),
  dur: 5,
  objs: [{ id: 'wall', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: -hl - 1.3 }) }],
  hazard: 'wall',
  allow: ['rear', 'topRear'],
  forbid: ['left', 'right', 'front', 'topFront'],
};
const bothSides: Scene = {
  id: 'both-sides',
  name: '좌우 양쪽 벽 (D, 좁은 통로 직진)',
  gear: 'D',
  vAt: after(0.4, 0.3),
  dur: 5,
  objs: [
    { id: 'wl', tag: 'wall', kind: 'box', w: 0.3, d: 12, at: (hw) => ({ x: hw + 0.35 + 0.15, z: 2 }) },
    { id: 'wr', tag: 'wall', kind: 'box', w: 0.3, d: 12, at: (hw) => ({ x: -(hw + 0.35 + 0.15), z: 2 }) },
  ],
  hazard: null,
  allow: ['front', 'topFront', 'left', 'right'],
  forbid: ['rear', 'topRear'],
  maxSwitches: 2,
};
const swingFront: Scene = {
  id: 'swing-front',
  name: '후진 중 앞범퍼 반대쪽 스윙 (R, 왼쪽 조향 → 앞이 오른쪽으로)',
  gear: 'R',
  steerAt: ramp(0.5, 0.1, 0.6),
  vAt: after(-0.35, 0.8),
  dur: 6,
  objs: [{ id: 'pil', tag: 'pillar', kind: 'cyl', r: 0.25, at: (hw, hl) => ({ x: -(hw + 0.25 + 0.5), z: hl - 0.5 }) }],
  hazard: 'pil',
  // 스윙 구간을 지나 경로에서 벗어나면 기본 후방 카메라로 돌아오는 것이 맞다(최종 rear 허용, 가장 가까울 때 화면 검사는 따로)
  allow: ['right', 'topFront', 'front', 'rear'],
  forbid: ['left', 'topRear'],
};
const stopLeft: Scene = {
  id: 'stop-left',
  name: '정차 중 좌회전 조향 (D, 왼쪽 앞 기둥 + 오른쪽 나란한 주차 차량)',
  gear: 'D',
  steerAt: ramp(0.5, 0.3, 1.2),
  dur: 4,
  objs: [
    { id: 'pil', tag: 'pillar', kind: 'cyl', r: 0.3, at: (hw, hl) => ({ x: hw + 0.45, z: hl + 0.5 }) },
    { id: 'pcar', tag: 'car', kind: 'box', w: 1.8, d: 4.6, at: (hw) => ({ x: -(hw + 0.25 + 0.9), z: -0.2 }) },
  ],
  hazard: 'pil',
  allow: ['front', 'topFront', 'left'],
  forbid: ['right', 'rear', 'topRear'],
};
const shutter: Scene = {
  id: 'shutter',
  name: '주차장 셔터 근접 (D, 승강장 양옆 벽)',
  gear: 'D',
  vAt: after(0.25, 0.5),
  dur: 5,
  objs: [
    { id: 'sh', tag: 'shutter', kind: 'box', w: 3.2, d: 0.3, at: (_hw, hl) => ({ x: 0, z: hl + 0.7 }) },
    { id: 'bl', tag: 'wall', kind: 'box', w: 0.3, d: 6, at: (hw) => ({ x: hw + 0.55 + 0.15, z: 0 }) },
    { id: 'br', tag: 'wall', kind: 'box', w: 0.3, d: 6, at: (hw) => ({ x: -(hw + 0.55 + 0.15), z: 0 }) },
  ],
  hazard: 'sh',
  allow: ['front', 'topFront'],
  forbid: ['left', 'right', 'rear', 'topRear'],
};
const mechGuide: Scene = {
  id: 'mech-guide',
  name: '기계식 타워 가이드 근접 (D, 낮은 가이드 + 모서리 기둥)',
  gear: 'D',
  vAt: after(0.3, 0.3),
  dur: 4,
  objs: [
    { id: 'gl', tag: 'guide', kind: 'box', w: 0.1, d: 5, y0: 0, h: 0.12, at: (hw) => ({ x: hw + 0.08, z: 0 }) },
    { id: 'gr', tag: 'guide', kind: 'box', w: 0.1, d: 5, y0: 0, h: 0.12, at: (hw) => ({ x: -(hw + 0.08), z: 0 }) },
    { id: 'c1', tag: 'pillar', kind: 'cyl', r: 0.15, at: (hw, hl) => ({ x: hw + 0.45, z: hl + 1.2 }) },
    { id: 'c2', tag: 'pillar', kind: 'cyl', r: 0.15, at: (hw, hl) => ({ x: -(hw + 0.45), z: hl + 1.2 }) },
    { id: 'end', tag: 'wall', kind: 'box', w: 3.4, d: 0.3, at: (_hw, hl) => ({ x: 0, z: hl + 1.5 }) },
  ],
  hazard: 'end',
  allow: ['front', 'topFront'],
  forbid: ['left', 'right', 'rear', 'topRear'],
};
const rampWall: Scene = {
  id: 'ramp-wall',
  name: '경사로 측면 벽 (D, 오른쪽 벽 쪽으로 살짝 조향)',
  gear: 'D',
  steerAt: ramp(-0.06, 0, 0.5),
  vAt: after(0.5, 0.3),
  dur: 4,
  objs: [{ id: 'rw', tag: 'wall', kind: 'box', w: 0.3, d: 14, at: (hw) => ({ x: -(hw + 0.35 + 0.15), z: 3 }) }],
  hazard: 'rw',
  allow: ['front', 'topFront', 'right'],
  forbid: ['left', 'rear', 'topRear'],
};
const narrowSlotR: Scene = {
  id: 'slot-side-R',
  name: '좁은 칸 직진 후진 (R, 오른쪽 차량 0.22m 나란히 — 경로 밖)',
  gear: 'R',
  vAt: after(-0.3, 0.3),
  dur: 4,
  objs: [
    { id: 'pr', tag: 'car', kind: 'box', w: 1.8, d: 4.6, at: (hw) => ({ x: -(hw + 0.22 + 0.9), z: 0.4 }) },
    { id: 'pl', tag: 'car', kind: 'box', w: 1.8, d: 4.6, at: (hw) => ({ x: hw + 0.7 + 0.9, z: 0.4 }) },
    { id: 'rw', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: -hl - 2.6 }) },
  ],
  hazard: 'rw',
  allow: ['rear', 'topRear'],
  forbid: ['left', 'right', 'front', 'topFront'],
};

const noseInR: Scene = {
  id: 'nose-in-R',
  name: '앞벽에 붙여 세운 뒤 직진 후진 (R, 앞벽 0.06m — 멀어지는 중)',
  gear: 'R',
  vAt: after(-0.35, 0.4),
  dur: 4,
  objs: [
    { id: 'fw', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: hl + 0.06 + 0.15 }) },
    { id: 'rw', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: -hl - 3.2 }) },
  ],
  hazard: 'rw',
  allow: ['rear', 'topRear'],
  forbid: ['left', 'right', 'front', 'topFront'],
};
const tailInD: Scene = {
  ...noseInR,
  id: 'tail-in-D',
  name: '뒷벽에 붙여 세운 뒤 직진 출발 (D, 뒷벽 0.06m — 멀어지는 중)',
  gear: 'D',
  vAt: after(0.35, 0.4),
  objs: [
    { id: 'rw', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: -hl - 0.06 - 0.15 }) },
    { id: 'fw', tag: 'wall', kind: 'box', w: 6, d: 0.3, at: (_hw, hl) => ({ x: 0, z: hl + 3.2 }) },
  ],
  hazard: 'fw',
  allow: ['front', 'topFront'],
  forbid: ['left', 'right', 'rear', 'topRear'],
};

export const SCENES: Scene[] = [
  flPillar,
  mirror(flPillar, 'fr-pillar', '우측 전방 기둥 (D, 오른쪽으로 조향하며 출발)', LR),
  rlWall,
  mirror(rlWall, 'rr-wall', '우측 후방 벽 (R, 오른쪽 조향 후진)', LR),
  frontWall,
  rearWall,
  bothSides,
  swingFront,
  mirror(swingFront, 'swing-front-L', '후진 중 앞범퍼 반대쪽 스윙 (R, 오른쪽 조향 → 앞이 왼쪽으로)', LR),
  stopLeft,
  mirror(stopLeft, 'stop-right', '정차 중 우회전 조향 (D, 오른쪽 앞 기둥 + 왼쪽 나란한 주차 차량)', LR),
  shutter,
  mechGuide,
  rampWall,
  narrowSlotR,
  mirror(narrowSlotR, 'slot-side-R2', '좁은 칸 직진 후진 (R, 왼쪽 차량 0.22m 나란히 — 경로 밖)', LR),
  noseInR,
  tailInD,
];

/** 장면 물체 → 월드 충돌체 (차체 중심 off, heading H) */
export function sceneColliders(s: Scene, spec: VehicleSpec, H: number, off: { x: number; z: number }): Collider[] {
  const hw = spec.width / 2;
  const hl = spec.length / 2;
  return s.objs.map((o) => {
    const p = o.at(hw, hl);
    const w = localToWorld(off.x, off.z, H, p.x, p.z);
    if (o.kind === 'cyl') return { kind: 'cyl', id: o.id, tag: o.tag, x: w.x, z: w.z, r: o.r!, y0: o.y0 ?? 0, h: o.h ?? 2.6 };
    return { kind: 'box', id: o.id, tag: o.tag, x: w.x, z: w.z, w: o.w!, d: o.d!, rot: H + (o.rot ?? 0), y0: o.y0 ?? 0, h: o.h ?? 2.6 };
  });
}

/** 위험 물체 표면에서 차체에 가장 가까운 점(월드) */
export function hazardPoint(s: Scene, cols: readonly Collider[], body: Obb): { x: number; z: number } | null {
  if (!s.hazard) return null;
  const c = cols.find((q) => q.id === s.hazard);
  if (!c) return null;
  const pts: { x: number; z: number }[] = [];
  if (c.kind === 'cyl') for (let k = 0; k < 48; k++) pts.push({ x: c.x + c.r * Math.cos((k / 48) * Math.PI * 2), z: c.z + c.r * Math.sin((k / 48) * Math.PI * 2) });
  else {
    const n = 40;
    for (let k = 0; k <= n; k++) {
      const a = -c.w / 2 + (c.w * k) / n;
      const b = -c.d / 2 + (c.d * k) / n;
      for (const [lx, lz] of [[a, -c.d / 2], [a, c.d / 2], [-c.w / 2, b], [c.w / 2, b]]) pts.push(localToWorld(c.x, c.z, c.rot, lx, lz));
    }
  }
  let best = pts[0];
  let bd = Infinity;
  for (const p of pts) {
    const l = worldToLocal(body.x, body.z, body.rot, p.x, p.z);
    const d = Math.hypot(Math.max(Math.abs(l.x) - body.hw, 0), Math.max(Math.abs(l.z) - body.hl, 0));
    if (d < bd) [bd, best] = [d, p];
  }
  return best;
}
