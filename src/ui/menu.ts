import { DEFAULT_SETTINGS, QUALITY_PRESETS, type MissionRecord, type Records, type Settings } from '../core/settings';
import { MAPS, getMap } from '../maps';
import type { MapMission } from '../maps/types';
import type { ScoreResult } from '../mission/parking';
import { VEHICLES } from '../vehicle/spec';
import { PDC_PALETTES } from '../pdc/pdcModel';
import { Minimap } from './minimap';

export interface MenuHost {
  settings(): Settings;
  update(patch: Partial<Settings>): void;
  records(): Records;
  resetRecords(): void;
  avgFps(): number;
  startGame(): void;
  resume(): void;
  restart(): void;
  toMainMenu(): void;
  nextMission(): void;
  hasNextMission(): boolean;
}

export interface ResultInfo {
  success: boolean;
  title: string;
  reason: string;
  score: ScoreResult | null;
  accuracy: number;
  timeSec: number;
  collisions: number;
  isBest: boolean;
}

const KEYS: [string, string][] = [
  ['W / ↑', '가속'],
  ['S / ↓', '브레이크'],
  ['A / ←  D / →', '좌 / 우 조향'],
  ['F', '전진 기어 (D)'],
  ['R', '후진 기어 (R)'],
  ['P', '주차 기어 (P)'],
  ['N', '중립 (N)'],
  ['Space', '주차 브레이크'],
  ['C', '카메라 변경'],
  ['M', '미니맵 (작게/크게/숨김)'],
  ['V', '주차 센서 화면 (작게/크게/숨김)'],
  ['B', '주차 보조 화면 열기/닫기'],
  ['Q / E', '좌 / 우 방향지시등'],
  ['H', '비상등'],
  ['L', '전조등'],
  ['T', '차량 초기화'],
  ['Esc', '일시정지'],
];

