import { MissionRunner, type CarFootprint, type MissionDef, type ParkingSlot, computeScore, evaluateParking } from './parking';

/** 기계식 입고 미션: 지정한 보관 슬롯에 차량이 안치되면(`isStored`) 성공. 정확도는 입고 시작 직전의 팔레트 정렬 상태 기준. */
export class MechInRunner extends MissionRunner {
  private lastAcc = 0;
  constructor(
    def: MissionDef,
    slot: ParkingSlot,
    private isStored: () => boolean,
    private canScore: () => boolean = () => true,
  ) {
    super(def, slot);
  }

  update(dt: number, car: CarFootprint, _speed: number): void {
    if (this.status !== 'running') return;
    this.elapsed += dt;
    if (this.canScore()) {
      this.check = evaluateParking(car, this.slot, 'mech-in');
      this.lastAcc = this.check.accuracy;
    }
    if (this.isStored()) {
      this.status = 'success';
      this.score = computeScore({ accuracy: this.lastAcc, timeSec: this.elapsed, parTimeSec: this.def.parTimeSec, collisions: this.collisions });
    } else if (this.elapsed >= this.def.timeLimitSec) {
      this.status = 'failed';
      this.failReason = '제한 시간이 끝났습니다';
    }
  }
}
