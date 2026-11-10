import { angleDiff, clamp, localToWorld, worldToLocal } from '../core/math';
import { centerOf } from '../vehicle/physics';
import type { VehicleState } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';
import type { Action } from '../game/input';
import {
  STATION,
  guidance,
  pocketDepthAt,
  type Guidance,
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
const MECH_HALF = 1.1; // 정지 홈은 팔레트 중심 ±1.1m 안(좌우 홈 폭)에 있다

export class MechController {
  m: MachineState = newMachine();
  /** 다음 입고에 쓸 베이 (번갈아 사용) */
  private nextBay = 0;
  items: CheckItem[] = [];
  /** 이번 프레임의 문 구역 점유 */
  doorClear = true;
  stopperHits = 0;
  /** 입구 표시기 상태 (실제 차량 위치로 계산) */
  guide: Guidance = { state: 'blocked', text: '', steer: null };
  /** 앞바퀴 안착 홈: 현재 침하량(m), 안착 이벤트 횟수/마지막 충격 세기(0..1) */
  dip = 0;
  seatCount = 0;
  lastSeatImpact = 0;
  private seatArmed = true;
  private kick = 0;
  private kickT = 99;

  /** 출입문(셔터) 충돌체가 필요한가: 문이 60% 이상 닫힌 상태 */
  doorBlocking(): boolean {
    return this.m.door < 0.6;
  }

  reset(): void {
    this.dip = 0;
    this.seatCount = 0;
    this.lastSeatImpact = 0;
    this.seatArmed = true;
    this.kick = 0;
    this.kickT = 99;
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

  /**
   * 팔레트 위에서 앞바퀴가 정지 홈에 걸려 살짝 내려앉는 느낌(저속 접촉 모델). 차량을 끌어당기지 않고 높이/피치만 3cm 이내로 바꾼다.
   * 속도가 빠를수록 안착 시 충격(작은 진동)이 커진다. 이벤트는 홈을 벗어났다가 다시 들어올 때마다 1회.
   */
  settle(dt: number, spec: VehicleSpec, car: VehicleState): boolean {
    const m = this.m;
    let target = 0;
    const onLine = !m.locked && m.yaw === 0 && Math.abs(angleDiff(car.heading, STATION.heading)) < 0.5;
    if (onLine) {
      const f = localToWorld(car.x, car.z, car.heading, 0, spec.wheelbase);
      if (Math.abs(f.z) < MECH_HALF) target = pocketDepthAt(f.x);
    }
    let seated = false;
    if (target > 0.6 * 0.03 && this.seatArmed) {
      this.seatArmed = false;
      seated = true;
      this.seatCount++;
      this.lastSeatImpact = clamp(Math.abs(car.v) / 1.2, 0.1, 1);
      this.kick = 0.006 + 0.012 * this.lastSeatImpact; // rad
      this.kickT = 0;
    } else if (target < 0.2 * 0.03) this.seatArmed = true;
    this.dip += (target - this.dip) * Math.min(1, dt * 14);
    this.kickT += dt;
    const osc = this.kickT < 0.6 ? this.kick * Math.exp(-this.kickT * 9) * Math.cos(this.kickT * 38) : 0;
    if (!m.locked) {
      car.pitch = -Math.atan2(this.dip, spec.wheelbase) + osc;
      car.slope = 0;
    }
    return seated;
  }

  step(dt: number, spec: VehicleSpec, car: VehicleState): void {
    // 출고 후 차량이 팔레트를 벗어나면 턴테이블을 원위치(0°)로 되돌린다
    if (this.m.phase === 'waiting' && this.m.yaw > 0 && !this.m.locked) {
      const away = Math.hypot(car.x - STATION.palletX, car.z) > 4.2;
      if (away) this.m.yaw = Math.max(0, this.m.yaw - dt * 0.9);
    }
    this.guide = guidance(spec, this.input(spec, car), this.m);
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