const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class Menu {
  private el: HTMLDivElement | null = null;
  constructor(private root: HTMLElement, private host: MenuHost) {}

  private mount(html: string, overlay = false): HTMLDivElement {
    this.close();
    const d = document.createElement('div');
    d.className = 'screen' + (overlay ? ' overlay' : '');
    d.innerHTML = html;
    this.root.appendChild(d);
    this.el = d;
    return d;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }

  get isOpen(): boolean {
    return !!this.el;
  }

  // ---------------- 메인 ----------------
  showMain(): void {
    const s = this.host.settings();
    const map = getMap(s.mapId);
    const mission = map.missions.find((m) => m.id === s.missionId);
    const veh = VEHICLES.find((v) => v.id === s.vehicleId) ?? VEHICLES[1];
    const d = this.mount(`
      <div class="card narrow">
        <h1>3D 주차 시뮬레이터</h1>
        <p class="sub">직접 운전하고, 3D 주차 센서로 주변을 확인하며 주차 미션을 완료하세요.</p>
        <div class="panel" style="padding:10px 12px;font-size:13px;color:var(--muted)">
          맵 <b style="color:var(--text)">${map.name}</b><br>
          미션 <b style="color:var(--text)">${mission ? mission.name : '자유주행'}</b><br>
          차량 <b style="color:var(--text)">${veh.name}</b>
        </div>
        <div class="menu-list">
          <button class="primary" id="m-start">게임 시작</button>
          <button id="m-map">맵 / 미션 선택</button>
          <button id="m-car">차량 선택</button>
          <button id="m-set">설정</button>
          <button id="m-keys">조작법</button>
        </div>
      </div>`);
    d.querySelector('#m-start')!.addEventListener('click', () => this.host.startGame());
    d.querySelector('#m-map')!.addEventListener('click', () => this.showMaps());
    d.querySelector('#m-car')!.addEventListener('click', () => this.showVehicles());
    d.querySelector('#m-set')!.addEventListener('click', () => this.showSettings(() => this.showMain()));
    d.querySelector('#m-keys')!.addEventListener('click', () => this.showControls(() => this.showMain()));
  }

  // ---------------- 맵/미션 ----------------
  showMaps(): void {
    const s = this.host.settings();
    const recs = this.host.records();
    const d = this.mount(`
      <div class="card">
        <div class="row between"><h2>맵 / 미션 선택</h2><button class="ghost" id="back">돌아가기</button></div>
        <div class="grid" id="maps"></div>
        <h3>미션</h3>
        <div id="missions"></div>
        <div class="row" style="margin-top:14px"><button class="primary" id="go">이 설정으로 시작</button></div>
      </div>`);
    const mapsEl = d.querySelector('#maps')!;
    const missEl = d.querySelector('#missions')!;
    const renderMissions = (): void => {
      const cur = this.host.settings();
      const map = getMap(cur.mapId);
      const items: (MapMission | null)[] = [...map.missions, null];
      missEl.innerHTML = '';
      for (const m of items) {
        const id = m ? m.id : 'free';
        const rec: MissionRecord | undefined = recs[`${map.id}/${id}`];
        const b = document.createElement('button');
        b.className = 'mission-item' + (cur.missionId === id ? ' selected' : '');
        b.innerHTML = `<span><b>${m ? m.name : '자유주행'}</b><div class="meta">${m ? m.desc : '미션 없이 자유롭게 주행/주차 연습'}</div></span>
          <span class="meta">${rec ? `<span class="badge clear">최고 ${rec.bestScore}점</span> ${fmtTime(rec.bestTime)}` : m ? '기록 없음' : ''}</span>`;
        b.addEventListener('click', () => {
          this.host.update({ missionId: id });
          renderMissions();
        });
        missEl.appendChild(b);
      }
    };
    for (const map of MAPS) {
      const b = document.createElement('button');
      b.className = 'option' + (s.mapId === map.id ? ' selected' : '');
      const cv = document.createElement('canvas');
      cv.width = 320;
      cv.height = 220;
      b.append(cv);
      b.insertAdjacentHTML('beforeend', `<div class="title">${map.name}</div><div class="desc">${map.desc}</div>`);
      b.addEventListener('click', () => {
        const first = map.missions[0]?.id ?? 'free';
        this.host.update({ mapId: map.id, missionId: first });
        mapsEl.querySelectorAll('.option').forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
        renderMissions();
      });
      mapsEl.appendChild(b);
      const mm = new Minimap(cv);
      mm.setMap(map);
      requestAnimationFrame(() => mm.drawStatic());
    }
    renderMissions();
    d.querySelector('#back')!.addEventListener('click', () => this.showMain());
    d.querySelector('#go')!.addEventListener('click', () => this.host.startGame());
  }

  // ---------------- 차량 ----------------
  showVehicles(): void {
    const s = this.host.settings();
    const d = this.mount(`
      <div class="card">
        <div class="row between"><h2>차량 선택</h2><button class="ghost" id="back">돌아가기</button></div>
        <div class="grid" id="cars"></div>
        <p class="sub" style="margin-top:14px">차량마다 크기·회전반경이 달라 주차 난이도가 변합니다. 차량 모델은 GLB로 교체할 수 있습니다 (docs/CAR_MODEL_GUIDE.md).</p>
      </div>`);
    const grid = d.querySelector('#cars')!;
    for (const v of VEHICLES) {
      const b = document.createElement('button');
      b.className = 'option' + (s.vehicleId === v.id ? ' selected' : '');
      const hex = '#' + v.color.toString(16).padStart(6, '0');
      b.innerHTML = `<div style="height:70px;border-radius:8px;background:linear-gradient(135deg,${hex},#10151c);margin-bottom:8px"></div>
        <div class="title">${v.name}</div><div class="desc">${v.desc}</div>
        <div class="desc" style="margin-top:6px">길이 ${v.length.toFixed(2)}m · 폭 ${v.width.toFixed(2)}m · 높이 ${v.height.toFixed(2)}m<br>최소 회전반경 약 ${(v.wheelbase / Math.tan(v.maxSteer)).toFixed(1)}m</div>`;
      b.addEventListener('click', () => {
        this.host.update({ vehicleId: v.id });
        grid.querySelectorAll('.option').forEach((o) => o.classList.remove('selected'));
        b.classList.add('selected');
      });
      grid.appendChild(b);
    }
    d.querySelector('#back')!.addEventListener('click', () => this.showMain());
  }

  // ---------------- 설정 ----------------
  showSettings(back: () => void): void {
    const render = (): void => {
      const s = this.host.settings();
      const d = this.mount(`
        <div class="card">
          <div class="row between"><h2>설정</h2><button class="ghost" id="back">돌아가기</button></div>
          <h3>그래픽 / 성능</h3>
          ${sel('quality', '그래픽 품질 프리셋', '낮음=모바일 절전, 높음=PC (텍스처/안티앨리어싱은 다음 시작·새로고침 시 적용)', [['low', '낮음'], ['medium', '보통'], ['high', '높음']], s.quality)}
          ${rng('resolutionScale', '렌더링 해상도', '낮추면 FPS가 올라갑니다', 0.4, 1, 0.05, s.resolutionScale)}
          ${sel('shadows', '그림자 품질', '끄면 가장 빠름', [['off', '끔'], ['low', '낮음'], ['medium', '보통'], ['high', '높음']], s.shadows)}
          ${rng('sensorViewFps', '센서 3D 화면 갱신 속도', '차량 화면과 동시 렌더링 부하 조절', 5, 60, 5, s.sensorViewFps)}
          ${chk('showFps', 'FPS 표시', `현재 평균 FPS: <b>${this.host.avgFps().toFixed(0)}</b> (최근 5초)`, s.showFps)}
          <h3>주차 센서</h3>
          ${chk('sensorEnabled', '주차 센서 켜기', '끄면 감지/표시/경고음 모두 중지', s.sensorEnabled)}
          ${chk('sensorSound', '경고음 켜기', '센서와 별도로 켜고 끌 수 있음', s.sensorSound)}
          ${rng('sensorVolume', '경고음 볼륨', '', 0, 1, 0.05, s.sensorVolume)}
          ${rng('sensorRange', '최대 감지 거리', '이 거리 안에서 경고 시작', 1, 4, 0.1, s.sensorRange)}
          ${rng('sensorCritical', '연속 경고 거리', '이 거리 이하에서 연속음', 0.1, 0.8, 0.05, s.sensorCritical)}
          ${chk('sensorDebug', '센서 디버그 모드', '개발자용: 감지 광선·센서 방향·충돌 대상·거리(m) 표시. 일반 화면에는 거리 숫자를 표시하지 않음', s.sensorDebug)}
          <h3>주차 보조 디스플레이</h3>
          ${chk('rearPip', '후진(R) 시 후방카메라 + PDC 자동 표시', '끄면 R 에서도 자동으로 열리지 않음 (우측 사이드/화면의 주차보조 버튼으로 수동 열기)', s.rearPip)}
          ${chk('assistFrontAuto', '전진(D) 선택 시 전방카메라 + 전방 PDC 자동 표시', 'R→D 전환 시 화면 구성은 그대로, 영상만 전방으로 바뀜', s.assistFrontAuto)}
          ${rng('assistFrontMaxKmh', 'D 에서 주차 보조 화면 유지 속도', '이 속도를 넘으면 일반 화면으로 복귀', 3, 30, 1, s.assistFrontMaxKmh)}
          ${rng('assistExitSec', 'P 기어 후 화면 종료 지연', '주차(P) 후 자동으로 닫히기까지', 0, 10, 1, s.assistExitSec)}
          ${chk('assistGuides', '조향 연동 주차 가이드라인', '카메라 영상 위에 예상 경로 표시', s.assistGuides)}
          ${sel('pdcPalette', 'PDC 경고 색상', '', Object.entries(PDC_PALETTES).map(([k, v]) => [k, v.name] as [string, string]), s.pdcPalette)}
          ${rng('assistCameraFps', '주차 보조 카메라 갱신 속도', '낮추면 모바일 부하 감소', 10, 60, 5, s.assistCameraFps)}
          <h3>카메라 / 조작</h3>
          ${chk('rearMirror', '후방 카메라 좌우 반전', '실제 후방카메라처럼 거울상으로 표시', s.rearMirror)}
          ${sel('touchControls', '터치 버튼', '자동=터치 기기에서만 표시', [['auto', '자동'], ['on', '항상 표시'], ['off', '숨김']], s.touchControls)}
          ${rng('touchScale', '터치 버튼 크기', '', 0.7, 1.5, 0.05, s.touchScale)}
          <h3>데이터</h3>
          <div class="row"><button class="danger" id="reset-rec">기록 초기화</button><button id="reset-set">설정 기본값으로</button></div>
        </div>`);
      d.querySelector('#back')!.addEventListener('click', back);
      d.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.k as keyof Settings;
          let v: unknown;
          if (inp instanceof HTMLInputElement && inp.type === 'checkbox') v = inp.checked;
          else if (inp instanceof HTMLInputElement && inp.type === 'range') v = Number(inp.value);
          else v = inp.value;
          const patch: Partial<Settings> = { [k]: v } as Partial<Settings>;
          if (k === 'quality') Object.assign(patch, QUALITY_PRESETS[v as 'low' | 'medium' | 'high']);
          this.host.update(patch);
          if (k === 'quality') render();
          else {
            const out = inp.parentElement?.querySelector('.val');
            if (out && inp instanceof HTMLInputElement && inp.type === 'range') out.textContent = FMT[k as string]?.(Number(inp.value)) ?? inp.value;
          }
        });
      });
      d.querySelector('#reset-rec')!.addEventListener('click', () => {
        if (confirm('저장된 모든 미션 기록을 삭제할까요?')) this.host.resetRecords();
      });
      d.querySelector('#reset-set')!.addEventListener('click', () => {
        this.host.update({ ...DEFAULT_SETTINGS, mapId: s.mapId, missionId: s.missionId, vehicleId: s.vehicleId });
        render();
      });
    };
    render();
  }

  // ---------------- 조작법 ----------------
  showControls(back: () => void): void {
    const d = this.mount(`
      <div class="card">
        <div class="row between"><h2>조작법</h2><button class="ghost" id="back">돌아가기</button></div>
        <h3>키보드</h3>
        <div class="keytable">${KEYS.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
        <h3>마우스 / 터치</h3>
        <div class="keytable">
          <div><kbd>드래그</kbd><span>자유 시점 카메라 회전</span></div>
          <div><kbd>휠</kbd><span>카메라 줌 (자유/탑뷰/추적)</span></div>
          <div><kbd>드래그</kbd><span>센서 화면 회전 (두 손가락 = 확대/축소)</span></div>
          <div><kbd>더블클릭</kbd><span>센서 화면 시점 초기화</span></div>
        </div>
        <h3>주차 요령</h3>
        <p class="sub">기어를 먼저 선택하세요 (F=전진, R=후진). 주행 중에는 반대 방향 기어로 바꿀 수 없습니다. 주차선 안에 차 네 모서리가 모두 들어오고 방향이 맞은 채 1.5초 정지하면 성공입니다. 후진(R) 기어에서는 후방 카메라와 주차 센서가 자동으로 켜집니다.</p>
        <p class="sub">화면 아래 버튼(P/R/N/D, 방향지시등 등)과 모바일 터치 버튼은 키보드와 같은 동작을 합니다.</p>
      </div>`);
    d.querySelector('#back')!.addEventListener('click', back);
  }

  // ---------------- 일시정지 ----------------
  showPause(): void {
    const d = this.mount(
      `
      <div class="card narrow">
        <h2>일시정지</h2>
        <div class="menu-list">
          <button class="primary" id="p-resume">계속하기</button>
          <button id="p-restart">미션 재시작</button>
          <button id="p-set">설정</button>
          <button id="p-keys">조작법</button>
          <button class="danger" id="p-menu">메인 메뉴로</button>
        </div>
      </div>`,
      true,
    );
    d.querySelector('#p-resume')!.addEventListener('click', () => this.host.resume());
    d.querySelector('#p-restart')!.addEventListener('click', () => this.host.restart());
    d.querySelector('#p-set')!.addEventListener('click', () => this.showSettings(() => this.showPause()));
    d.querySelector('#p-keys')!.addEventListener('click', () => this.showControls(() => this.showPause()));
    d.querySelector('#p-menu')!.addEventListener('click', () => this.host.toMainMenu());
  }

  // ---------------- 결과 ----------------
  showResult(r: ResultInfo): void {
    const stars = r.score ? '★'.repeat(r.score.stars) + '☆'.repeat(3 - r.score.stars) : '';
    const d = this.mount(
      `
      <div class="card narrow">
        <h2>${r.success ? '주차 성공' : '미션 실패'}</h2>
        <p class="sub">${r.title}${r.success ? '' : ' — ' + r.reason}</p>
        ${
          r.success && r.score
            ? `<div style="text-align:center;font-size:40px;color:#f2c200;letter-spacing:6px">${stars}</div>
               <div style="text-align:center;font-size:34px;font-weight:800;margin:4px 0 12px">${r.score.total}점 ${r.isBest ? '<span class="badge clear">최고 기록!</span>' : ''}</div>`
            : ''
        }
        <div class="keytable" style="grid-template-columns:1fr 1fr">
          <div>정확도 <b>${r.accuracy}%</b></div>
          <div>소요 시간 <b>${fmtTime(r.timeSec)}</b></div>
          <div>충돌 <b>${r.collisions}회</b></div>
          ${r.score ? `<div>감점 <b>-${r.score.collisionPenalty}</b></div>` : ''}
        </div>
        ${r.score ? `<p class="sub" style="margin-top:10px">기본 200 + 정확도 ${r.score.accuracyPoints} + 시간 ${r.score.timePoints} − 충돌 ${r.score.collisionPenalty}</p>` : ''}
        <div class="menu-list">
          <button class="primary" id="r-retry">다시 시도</button>
          ${r.success && this.host.hasNextMission() ? '<button id="r-next">다음 미션</button>' : ''}
          <button id="r-menu">메인 메뉴</button>
        </div>
      </div>`,
      true,
    );
    d.querySelector('#r-retry')!.addEventListener('click', () => this.host.restart());
    d.querySelector('#r-next')?.addEventListener('click', () => this.host.nextMission());
    d.querySelector('#r-menu')!.addEventListener('click', () => this.host.toMainMenu());
  }
}

