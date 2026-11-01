import type { Action } from './input';

/** 게임패드 매핑 (순수 함수, 테스트 가능). 변속은 키보드/터치와 같은 Action 경로 → 같은 인터록 정책을 통과한다. */
export interface PadSnapshot {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}
export interface PadMapped {
  steer: number | null; // 왼쪽 + (-1..1)
  throttle: number | null; // 0..1
  brake: number | null; // 0..1
  actions: Action[];
}

const DEAD = 0.15;
export function mapGamepad(pad: PadSnapshot | null, prevPressed: readonly boolean[]): { out: PadMapped; pressed: boolean[] } {
  if (!pad) return { out: { steer: null, throttle: null, brake: null, actions: [] }, pressed: [] };
  const ax = pad.axes[0] ?? 0;
  const steer = Math.abs(ax) < DEAD ? 0 : -Math.sign(ax) * ((Math.abs(ax) - DEAD) / (1 - DEAD)); // 스틱 오른쪽(+) = 오른쪽 조향(-)
  const b = (i: number): number => pad.buttons[i]?.value ?? 0;
  const pressed = pad.buttons.map((x) => x.pressed);
  const edge = (i: number): boolean => !!pressed[i] && !prevPressed[i];
  const actions: Action[] = [];
  // D-pad 위/아래: P ↔ R ↔ N ↔ D 순서로 한 칸씩 (실제 변속 가능 여부는 정책이 결정)
  if (edge(12)) actions.push('gearStepUp');
  if (edge(13)) actions.push('gearStepDown');
  if (edge(0)) actions.push('handbrake'); // A
  if (edge(3)) actions.push('camera'); // Y
  if (edge(2)) actions.push('headlights'); // X
  if (edge(1)) actions.push('assistToggle'); // B
  if (edge(4)) actions.push('signalLeft'); // LB
  if (edge(5)) actions.push('signalRight'); // RB
  if (edge(9)) actions.push('pause'); // Start
  return { out: { steer, throttle: b(7), brake: b(6), actions }, pressed };
}
