import type { Action } from '../game/input';
import type { LiftCheck, LiftState } from '../service/lift';
import { onTap } from './tap';

/** 정비소 2주식 리프트 패널 (#top-right, 기계식 패널과 같은 스타일). 키보드(PageUp/PageDown/End)와 같은 Action 경로를 쓴다 */
export class LiftPanel {
  readonly el: HTMLDivElement;
  private phaseEl: HTMLElement;
  private msgEl: HTMLElement;
  private nameEl: HTMLElement;
  private last = '';

  constructor(parent: HTMLElement, onAction: (a: Action) => void) {
    this.el = document.createElement('div');
    this.el.id = 'lift-panel';
    this.el.className = 'glass hidden';
    this.el.innerHTML = `
      <div class="mc-head"><span class="mc-name">2주식 리프트</span><span class="mc-time" data-r="phase"></span></div>
      <div class="mc-sub" data-r="msg"></div>
      <div class="mech-btns">
        <button data-a="liftUp" title="상승 (PageUp)">상승</button>
        <button data-a="liftStop" title="정지 (End)">정지</button>
        <button data-a="liftDown" title="하강 (PageDown)">하강</button>
      </div>`;
    parent.appendChild(this.el);
    this.phaseEl = this.el.querySelector('[data-r="phase"]')!;
    this.msgEl = this.el.querySelector('[data-r="msg"]')!;
    this.nameEl = this.el.querySelector('.mc-name')!;
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => onTap(b, () => onAction(b.dataset.a as Action)));
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  update(s: LiftState, checks: LiftCheck[], name = ''): void {
    if (name && this.nameEl.textContent !== name) this.nameEl.textContent = name;
    const PH: Record<string, string> = { idle: '대기', armsIn: '고정 중', raising: '상승 중', holding: '정지(고정)', lowering: '하강 중', armsOut: '고정 해제 중' };
    const failed = checks.filter((c) => !c.ok);
    const line = s.phase === 'idle' ? (failed.length ? failed[0].label : '상승(PageUp)을 누르세요') : s.message;
    const key = `${s.phase}|${line}`;
    if (key === this.last) return;
    this.last = key;
    this.phaseEl.textContent = PH[s.phase] ?? '';
    this.msgEl.textContent = line;
    this.msgEl.dataset.ok = s.phase === 'idle' && failed.length === 0 ? '1' : '0';
  }
}
