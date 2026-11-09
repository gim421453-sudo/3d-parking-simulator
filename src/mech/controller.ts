import { localToWorld, worldToLocal } from '../core/math';
import { centerOf } from '../vehicle/physics';
import type { VehicleState } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';
import type { Action } from '../game/input';
import {
  STATION,
  type AlignInput,
  type BayId,
  type CheckItem,
  type MachineState,
  checklist,
  emergencyRelease,
  emergencyStop,
  lockedPose,
  newMachine,
  releaseVehicle,
  requestRetrieve,
  resetToWaiting,
  startStore,
  stepMachine,
  stopperPushback,
  toggleOccupant,
} from './machine';

/** 게임 루프와 순수 장치 로직(machine.ts)을 잇는 얇은 계층 (THREE 의존 없음 → 단위 테스트 가능) */
export class MechController {
  m: MachineState = newMachine();
  /** 다음 입고에 쓸 베이 (번갈아 사용) */
  private nextBay = 0;
  items: CheckItem[] = [];
  /** 이번 프레임의 문 구역 점유 */
  doorClear = true;
  stopperHits = 0;

  reset(): void {
    this.m = newMachine();
    this.nextBay = 0;
    this.items = [];
    this.stopperHits = 0;
  }

  input(spec: VehicleSpec, car: VehicleState): AlignInput {
    void spec;
    return { x: car.x, z: car.z, heading: car.heading, v: car.v, gear: car.gear, handbrake: car.handbrake };
  }

  /** 출고 미션 시작: 차량이 베이 A1 에 저장되어 있는 상태로 */
  presetStored(spec: VehicleSpec, car: VehicleState): void {
    const m = this.m;
    car.x = STATION.stopperX - spec.wheelbase;
    car.z = 0;
    car.heading = STATION.heading;
    car.gear = 'P';
    car.handbrake = true;
    car.v = 0;
    m.occupant = 'out';
    m.bay = 'A1';
    m.phase = 'stored';
    m.locked = true;
    m.door = 0;
    m.palletY = 3;
    m.palletZ = 3.6;
    const rel = worldToLocal(STATION.palletX, 0, STATION.heading, car.x, car.z);
    m.rel = { x: rel.x, z: rel.z, heading: 0 };
    m.message = '차량이 저장되어 있습니다 — 출고(K)';
    this.applyLocked(car);
  }

  /** 승강/이송/저장 중 차량을 팔레트에 고정 (상대 위치 불변) */
  applyLocked(car: VehicleState): boolean {
    if (!this.m.locked) return false;
    const p = lockedPose(this.m);
    if (!p) return false;
    car.x = p.x;
    car.z = p.z;
    car.y = p.y;
    car.heading = p.heading;
    car.v = 0;
    car.pitch = 0;
    car.slope = 0;
    return true;
  }

  /** 앞바퀴 정지턱: 넘으려 하면 뒤로 밀어내고 속도 0. 밀어낸 거리를 반환 */
  stopper(spec: VehicleSpec, car: VehicleState): number {
    if (this.m.locked) return 0;
    const back = stopperPushback(spec, this.input(spec, car));
    if (back > 0) {
      car.x -= Math.sin(car.heading) * back;
      car.z -= Math.cos(car.heading) * back;
      if (car.v > 0) car.v = 0;
      this.stopperHits++;
    }
    return back;
  }

  /** 문 구역(문 평면 ±0.5m)에 차체가 걸쳐 있는가 — 안전센서 입력 */
  private bodyInDoorZone(spec: VehicleSpec, car: VehicleState): boolean {
    const c = centerOf(car, spec);
    const hl = spec.length / 2;
    const hw = spec.width / 2;
    const xs = [
      [hw, hl],
      [-hw, hl],
      [-hw, -hl],
      [hw, -hl],
    ].map(([lx, lz]) => localToWorld(c.x, c.z, car.heading, lx, lz).x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return hi >= STATION.doorX - 0.5 && lo <= STATION.doorX + 0.5;
  }

  step(dt: number, spec: VehicleSpec, car: VehicleState): void {
    this.doorClear = !this.bodyInDoorZone(spec, car) || this.m.locked; // 고정된 차량은 이미 안쪽에 있다
    this.m.doorBlocked = false;
    stepMachine(this.m, dt, this.doorClear);
    if (this.m.locked) this.applyLocked(car);
    this.items = checklist(spec, this.input(spec, car), this.m);
  }

  /** 액션 처리. 사용자에게 보여줄 토스트 메시지를 반환 */
  onAction(a: Action, spec: VehicleSpec, car: VehicleState): { msg: string; kind: '' | 'warn' | 'bad' | 'good' } | null {
    const m = this.m;
    const s = this.input(spec, car);
    switch (a) {
      case 'mechExit': {
        if (m.phase === 'exit') {
          // 출고 후 탑승 → 운전 가능 상태로 해제
          m.occupant = 'in';
          releaseVehicle(m);
          resetToWaiting(m);
          car.handbrake = true;
          return { msg: '탑승했습니다 — 주차 브레이크를 풀고 출차하세요', kind: 'good' };
        }
        const r = toggleOccupant(s, m);
        return { msg: r.reason, kind: r.ok ? 'good' : 'warn' };
      }
      case 'mechStart': {
        const bay: BayId = (['A1', 'B1', 'A2', 'B2'] as const)[this.nextBay % 4];
        if (startStore(spec, s, m, bay)) {
          this.nextBay++;
          return { msg: `입고 시작 (${bay})`, kind: 'good' };
        }
        return { msg: m.message, kind: 'bad' };
      }
      case 'mechRetrieve':
        return requestRetrieve(m) ? { msg: '출고를 시작합니다', kind: 'good' } : { msg: m.message, kind: 'warn' };
      case 'mechEstop':
        if (m.phase === 'estop') emergencyRelease(m);
        else emergencyStop(m);
        return { msg: m.message, kind: m.phase === 'estop' ? 'bad' : 'good' };
      default:
        return null;
    }
  }

  /** 운전자가 하차했거나 고정 중이면 주행 입력을 막는다 */
  blocksDriving(): boolean {
    return this.m.occupant === 'out' || this.m.locked;
  }
}
