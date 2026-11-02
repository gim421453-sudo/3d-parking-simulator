export type HeldKey = 'throttle' | 'brake' | 'left' | 'right';

export type Action =
  | 'gearR'
  | 'gearD'
  | 'gearP'
  | 'gearN'
  | 'handbrake'
  | 'camera'
  | 'minimap'
  | 'sensorView'
  | 'signalLeft'
  | 'signalRight'
  | 'hazard'
  | 'headlights'
  | 'reset'
  | 'pause'
  | 'restart'
  | 'assistToggle'
  | 'assistCamera'
  | 'assistClose'
  | 'gearStepUp'
  | 'gearStepDown'
  | 'infoDest'
  | 'sensorToggle'
  | 'soundToggle'
  | 'pdcSurround'
  | 'pdcSensor';

const HELD: Record<string, HeldKey> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

export const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'gearR',
  KeyF: 'gearD',
  KeyP: 'gearP',
  KeyN: 'gearN',
  Space: 'handbrake',
  KeyC: 'camera',
  KeyM: 'minimap',
  KeyV: 'sensorView',
  KeyQ: 'signalLeft',
  KeyE: 'signalRight',
  KeyH: 'hazard',
  KeyL: 'headlights',
  KeyT: 'reset',
  Escape: 'pause',
  KeyB: 'assistToggle',
};

/** 키보드와 화면 버튼(터치)이 같은 상태/액션 경로를 쓴다. */
export class Input {
  readonly held: Record<HeldKey, boolean> = { throttle: false, brake: false, left: false, right: false };
  private virtualHeld: Record<HeldKey, number> = { throttle: 0, brake: 0, left: 0, right: 0 };
  private keyHeld: Record<HeldKey, boolean> = { throttle: false, brake: false, left: false, right: false };
  onAction: (a: Action) => void = () => {};
  enabled = true;
  /** 게임패드 아날로그 입력 (null = 사용 안 함) */
  pad: { steer: number | null; throttle: number | null; brake: number | null } = { steer: null, throttle: null, brake: null };

  attach(): void {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.releaseAll);
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  private keyDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const h = HELD[e.code];
    const a = KEY_ACTIONS[e.code];
    if (h || a === 'handbrake') e.preventDefault();
    if (h) {
      this.keyHeld[h] = true;
      this.sync();
    }
    if (a && !e.repeat) {
      if (!this.enabled && a !== 'pause') return;
      this.onAction(a);
    }
  };

  private keyUp = (e: KeyboardEvent): void => {
    const h = HELD[e.code];
    if (h) {
      this.keyHeld[h] = false;
      this.sync();
    }
  };

  private releaseAll = (): void => {
    for (const k of Object.keys(this.keyHeld) as HeldKey[]) {
      this.keyHeld[k] = false;
      this.virtualHeld[k] = 0;
    }
    this.sync();
  };

  /** 터치 버튼: 포인터 id 단위로 누름 상태를 센다(멀티터치) */
  press(k: HeldKey): void {
    this.virtualHeld[k]++;
    this.sync();
  }
  release(k: HeldKey): void {
    this.virtualHeld[k] = Math.max(0, this.virtualHeld[k] - 1);
    this.sync();
  }

  private sync(): void {
    for (const k of Object.keys(this.held) as HeldKey[]) this.held[k] = this.keyHeld[k] || this.virtualHeld[k] > 0;
  }

  clear(): void {
    this.releaseAll();
  }
}
