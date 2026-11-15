import type { Action } from '../game/input';
import { SLOTS, TOP_FLOOR, floorLabel, slotIdOf, statusBoard, type MachineState } from '../mech/machine';
import { onTap } from './tap';
import { manualStatus } from '../mech/recovery';

/**
 * 기계식 주차타워 제어반(확대 조작 화면). 평소에는 숨겨져 있고 HUD 의 "제어반" 버튼(또는 Z 키)으로 연다 — 상시 큰 UI 를 두지 않는다.
 * 층(2F~12F)/슬롯(A/B) 선택, 점유/사용 가능 표시, 입고·출고·취소·비상정지/해제, 자동/수동 슬롯 선택, 승강기 위치/셔터/상태 표시.
 * 키보드/버튼은 같은 Action 경로(Game.onAction)를 쓴다.
 */
export class MechControl {
  readonly el: HTMLDivElement;
  private grid: HTMLElement;
  private stat: HTMLElement;
  private selEl: HTMLElement;
  private autoBtn: HTMLButtonElement;
  private manualEl: HTMLElement;
  private mstat: HTMLElement;
  private last = '';
  private open = false;
  private btns = new Map<string, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    private h: { action: (a: Action) => void; select: (slot: string) => void; auto: (v: boolean) => void },
  ) {
    this.el = document.createElement('div');
    this.el.id = 'mech-ctl';
    this.el.className = 'glass hidden';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', '기계식 주차 제어반');
    this.el.innerHTML = `
      <div class="mc-head"><span class="mc-name">기계식 주차 제어반</span><button data-c="close" aria-label="닫기">닫기</button></div>
      <div class="mctl-body">
        <div class="mctl-grid" data-r="grid"></div>
        <div class="mctl-side">
          <div class="mctl-led" data-r="stat"></div>
          <div class="mctl-sel" data-r="sel"></div>
          <button data-a="mechStart" class="go">입고</button>
          <button data-a="mechRetrieve" class="go2">출고</button>
          <button data-a="mechCancel">입고 취소</button>
          <button data-a="mechEstop" class="estop">비상 정지 / 해제</button>
          <button data-c="auto">슬롯 선택: 수동</button>
          <button data-a="mechManual" class="estop">비상 수동복구 진입</button>
        </div>
      </div>
      <div class="mctl-manual hidden" data-r="manual" aria-label="비상 수동복구">
        <div class="mctl-mstat" data-r="mstat"></div>
        <div class="mctl-mgrp"><span>셔터</span><button data-a="mr:doorOpen">열기</button><button data-a="mr:doorClose">닫기</button><button data-a="mr:doorStop">정지</button><button data-a="mr:doorEmergency" class="estop">긴급 개방</button></div>
        <div class="mctl-mgrp"><span>캐리지</span><button data-a="mr:liftUp">상승</button><button data-a="mr:liftDown">하강</button><button data-a="mr:liftStop">정지</button><button data-a="mr:home">1층 복귀</button><button data-a="mr:shiftA">A 이송</button><button data-a="mr:shiftB">B 이송</button><button data-a="mr:center">중앙</button></div>
        <div class="mctl-mgrp"><span>팔레트</span><button data-a="mr:palletFromSlot">슬롯 인출</button><button data-a="mr:palletToSlot">슬롯 안치</button><button data-a="mr:palletSupply">승강장 공급</button><button data-a="mr:palletReturnEmpty">빈 팔레트 회수</button><button data-a="mr:palletSeat">수동 안착</button></div>
        <div class="mctl-mgrp"><span>턴테이블</span><button data-a="mr:turnLeft">좌회전</button><button data-a="mr:turnRight">우회전</button><button data-a="mr:turnStop">정지</button><button data-a="mr:turnHome">초기 방향</button></div>
        <div class="mctl-mgrp"><button data-a="mr:stopAll" class="estop">전체 정지</button><button data-a="mechRecoverDone" class="go">복구 완료</button></div>
      </div>`;
    parent.appendChild(this.el);
    this.grid = this.el.querySelector('[data-r="grid"]')!;
    this.stat = this.el.querySelector('[data-r="stat"]')!;
    this.selEl = this.el.querySelector('[data-r="sel"]')!;
    this.autoBtn = this.el.querySelector('[data-c="auto"]')!;
    this.manualEl = this.el.querySelector('[data-r="manual"]')!;
    this.mstat = this.el.querySelector('[data-r="mstat"]')!;
    this.buildGrid(TOP_FLOOR);
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => onTap(b, () => this.h.action(b.dataset.a as Action)));
    onTap(this.el.querySelector('[data-c="close"]') as HTMLElement, () => this.setOpen(false));
    onTap(this.autoBtn, () => this.h.auto(this.autoBtn.dataset.on !== '1'));
  }

  private gridFloors = 0;
  /** 시설 층수에 맞춰 슬롯 버튼을 다시 만든다 (층수가 같으면 아무것도 하지 않음) */
  buildGrid(floors: number): void {
    if (floors === this.gridFloors) return;
    this.gridFloors = floors;
    this.grid.innerHTML = '';
    this.btns.clear();
    for (let f = floors; f >= 2; f--) {
      const row = document.createElement('div');
      row.className = 'mctl-row';
      row.innerHTML = `<span class="mctl-fl">${floorLabel(f)}</span>`;
      for (const side of ['A', 'B'] as const) {
        const id = slotIdOf(f, side);
        const b = document.createElement('button');
        b.dataset.slot = id;
        b.textContent = side;
        row.appendChild(b);
        this.btns.set(id, b);
        onTap(b, () => this.h.select(id));
      }
      this.grid.appendChild(row);
    }
    this.last = '';
  }

  get isOpen(): boolean {
    return this.open;
  }
  setOpen(v: boolean): void {
    this.open = v;
    this.el.classList.toggle('hidden', !v);
    if (v) this.last = '';
  }
  toggle(): void {
    this.setOpen(!this.open);
  }

  update(m: MachineState, selected: string, auto: boolean, name = ''): void {
    if (!this.open) return;
    this.buildGrid(m.floors);
    const occ = SLOTS.filter((s) => s.id in m.slots).map((s) => (m.slots[s.id] ? '1' : '0')).join('');
    const sb = statusBoard(m);
    // v0.6.1 수동복구: 비상정지·수동복구 중에만 조작부를 보이고 상태(모드/오류 코드/셔터/높이/이송/팔레트/차량/복구 가능)를 표시
    const showManual = m.phase === 'estop' || m.phase === 'manual';
    this.manualEl.classList.toggle('hidden', !showManual);
    const ms = manualStatus(m);
    const occN = Object.values(m.slots).filter(Boolean).length;
    const mtext = showManual
      ? `<b>${ms.mode}</b> · 셔터 ${ms.door}% · 캐리지 ${ms.floor} · 수평 ${ms.shift} · 팔레트 ${ms.pallet} · 탑재 ${ms.car} · 슬롯 점유 ${occN}/${Object.keys(m.slots).length}<br>${m.phase === 'manual' ? (ms.canFinish ? '<b>복구 가능</b>' : `복구 불가: ${ms.issues.map((q) => `${q.code} ${q.text}`).join(' / ')}`) : '비상정지 — "비상 수동복구 진입" 으로 수동 조작'}`
      : '';
    const key = `${name}|${occ}|${selected}|${auto}|${sb.text}|${m.door.toFixed(1)}|${m.carriage.y.toFixed(0)}|${m.message}|${mtext}`;
    if (key === this.last) return;
    this.last = key;
    for (const [id, b] of this.btns) {
      const used = !!m.slots[id];
      b.dataset.used = used ? '1' : '0';
      b.dataset.sel = id === selected ? '1' : '0';
      b.title = used ? `${id} 점유` : `${id} 사용 가능`;
      b.setAttribute('aria-label', `${id} ${used ? '점유' : '사용 가능'}`);
    }
    const nowFloor = Math.round(m.carriage.y / 3) + 1;
    this.stat.dataset.kind = sb.kind;
    this.stat.textContent = sb.text;
    this.selEl.innerHTML = `${name ? `<b>${name}</b><br>` : ''}선택 <b>${selected}</b> (${m.slots[selected] ? '점유' : '사용 가능'}) · 승강기 ${floorLabel(nowFloor)} · 셔터 ${m.door > 0.95 ? '열림' : m.door < 0.05 ? '닫힘' : '동작 중'}<br>${m.message || ''}`;
    this.mstat.innerHTML = mtext;
    this.autoBtn.dataset.on = auto ? '1' : '0';
    this.autoBtn.textContent = `슬롯 선택: ${auto ? '자동(빈 슬롯)' : '수동'}`;
  }
}
