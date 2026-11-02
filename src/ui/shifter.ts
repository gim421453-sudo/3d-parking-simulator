import type { Gear } from '../vehicle/physics';
import { allowedShifts, type ShiftDecision } from '../vehicle/transmission';
import { ICON } from './icons';

/**
 * 전자식 기어 레버 (세로 드래그/스와이프). 변속 정책은 transmission.ts 의 순수 로직만 사용한다.
 *  - 레버를 드래그해 원하는 위치(P/R/N/D)에서 손을 떼면 변속 요청. 거부되면 원래 위치로 스냅백 + 사유 표시.
 *  - 지금 변속할 수 없는 위치는 흐리게 표시(브레이크 인터록 안내).
 *  - 취소(pointercancel)/포인터 캡처 소실/창 포커스 이탈/화면 밖 드래그는 변속 없이 안전하게 원위치.
 *  - 첫 번째 포인터만 추적하므로, 다른 손가락으로 브레이크를 누른 채 조작 가능(멀티터치).
 *  - 드래그 중에는 외부 갱신(update)이 레버 위치를 건드리지 않는다.
 */
export const SHIFTER_ORDER: Gear[] = ['P', 'R', 'N', 'D'];
const NAME: Record<Gear, string> = { P: '주차', R: '후진', N: '중립', D: '전진' };

export interface ShifterHost {
  /** 변속 요청. 성공 여부와 사유를 돌려준다 */
  request(g: Gear): ShiftDecision;
  context(): { gear: Gear; v: number; brake: boolean };
}

export class Shifter {
  readonly el: HTMLDivElement;
  private knob: HTMLDivElement;
  private lockEl: HTMLDivElement;
  private posEls = new Map<Gear, HTMLElement>();
  private track: HTMLDivElement;
  private pointerId: number | null = null;
  private dragY = 0; // 트랙 안에서의 y (px)
  private dragging = false;
  private lastGear: Gear = 'P';
  private lastKey = '';