// ---- 설정 폼 헬퍼 ----
const FMT: Record<string, (v: number) => string> = {
  resolutionScale: (v) => `${Math.round(v * 100)}%`,
  sensorViewFps: (v) => `${v} FPS`,
  sensorVolume: (v) => `${Math.round(v * 100)}%`,
  sensorRange: (v) => `${v.toFixed(1)} m`,
  sensorCritical: (v) => `${v.toFixed(2)} m`,
  touchScale: (v) => `${Math.round(v * 100)}%`,
  assistFrontMaxKmh: (v) => `${v} km/h`,
  assistExitSec: (v) => `${v}초`,
  assistCameraFps: (v) => `${v} FPS`,
};
function sel(k: string, label: string, hint: string, opts: [string, string][], cur: string): string {
  return `<div class="setting"><div><label>${label}</label>${hint ? `<small>${hint}</small>` : ''}</div>
    <select data-k="${k}">${opts.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('')}</select></div>`;
}
function chk(k: string, label: string, hint: string, cur: boolean): string {
  return `<div class="setting"><div><label>${label}</label>${hint ? `<small>${hint}</small>` : ''}</div>
    <input type="checkbox" data-k="${k}"${cur ? ' checked' : ''}></div>`;
}
function rng(k: string, label: string, hint: string, min: number, max: number, step: number, cur: number): string {
  return `<div class="setting"><div><label>${label}</label>${hint ? `<small>${hint}</small>` : ''}</div>
    <div class="row"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${cur}"><span class="val" style="min-width:56px;text-align:right">${FMT[k](cur)}</span></div></div>`;
}
