import type { SensorGroup } from '../vehicle/spec';

/**
 * 자동 시점 전환 후보 게이트 (순수 로직, v0.4.9). 장애물이 "있다"는 사실과 "카메라를 바꿔야 한다"를 분리한다.
 *  - 진행 방향(D=전방/R=후방): 매우 가까운 장애물이 예상 이동 경로(조향 반영)에 있을 때만 집중 탑뷰 후보
 *  - 측면: 그 쪽으로 조향(|steer|>0.1)하며 실제로 움직이고(|v|>0.3) 간격이 SIDE_GAP 미만일 때만 측면뷰 후보
 *  - 나란히 선 벽/주차 차량만으로는 어떤 보조 시점도 후보가 되지 않는다 (기본 전/후방 카메라 유지)
 */
export const GATE_PATH_CUT = 2.2; // 예상 경로 충돌 거리 이하(m)
export const GATE_SIDE_GAP = 1.0;
export const GATE_STEER = 0.1;
export const GATE_SPEED = 0.3;

export interface GateInput {
  threat: Record<SensorGroup, boolean>;
  veryClose: Record<SensorGroup, boolean>;
  gap: Record<SensorGroup, number | null>;
}
export interface GateContext {
  gear: 'P' | 'R' | 'N' | 'D';
  v: number; // m/s
  steer: number; // rad, 왼쪽 +
  pathCut: number; // 예상 이동 경로가 장애물과 만나는 거리(m)
}

export function gateViewRisk(r: GateInput, c: GateContext): { threat: Record<SensorGroup, boolean>; veryClose: Record<SensorGroup, boolean> } {
  const dir: 'front' | 'rear' = c.gear === 'R' ? 'rear' : 'front';
  const moving = Math.abs(c.v) > GATE_SPEED;
  const threat = { ...r.threat };
  const veryClose = { ...r.veryClose };
  veryClose[dir] = veryClose[dir] && c.pathCut < GATE_PATH_CUT;
  for (const side of ['left', 'right'] as const) {
    const toward = side === 'left' ? c.steer > GATE_STEER : c.steer < -GATE_STEER;
    const g = r.gap[side];
    threat[side] = threat[side] && moving && toward && g !== null && g < GATE_SIDE_GAP;
  }
  return { threat, veryClose };
}