  constructor(parent: HTMLElement, private host: ShifterHost) {
    this.el = document.createElement('div');
    this.el.id = 'shifter';
    this.el.className = 'glass';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', '전자식 기어 레버: 위아래로 드래그해 P/R/N/D 선택');
    this.el.innerHTML = `
      <div class="sh-track">
        ${SHIFTER_ORDER.map((g) => `<div class="sh-pos" data-g="${g}" title="${NAME[g]}"><span>${g}</span></div>`).join('')}
        <div class="sh-rail"></div>
        <div class="sh-knob" tabindex="0" aria-label="기어 레버"><i></i></div>
      </div>
      <div class="sh-lock" aria-live="polite"><span class="ic-wrap">${ICON.parkBrake}</span><span class="t">브레이크</span></div>`;
    parent.appendChild(this.el);
    this.track = this.el.querySelector('.sh-track') as HTMLDivElement;
    this.knob = this.el.querySelector('.sh-knob') as HTMLDivElement;
    this.lockEl = this.el.querySelector('.sh-lock') as HTMLDivElement;
    this.el.querySelectorAll<HTMLElement>('.sh-pos').forEach((p) => this.posEls.set(p.dataset.g as Gear, p));

    const t = this.track;
    t.addEventListener('pointerdown', (e) => {
      if (this.pointerId !== null) return; // 두 번째 손가락은 무시 (브레이크 등 다른 입력용)
      e.preventDefault();
      this.pointerId = e.pointerId;
      this.dragging = true;
      try {
        t.setPointerCapture(e.pointerId);
      } catch {
        /* 일부 환경에서 캡처 실패 */
      }
      this.moveTo(e.clientY);
      this.el.classList.add('dragging');
    });
    t.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.moveTo(e.clientY);
    });
    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return;
      // 손을 뗀 최종 위치를 반영한다 (마지막 pointermove 가 합쳐지거나 늦게 도착해도 놓은 자리의 노치로 변속)
      this.moveTo(e.clientY);
      this.release(true);
    };
    t.addEventListener('pointerup', finish);
    t.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this.pointerId) this.release(false);
    });
    t.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId === this.pointerId) this.release(false);
    });
    window.addEventListener('blur', () => this.pointerId !== null && this.release(false));
    t.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 외부(일시정지/앱 전환)에서 드래그를 안전하게 취소 */
  cancel(): void {
    if (this.pointerId !== null) this.release(false);
  }

  private detentH(): number {
    return this.track.clientHeight / SHIFTER_ORDER.length || 1;
  }

  private nearestIndex(y: number): number {
    return Math.max(0, Math.min(SHIFTER_ORDER.length - 1, Math.floor(y / this.detentH())));
  }

  private moveTo(clientY: number): void {
    const r = this.track.getBoundingClientRect();
    // 트랙 밖(화면 위/아래)으로 끌어도 양 끝에 고정
    this.dragY = Math.max(0, Math.min(r.height, clientY - r.top));
    this.placeKnob(this.dragY - this.detentH() / 2, false);
    const idx = this.nearestIndex(this.dragY);
    const g = SHIFTER_ORDER[idx];
    const d = this.decision(g);
    this.markHover(g, d.ok);
  }

  private decision(g: Gear): ShiftDecision {
    const c = this.host.context();
    return allowedShifts(c.gear, c.v, c.brake)[g];
  }

  private markHover(g: Gear | null, ok: boolean): void {
    for (const [k, el] of this.posEls) {
      el.classList.toggle('hover', k === g && ok);
      el.classList.toggle('blocked', k === g && !ok);
    }
    this.el.classList.toggle('reject-hint', g !== null && !ok);
  }

  private release(commit: boolean): void {
    const id = this.pointerId;
    this.pointerId = null;
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
    if (id !== null) {
      try {
        this.track.releasePointerCapture(id);
      } catch {
        /* 이미 해제됨 */
      }
    }
    const idx = this.nearestIndex(this.dragY);
    const target = SHIFTER_ORDER[idx];
    this.markHover(null, true);
    if (commit && target !== this.host.context().gear) {
      const d = this.host.request(target);
      if (!d.ok) {
        this.el.classList.remove('reject');
        void this.el.offsetWidth; // 애니메이션 재시작
        this.el.classList.add('reject');
      }
    }
    this.snapToGear(this.host.context().gear);
  }

  private placeKnob(y: number, animate: boolean): void {
    this.knob.style.transition = animate ? 'transform .16s cubic-bezier(.2,.9,.3,1.2)' : 'none';
    const max = this.track.clientHeight - this.detentH();
    this.knob.style.transform = `translateY(${Math.max(0, Math.min(max, y)).toFixed(1)}px)`;
  }

  private snapToGear(g: Gear): void {
    this.placeKnob(SHIFTER_ORDER.indexOf(g) * this.detentH(), true);
    this.lastGear = g;
  }

  /** HUD 갱신 주기마다 호출: 현재 기어/브레이크 상태 반영 (드래그 중에는 레버 위치를 건드리지 않음) */
  update(): void {
    const c = this.host.context();
    const allow = allowedShifts(c.gear, c.v, c.brake);
    const key = c.gear + (c.brake ? 'b' : '-') + SHIFTER_ORDER.map((g) => (allow[g].ok ? 1 : 0)).join('');
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const [g, el] of this.posEls) {
        el.classList.toggle('cur', g === c.gear);
        el.classList.toggle('dim', g !== c.gear && !allow[g].ok);
      }
      // 브레이크가 필요한 상태(P/N/D/R 에서 다른 방향 기어로 바꾸려는데 브레이크 안 누름)면 잠금 표시
      const needBrake = !c.brake && SHIFTER_ORDER.some((g) => g !== c.gear && allow[g].code === 'brake_required');
      this.lockEl.classList.toggle('on', needBrake);
      this.el.dataset.gear = c.gear;
    }
    if (!this.dragging && this.lastGear !== c.gear) this.snapToGear(c.gear);
    else if (!this.dragging && this.knob.style.transform === '') this.snapToGear(c.gear);
  }

  /** 테스트용: 현재 드래그 중인가 */
  get isDragging(): boolean {
    return this.dragging;
  }
}
