import type { Action } from '../game/input';
import { onTap } from './tap';
import type { CheckItem, Guidance, MachineState } from '../mech/machine';

/** 기계식 주차 패널: 좌측 컬럼 안에 들어가 기존 HUD 와 겹치지 않는다. 키보드(G/J/K/X)와 같은 Action 경로를 쓴다. */
export class MechPanel {
  readonly el: HTMLDivElement;
  private phaseEl: HTMLElement;
  private msgEl: HTMLElement;
  private btnExit: HTMLButtonElement;
  private last = '';

  constructor(parent: HTMLElement, onAction: (a: Action) => void) {
    this.el = document.createElement('div');
    this.el.id = 'mech-panel';
    this.el.className = 'glass hidden';
    this.el.innerHTML = `
      <div class="mc-head"><span class="mc-name">기계식 주차</span><span class="mc-time" data-r="phase"></span></div>
      <div class="mc-sub" data-r="msg"></div>
      <div class="mech-btns">
        <button data-a="mechExit" title="하차/탑승 (G)">하차</button>
        <button data-a="mechStart" title="입고 시작 (J)">입고</button>
        <button data-a="mechRetrieve" title="출고 요청 (K)">출고</button>
        <button data-a="mechPanel" title="제어반 (Z)" aria-label="제어반">제어</button>
        <button data-a="mechEstop" class="estop" title="비상 정지/해제 (X)">정지</button>
      </div>`;
    parent.appendChild(this.el);
    this.phaseEl = this.el.querySelector('[data-r="phase"]')!;
    this.msgEl = this.el.querySelector('[data-r="msg"]')!;
    this.btnExit = this.el.querySelector('[data-a="mechExit"]')!;
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => onTap(b, () => onAction(b.dataset.a as Action)));
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  update(m: MachineState, items: CheckItem[], guide?: Guidance): void {
    const PH: Record<string, string> = { closing: '문 닫는 중', toBay: '리프트 이동 중', stored: '주차 완료 · 출고 대기', fromBay: '출고 이동 중', rotating: '턴테이블 회전 중', opening: '문 여는 중', exit: '출고 완료', estop: '비상 정지' };
    const failed = items.filter((c) => !c.ok);
    let phase = PH[m.phase] ?? '';
    if (m.phase === 'waiting') {
      const g = guide?.state;
      phase = g === 'stop' && failed.length === 0 ? '입고 준비 완료' : g === 'stop' ? '정위치' : g === 'align' ? '정렬 중' : g === 'back' ? '후진 필요' : g === 'blocked' ? '진입 제한' : '입고 준비';
    }
    // 대기 중에는 아직 충족하지 못한 첫 번째 조건 1개만 보여 준다 (패널을 짧게 유지)
    const line = m.phase === 'waiting' ? (failed.length ? failed[0].label : '입고(J)를 누르세요') : m.message;
    const key = `${phase}|${m.occupant}|${line}|${m.locked}`;
    if (key === this.last) return;
    this.last = key;
    this.phaseEl.textContent = phase;
    this.btnExit.textContent = m.occupant === 'in' ? '하차' : '탑승';
    this.msgEl.textContent = line;
    this.msgEl.dataset.ok = m.phase === 'waiting' && failed.length === 0 ? '1' : '0';
  }
}
