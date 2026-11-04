import { findVehicleCollision, type Collider } from '../../src/core/geometry';
import { groundAt, type Terrain } from '../../src/maps/terrain';
import { centerOf, createVehicleState, obbOf, stepVehicle, type VehicleState } from '../../src/vehicle/physics';
import { getVehicle } from '../../src/vehicle/spec';

/** 지형(terrain)+충돌체 기반 주행 시뮬레이션 (Game.physicsStep 과 같은 순서). 순수 추종 경로 주행 */
export interface Result {
  maxY: number;
  collisions: number;
  offGround: number;
  reached: boolean;
  /** 마지막으로 부딪힌 충돌체 id (디버그) */
  lastHit?: string;
  steps: number;
  car: VehicleState;
}
export function makeSim(T: Terrain, colliders: readonly Collider[]) {
  let lastHit = '';
  const place = (specId: string, x: number, z: number, h: number, y: number): { spec: ReturnType<typeof getVehicle>; car: VehicleState } => {
    const spec = getVehicle(specId);
    const car = createVehicleState(spec, x, z, h);
    const wb = spec.wheelbase;
    const yR = groundAt(T, car.x, car.z, y) ?? y;
    const yF = groundAt(T, car.x + Math.sin(h) * wb, car.z + Math.cos(h) * wb, yR) ?? yR;
    car.y = yR;
    car.pitch = Math.atan2(yF - yR, wb);
    car.slope = Math.sin(car.pitch);
    car.gear = 'D';
    return { spec, car };
  };
  const step = (spec: ReturnType<typeof getVehicle>, car: VehicleState, vin: { throttle: number; brake: number; steerInput: number }, dt: number): 'ok' | 'hit' | 'off' => {
    const px = car.x, pz = car.z, ph = car.heading, py = car.y, pp = car.pitch, ps = car.slope;
    stepVehicle(car, vin, spec, dt);
    const wb = spec.wheelbase;
    const yR = groundAt(T, car.x, car.z, py);
    const yF = groundAt(T, car.x + Math.sin(car.heading) * wb, car.z + Math.cos(car.heading) * wb, py);
    let st: 'ok' | 'hit' | 'off' = 'ok';
    if (yR === null || yF === null) st = 'off';
    else {
      car.y = yR;
      car.pitch = Math.atan2(yF - yR, wb);
      car.slope = Math.sin(car.pitch);
      const h = findVehicleCollision(obbOf(car, spec), colliders, car.y, spec.height);
      if (h) { st = 'hit'; lastHit = h.id; }
    }
    if (st !== 'ok') {
      car.x = px; car.z = pz; car.heading = ph; car.y = py; car.pitch = pp; car.slope = ps; car.v = 0;
    }
    return st;
  };
  const drive = (specId: string, start: { x: number; z: number; h: number; y: number }, path: [number, number][], goal: (car: VehicleState) => boolean, speed = 2.2, maxSec = 160, look = 3.0): Result => {
    const { spec, car } = place(specId, start.x, start.z, start.h, start.y);
    const dt = 1 / 120;
    let idx = 0;
    let collisions = 0;
    let offGround = 0;
    let maxY = car.y;
    let steps = 0;
    let wasHit = false;
    for (let t = 0; t < maxSec; t += dt, steps++) {
      const c = centerOf(car, spec);
      while (idx < path.length - 1 && Math.hypot(path[idx][0] - c.x, path[idx][1] - c.z) < look) idx++;
      const [tx, tz] = path[idx];
      let err = Math.atan2(tx - car.x, tz - car.z) - car.heading;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      const steerInput = Math.max(-1, Math.min(1, (err * 1.6) / spec.maxSteer));
      const r = step(spec, car, { throttle: car.v < speed ? 1 : 0, brake: 0, steerInput }, dt);
      if (r === 'hit') { if (!wasHit) collisions++; wasHit = true; } else wasHit = false;
      if (r === 'off') offGround++;
      maxY = Math.max(maxY, car.y);
      if (goal(car)) return { maxY, collisions, offGround, reached: true, lastHit, steps, car };
    }
    return { maxY, collisions, offGround, reached: false, lastHit, steps, car };
  };
  return { place, step, drive };
}

/** 점열 보조: 직선/반원 */
export const line = (x0: number, z0: number, x1: number, z1: number, d = 1): [number, number][] => {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / d));
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n] as [number, number]);
};
export const arc = (cx: number, cz: number, r: number, a0: number, a1: number, d = 0.5): [number, number][] => {
  const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / d));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), cz + r * Math.sin(a)] as [number, number];
  });
};
