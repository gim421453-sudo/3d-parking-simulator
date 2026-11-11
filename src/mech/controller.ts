import { angleDiff, clamp, localToWorld, worldToLocal } from '../core/math';
import { centerOf } from '../vehicle/physics';
import type { VehicleState } from '../vehicle/physics';
import type { VehicleSpec } from '../vehicle/spec';
import type { Action } from '../game/input';
import {
  STATION,
  SLOTS,
  alignment,
  bumpDecel,
  cancelOp,
  checklist,
  emergencyRelease,
  emergencyStop,
  entryHeading,
  freeSlots,
  guidance,
  isSlotId,
  lockedPose,
  newMachine,
  pocketDepthAt,
  releaseVehicle,
  requestRetrieve,
  resetToWaiting,
  startStore,
  stepMachine,
  storedPose,
  toggleOccupant,
  type AlignInput,
  type CheckItem,
  type Guidance,
  type MachineEvent,
  type MachineState,
  type StoredCar,
} from './machine';

const MECH_HALF = 1.1; // 정지 홈은 팔레트 중심 ±1.1m 안(좌우 홈 폭)에 있다

/** 게임 루프와 순수 장치 로직(machine.ts)을 잇는 얇은 계층 (THREE 의존 없음 → 단위 테스트 가능) */
export class MechController {
  m: MachineState = newMachine();
  items: CheckItem[] = [];
  /** 이번 프레임의 문 구역 점유 */
  doorClear = true;
  bumpHits = 0;
  /** 제어반에서 선택한 보관 슬롯 (입고/출고 대상) */
  selectedSlot = '02A';
  /** 입구 표시기 상태 (실제 차량 위치로 계산) */
  guide: Guidance = { state: 'blocked', text: '', steer: null, mode: 'fwd' };
  /** 기준 차축 안착 홈: 현재 침하량(m), 안착 이벤트 횟수/마지막 충격 세기(0..1) */
  dip = 0;
  seatCount = 0;
  lastSeatImpact = 0;
  private seatArmed = true;
  private kick = 0;
  private kickT = 99;
  /** 이번 프레임에 처리된 이벤트 (Game 이 소비) */
  events: MachineEvent[] = [];
  /** 플레이어 차량이 보관 슬롯에 들어가 있는 관찰 상태(조작 불가) */
  observing = false;
  /** 가이드 접촉 경고 */
  guideContact = false;
  private lastGuideContact = false;
  guideContacts = 0;

  /** 출입문(셔터) 충돌체가 필요한가: 문이 60% 이상 닫힌 상태 */
  doorBlocking(): boolean {
    return this.m.door < 0.6;
  }

  reset(): void {
    this.m = newMachine();
    this.items = [];
    this.bumpHits = 0;
    this.dip = 0;
    this.seatCount = 0;
    this.lastSeatImpact = 0;
    this.seatArmed = true;
    this.kick = 0;
    this.kickT = 99;
    this.events = [];
    this.guideContact = false;
    this.lastGuideContact = false;
    this.guideContacts = 0;
    this.observing = false;
    this.selectedSlot = '02A';
  }

  input(spec: VehicleSpec, car: VehicleState): AlignInput {
    void spec;
    return { x: car.x, z: car.z, heading: car.heading, v: car.v, gear: car.gear, handbrake: car.handbrake };
  }

  /** 슬롯에 차량을 미리 보관해 둔 상태로 시작 (출고 미션/테스트). 차량 pose 는 슬롯 위가 아니라 호출 전이다 */
  seedStored(slot: string, specId: string, mode: 'fwd' | 'rev', spec: VehicleSpec): StoredCar {
    const refX = STATION.stopperX;
    const rearX = mode === 'fwd' ? refX - spec.wheelbase : refX; // 뒷축 x
    const rel = worldToLocal(STATION.palletX, 0, STATION.heading, rearX, 0);
    const car: StoredCar = { carId: this.m.nextCarId++, specId, mode, rel: { x: rel.x, z: rel.z, heading: mode === 'fwd' ? 0 : Math.PI }, since: this.m.clock };
    this.m.slots[slot] = car;
    return car;
  }

  /** 승강/이송/호출 중 차량을 팔레트에 고정 (상대 위치 불변) */
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

  /** 낮은 정지턱: 바퀴가 타고 넘는 약한 저항만 준다(차량을 밀어내거나 멈추지 않는다). 감속한 속도(m/s) 반환 */
  bump(spec: VehicleSpec, car: VehicleState, dt: number): number {
    if (this.m.locked) return 0;
    const d = bumpDecel(spec, this.input(spec, car));
    if (d <= 0 || Math.abs(car.v) < 0.02) return 0;
    const dv = Math.min(Math.abs(car.v), d * dt);
    car.v -= Math.sign(car.v) * dv;
    this.bumpHits++;
    return dv;
  }

  /** 낮은 가이드를 타이어가 타고 넘는(침범) 동안의 저항 + 경고. 차체(지상고 0.2m)는 가이드(0.12m) 위로 지나간다 */
  guideDrag(spec: VehicleSpec, car: VehicleState, dt: number): boolean {
    if (this.m.locked) return false;
    const a = alignment(spec, this.input(spec, car));
    const contact = a.onPallet && a.guideInvasion.some(Boolean);
    if (contact && Math.abs(car.v) > 0.02) car.v -= Math.sign(car.v) * Math.min(Math.abs(car.v), 0.6 * dt);
    this.guideContact = contact;
    if (contact && !this.lastGuideContact) this.guideContacts++;
    this.lastGuideContact = contact;
    return contact;
  }

