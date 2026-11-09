import type { Action } from '../game/input';
import { onTap } from './tap';
import type { CheckItem, MachineState } from '../mech/machine';

/** 기계식 주차 패널: 좌측 컬럼 안에 들어가 기존 HUD 와 겹치지 않는다. 키보드(G/J/K/X)와 같은 Action 경로를 쓴다. */
export class MechPanel {
  readonly el: HTMLDivElement;
  private phaseEl: HTMLElement;
  private listEl: HTMLElement;
  private msgEl: HTMLElement;
  private btnExit: HTMLButtonElement;
  private last = '';

  constructor(parent: HTMLElement, onAction: (a: Action) => void) {
    this.el = document.createElement('div');
    this.el.id = 'mech-panel';
    this.el.className = 'glass hidden';
    this.el.innerHTML = `
      <div class="mc-head"><span class="mc-name">기계식 주차</span><span class="mc-time" data-r="phase"></span></div>
      <ul class="mc-list" data-r="list"></ul>
      <div class="mc-sub" data-r="msg"></div>
      <div class="mech-btns">
        <button data-a="mechExit" title="하차/탑승 (G)">하차</button>
        <button data-a="mechStart" title="입고 시작 (J)">입고</button>
        <button data-a="mechRetrieve" title="출고 요청 (K)">출고</button>
        <button data-a="mechEstop" class="estop" title="비상 정지/해제 (X)">정지</button>
      </div>`;
    parent.appendChild(this.el);
    this.phaseEl = this.el.querySelector('[data-r="phase"]')!;
    this.listEl = this.el.querySelector('[data-r="list"]')!;
    this.msgEl = this.el.querySelector('[data-r="msg"]')!;
    this.btnExit = this.el.querySelector('[data-a="mechExit"]')!;
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => onTap(b, () => onAction(b.dataset.a as Action)));
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  update(m: MachineState, items: CheckItem[]): void {
    const PH: Record<string, string> = { waiting: '대기', closing: '문 닫는 중', toBay: '입고 이동', stored: '저장됨', fromBay: '출고 이동', opening: '문 여는 중', exit: '출고 완료', estop: '비상 정지' };
    const failed = items.filter((c) => !c.ok);
    const key = `${m.phase}|${m.occupant}|${m.message}|${failed.map((f) => f.key).join()}|${m.locked}`;
    if (key === this.last) return;
    this.last = key;
    this.phaseEl.textContent = PH[m.phase] ?? m.phase;
    this.btnExit.textContent = m.occupant === 'in' ? '하차' : '탑승';
    // 대기 중에만 점검 항목 표시(실패한 항목 최대 4개) — 일반 화면에 거리 숫자는 넣지 않는다
    this.listEl.innerHTML =
      m.phase === 'waiting'
        ? (failed.length ? failed.slice(0, 4).map((c) => `<li data-ok="0"><i></i><span>${c.label}</span><b>✗</b></li>`).join('') : '<li data-ok="1"><i></i><span>입고 준비 완료</span><b>✓</b></li>')
        : '';
    this.msgEl.textContent = m.message;
  }
}
