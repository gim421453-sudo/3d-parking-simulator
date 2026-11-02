import { localToWorld, worldToLocal } from '../core/math';
import type { FrameResult } from './framing';

/**
 * 안정화된 주차 보조 카메라 구도.
 * 시점에 "진입할 때" 한 번 계산한 구도를 **차량 기준 좌표(local)** 로 저장해 두고, 이후에는 차량이 움직이는 대로만 따라간다.
 * (센서 히트점이 바뀔 때마다 위치/높이/FOV 를 다시 계산하지 않는다 → 마구잡이 회전·확대·축소 방지)
 */
export interface Pose2 {
  x: number;
  z: number;
  heading: number;
  y?: number;
}
export interface LocalFrame {
  view: string;
  pos: { x: number; y: number; z: number }; // 차량 로컬 (x 왼쪽+, z 앞+), y 는 월드 높이
  look: { x: number; y: number; z: number };
  /** 'forward' = 화면 위쪽이 차량 진행 방향(탑뷰), 'up' = 월드 위쪽(3D 시점) */
  upMode: 'forward' | 'up';
  fov: number;
  visible: boolean;
}

export function toLocalFrame(view: string, f: FrameResult, pose: Pose2): LocalFrame {
  const p = worldToLocal(pose.x, pose.z, pose.heading, f.pos.x, f.pos.z);
  const l = worldToLocal(pose.x, pose.z, pose.heading, f.look.x, f.look.z);
  return {
    view,
    pos: { x: p.x, y: f.pos.y - (pose.y ?? 0), z: p.z }, // y 는 차량(지면) 기준 상대 높이
    look: { x: l.x, y: f.look.y - (pose.y ?? 0), z: l.z },
    upMode: Math.abs(f.up.y) > 0.5 ? 'up' : 'forward',
    fov: f.fov,
    visible: f.visible,
  };
}

export function fromLocalFrame(lf: LocalFrame, pose: Pose2): { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; fov: number } {
  const p = localToWorld(pose.x, pose.z, pose.heading, lf.pos.x, lf.pos.z);
  const l = localToWorld(pose.x, pose.z, pose.heading, lf.look.x, lf.look.z);
  return {
    pos: { x: p.x, y: lf.pos.y + (pose.y ?? 0), z: p.z },
    look: { x: l.x, y: lf.look.y + (pose.y ?? 0), z: l.z },
    up: lf.upMode === 'up' ? { x: 0, y: 1, z: 0 } : { x: Math.sin(pose.heading), y: 0, z: Math.cos(pose.heading) },
    fov: lf.fov,
  };
}

/**
 * 구도를 다시 잡아야 하는가? 시점이 바뀌었을 때, 또는 가까운 실제 장애물이 일정 시간 화면 밖에 있을 때(쿨다운 적용).
 * 매 프레임 재계산하지 않기 위한 순수 판정 로직이다.
 */
export class RelatchGate {
  private outT = 0;
  private since = 0;
  private t = 0;
  constructor(
    private holdSec = 0.6, // 화면 밖 상태가 이 시간 이상 지속되어야 재구성
    private cooldownSec = 2.0, // 재구성 사이 최소 간격
  ) {}
  reset(): void {
    this.outT = 0;
    this.since = this.t;
  }
  /** nearOutOfView: 차체 가까이의 감지 장애물이 하나라도 화면 밖인가 */
  update(dt: number, nearOutOfView: boolean): boolean {
    this.t += dt;
    this.outT = nearOutOfView ? this.outT + dt : 0;
    if (this.outT >= this.holdSec && this.t - this.since >= this.cooldownSec) {
      this.since = this.t;
      this.outT = 0;
      return true;
    }
    return false;
  }
}