  /**
   * 팔레트 위에서 기준 차축(전진 입고=앞차축, 후진 입고=뒷차축)이 정지 홈에 걸려 살짝 내려앉는 느낌(저속 접촉 모델).
   * 차량을 끌어당기지 않고 높이/피치만 3cm 이내로 바꾼다. 속도가 빠를수록 충격(작은 진동)이 크다.
   */
  settle(dt: number, spec: VehicleSpec, car: VehicleState): boolean {
    const m = this.m;
    let target = 0;
    let sign = -1;
    const a = alignment(spec, this.input(spec, car));
    const onLine = !m.locked && m.yaw === 0 && Math.abs(angleDiff(car.heading, entryHeading(a.mode))) < 0.5 && Math.abs(a.lateral) < MECH_HALF;
    if (onLine) {
      target = pocketDepthAt(STATION.stopperX - a.stopperGap);
      sign = a.mode === 'fwd' ? -1 : 1; // 전진: 앞이 내려감(피치 −), 후진: 뒤가 내려감(피치 +)
    }
    let seated = false;
    if (target > 0.6 * 0.03 && this.seatArmed) {
      this.seatArmed = false;
      seated = true;
      this.seatCount++;
      this.lastSeatImpact = clamp(Math.abs(car.v) / 1.2, 0.1, 1);
      this.kick = 0.006 + 0.012 * this.lastSeatImpact;
      this.kickT = 0;
    } else if (target < 0.2 * 0.03) this.seatArmed = true;
    this.dip += (target - this.dip) * Math.min(1, dt * 14);
    this.kickT += dt;
    const osc = this.kickT < 0.6 ? this.kick * Math.exp(-this.kickT * 9) * Math.cos(this.kickT * 38) : 0;
    if (!m.locked) {
      car.pitch = sign * Math.atan2(this.dip, spec.wheelbase) + osc;
      car.slope = 0;
    }
    return seated;
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
    // 출고 후 차량이 팔레트를 벗어나면 턴테이블을 원위치(0°)로 되돌린다
    if (this.m.phase === 'waiting' && this.m.yaw > 0 && !this.m.locked) {
      const away = Math.hypot(car.x - STATION.palletX, car.z) > 4.2;
      if (away) this.m.yaw = Math.max(0, this.m.yaw - dt * 0.9);
    }
    // 관찰 상태(차량이 슬롯에 보관됨): 승강장의 다음 입고 안내는 차량 위치와 무관하다
    this.guide = this.observing ? { state: this.m.phase === 'waiting' ? 'forward' : 'blocked', text: this.m.phase === 'waiting' ? '전진' : '진입 금지', steer: null, mode: 'fwd' } : guidance(spec, this.input(spec, car), this.m);
    // 플레이어 차량이 승강장/문 구역에 있을 때만 문 안전센서 입력으로 본다 (보관 중이거나 호출 중이면 차량은 장치 안)
    const inZone = this.bodyInDoorZone(spec, car);
    this.doorClear = !inZone || this.m.locked || this.m.phase === 'calling' || this.m.phase === 'pulling';
    this.m.doorBlocked = false;
    stepMachine(this.m, dt, this.doorClear);
    if (this.m.locked) this.applyLocked(car);
    // 입고 이벤트에 차종을 채운다
    for (const e of this.m.events) {
      if (e.type === 'stored' && e.slot) {
        const sc = this.m.slots[e.slot];
        if (sc && !sc.specId) sc.specId = spec.id;
      }
    }
    if (this.m.events.length) {
      this.events.push(...this.m.events);
      this.m.events = [];
    }
    this.items = checklist(spec, this.input(spec, car), this.m, this.selectedSlot);
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
        if (!isSlotId(this.selectedSlot) || m.slots[this.selectedSlot]) {
          const f = freeSlots(m)[0];
          if (!f) return { msg: '입고 불가: 빈 슬롯이 없습니다', kind: 'bad' };
          if (m.slots[this.selectedSlot]) {
            m.message = `입고 불가: ${this.selectedSlot} 슬롯이 이미 사용 중입니다 — ${f.id} 슬롯이 비어 있습니다`;
            return { msg: m.message, kind: 'bad' };
          }
        }
        if (startStore(spec, s, m, this.selectedSlot)) return { msg: `입고 시작 (${this.selectedSlot})`, kind: 'good' };
        return { msg: m.message, kind: 'bad' };
      }
      case 'mechRetrieve':
        return requestRetrieve(m, this.selectedSlot) ? { msg: `${this.selectedSlot} 출고를 시작합니다`, kind: 'good' } : { msg: m.message, kind: 'warn' };
      case 'mechCancel':
        return cancelOp(m) ? { msg: '작업을 취소했습니다', kind: 'good' } : { msg: m.message, kind: 'warn' };
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
    return this.m.occupant === 'out' || this.m.locked || this.observing;
  }

  /** 보관 중인 모든 차량의 월드 pose (시각화/테스트) */
  storedList(): { slot: string; car: StoredCar; pose: ReturnType<typeof storedPose> }[] {
    return SLOTS.filter((s) => this.m.slots[s.id]).map((s) => ({ slot: s.id, car: this.m.slots[s.id]!, pose: storedPose(s.id, this.m.slots[s.id]!) }));
  }
}
