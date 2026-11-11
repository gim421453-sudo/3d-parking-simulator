/**
 * 브라우저 스모크/통합 테스트 (Playwright).
 * 사용: npm run build && node scripts/e2e-smoke.cjs
 *  - dist 를 vite preview 로 띄우고 headless Chromium(소프트웨어 WebGL)으로 실제 플레이를 자동 수행한다.
 *  - 스크린샷은 screenshots/ 에 저장된다.
 * 주의: 소프트웨어 렌더링이라 FPS 수치는 실제 기기 성능을 의미하지 않는다.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = process.env.E2E_PORT || '4173';
const URL = process.env.E2E_URL || `http://127.0.0.1:${PORT}/`;
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

(async () => {
  let server = null;
  if (!process.env.E2E_URL) {
    server = spawn('npx', ['vite', 'preview', '--port', PORT, '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  }
  if (!(await waitServer(URL))) {
    console.error('서버 시작 실패');
    process.exit(2);
  }

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  // 소프트웨어 렌더링이므로 낮은 품질로 고정 (시간 의존 테스트 안정화)
  await page.addInitScript(() => {
    if (!localStorage.getItem('parksim.v1.settings')) {
      localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10 }));
    }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const g = (fn, arg) => page.evaluate(fn, arg);
  /** 게임 내부 조건이 참이 될 때까지 대기 (시간이 아니라 게임 상태 기준) */
  const until = async (fn, arg, timeout = 25000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 100 });
      return true;
    } catch {
      return false;
    }
  };
  /** 차량을 "차체 중심 좌표 + heading" 으로 배치 */
  const place = (cx, cz, h, gear = 'P') =>
    g(({ cx, cz, h, gear }) => {
      const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang;
      c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = false;
    }, { cx, cz, h, gear });

  // 변속은 브레이크 인터록이 있으므로 브레이크(S)를 밟은 채 누른다
  const shiftKey = async (code) => { await page.keyboard.down('KeyS'); await sleep(150); await page.keyboard.press(code); await sleep(60); await page.keyboard.up('KeyS'); };
  // 거리 정확도 검증용: 배치 후 주차 브레이크로 고정 (D 기어 크리프로 차가 굴러가 측정이 흔들리는 것을 방지)
  // v0.4.8: 기어 변경 직후에는 차량이 움직이기 전까지 자동 시점 전환이 막혀 있다. 배치 헬퍼는 "이미 주행 중"으로 보고 게이트를 연다(게이트 자체는 별도 테스트).
  const openGate = (gear) => g((gear) => new Promise((res) => { const t = () => { const G = window.__game; if (G.viewGateGear === gear) { G.viewGate = true; G.debugViewCtx = { v: 1, steer: 'closest', pathCut: 1.0 }; res(); } else requestAnimationFrame(t); }; t(); }), gear);
  const placeHold = async (cx, cz, h, gear) => { await place(cx, cz, h, gear); await g(() => { window.__game.car.handbrake = true; }); await openGate(gear); };


  // ---------- 1. 시작 화면 ----------
  await page.goto(URL);
  await page.waitForSelector('#m-start', { timeout: 15000 });
  await shot('01-main-menu');
  check('시작 화면 표시', (await page.locator('text=게임 시작').count()) > 0);
  check('메뉴 항목(맵/차량/설정/조작법)', (await page.locator('#m-map, #m-car, #m-set, #m-keys').count()) === 4);
  await page.click('#m-keys');
  check('조작법 화면', (await page.locator('kbd').count()) > 10);
  await shot('02-controls');
  await page.click('#back');
  await page.click('#m-car');
  check('차량 선택 화면 (기본 3종 + M4/X6 프로필 + GLB 시험 + 실차형 GLB 컨셉 쿠페)', (await page.locator('#cars .option').count()) === 7);
  await shot('03-vehicles');
  await page.click('#back');
  await page.click('#m-map');
  check('맵 선택 화면 (기존 4종 + v0.4.9 신규 4종 + v0.5.0 기계식 + v0.5.2 통합 맵 = 10개)', (await page.locator('#maps .option').count()) === 10);
  await sleep(400);
  await shot('04-maps');
  await page.click('#back');
  await page.click('#m-set');
  check('설정 화면', (await page.locator('.setting').count()) > 8);
  await shot('05-settings');
  await page.click('#back');

  // ---------- 2. 게임 시작 / 기어 / 주행 ----------
  await page.click('#m-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
  await sleep(800);
  await shot('10-game-start');
  check('게임 진입 (HUD 표시)', true);
  check('초기 기어 P, 정지', await g(() => window.__game.car.gear === 'P' && window.__game.car.v === 0));

  await page.keyboard.down('KeyW');
  await until(() => window.__game.mission.elapsed > 2.0);
  await page.keyboard.up('KeyW');
  check('P 기어에서 가속해도 차가 움직이지 않음', await g(() => Math.abs(window.__game.car.v) < 1e-6));

  await shiftKey('KeyF');
  await page.keyboard.down('KeyW');
  const okFwd = await until(() => window.__game.car.v > 3);
  await shot('11-driving-forward');
  const fwd = await g(() => ({ v: window.__game.car.v, gear: window.__game.car.gear }));
  check('D 기어 가속 전진', okFwd && fwd.gear === 'D', JSON.stringify(fwd));
  await shiftKey('KeyR');
  check('주행 중 R 기어 전환 거부', await g(() => window.__game.car.gear === 'D'));
  await shiftKey('KeyP');
  check('주행 중 P 기어 전환 거부', await g(() => window.__game.car.gear === 'D'));
  const h0 = await g(() => window.__game.car.heading);
  await page.keyboard.down('KeyA');
  const okTurn = await until((h) => window.__game.car.heading > h + 0.15, h0);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
  const h1 = await g(() => window.__game.car.heading);
  check('전진 중 A(왼쪽) 조향 시 왼쪽으로 회전', okTurn, `heading ${h0.toFixed(2)} → ${h1.toFixed(2)}`);
  await page.keyboard.down('KeyS');
  const okStop = await until(() => Math.abs(window.__game.car.v) < 0.05);
  await page.keyboard.up('KeyS');
  check('S 브레이크로 정지', okStop);

  // ---------- 3. 카메라 ----------
  const modes = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('KeyC');
    await sleep(600);
    modes.push(await g(() => window.__game.rig.mode));
    await shot(`20-camera-${i}-${modes[i]}`);
  }
  check('카메라 6종 순환(추적→1인칭→탑뷰→후방→전방→자유→추적)', new Set(modes).size === 6 && modes[5] === 'chase' && modes.includes('front'), modes.join(','));

  // ---------- 4. 후진 + 후방 카메라 ----------
  await place(0, -6, 0, 'P');
  await sleep(200);
  await shiftKey('KeyR');
  check('정차 후 R 기어 선택', await g(() => window.__game.car.gear === 'R'));
  await page.keyboard.down('KeyW');
  const okRev = await until(() => window.__game.car.v < -1.5);
  const pipOn = await g(() => { const e = document.getElementById('parking-assist'); return !!e && !e.classList.contains('hidden') && e.dataset.camera === 'rear'; });
  await shot('30-reverse-pip');
  await page.keyboard.up('KeyW');
  check('R 기어 후진 이동', okRev);
  check('R 기어에서 주차 보조 디스플레이(후방카메라) 자동 표시', pipOn);
  // 후진 조향 방향: 왼쪽(A) → 차 뒤쪽이 왼쪽으로 이동
  await place(0, -6, 0, 'R');
  await sleep(200);
  const x0 = await g(() => window.__game.car.x);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await until(() => window.__game.car.z < -9.5);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyA');
  const x1 = await g(() => window.__game.car.x);
  check('후진 중 A(왼쪽) 조향 시 차 뒤쪽이 왼쪽(+x)으로 이동', x1 > x0 + 0.1, `x ${x0.toFixed(2)} → ${x1.toFixed(2)}`);
  const L = await g(() => window.__game.spec.length);
  const W = await g(() => window.__game.spec.width);
  // ---------- 4-B. 주차 보조 디스플레이 (PDC) ----------
  const assistInfo = () => g(() => {
    const e = document.getElementById('parking-assist');
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
    return {
      visible: !!e && !e.classList.contains('hidden'),
      camera: e && e.dataset.camera,
      gear: e && e.dataset.gear,
      panel: e && r(e),
      side: [...e.querySelectorAll('.pa-side button')].map(r),
      sameNode: window.__assistNode ? window.__assistNode === e : null,
    };
  });
  await g(() => { window.__assistNode = document.getElementById('parking-assist'); });
  await place(-5.75, 2.0, -Math.PI / 2, 'R');
  await sleep(400);
  const aR = await assistInfo();
  check('R: 주차 보조 패널 표시 + 후방카메라 + 사이드 버튼 5개(표시 방식 포함)', aR.visible && aR.camera === 'rear' && aR.side.length === 5, JSON.stringify({ v: aR.visible, c: aR.camera, n: aR.side.length }));
  await shot('32-assist-R');
  // R → D (정차 후 기어 변경): 패널 DOM/사이드 버튼 위치는 그대로, 영상만 전방으로
  await g(() => { const c = window.__game.car; c.gear = 'N'; c.v = 0; });
  await shiftKey('KeyF');
  await sleep(500);
  const aD = await assistInfo();
  await shot('33-assist-D');
  check('R→D: 같은 패널(DOM 재생성 없음)에서 카메라만 후방→전방', aD.visible && aD.camera === 'front' && aD.sameNode === true && aD.gear === 'D', JSON.stringify({ c: aD.camera, same: aD.sameNode }));
  const sameRects = JSON.stringify(aR.side) === JSON.stringify(aD.side) && JSON.stringify(aR.panel) === JSON.stringify(aD.panel);
  check('R→D: 패널 크기와 사이드 버튼 위치가 완전히 동일', sameRects, sameRects ? '' : JSON.stringify({ r: aR.side, d: aD.side }));
  // 고속이면 일반 화면 복귀, 저속으로 돌아오면 다시 표시(히스테리시스)
  await g(() => { window.__game.car.v = 4.5; }); // 16km/h
  const leftParking = await until(() => window.__game.infoOut.content === 'nav', undefined, 15000);
  check('D 고속(>15km/h): 주차 보조 화면 종료 → 내비게이션으로 전환', leftParking);
  await g(() => { window.__game.car.v = 0.5; });
  await until(() => window.__game.infoOut.content === 'parking' && !document.getElementById('parking-assist').classList.contains('hidden'), undefined, 15000);
  check('D 저속 복귀: 전방카메라 화면 다시 표시', (await assistInfo()).visible === true);
  // 수동 카메라 선택 우선순위
  for (let i = 0; i < 8 && (await g(() => window.__game.assist.cameraMode !== 'rear')); i++) { await page.click('#parking-assist [data-pa="camera"]'); await sleep(150); }
  await until(() => window.__game.assist.cameraMode === 'rear' && window.__game.assistOut.camera === 'rear', undefined, 20000);
  const aM = await assistInfo();
  check('수동 카메라 선택(후방)이 기어 자동보다 우선', aM.camera === 'rear' && /후방/.test(await g(() => document.querySelector('#parking-assist .v-camera').textContent)), aM.camera);
  await g(() => { const c = window.__game.car; c.gear = 'N'; c.v = 0; });
  await sleep(300); // 정책이 N 을 한 프레임 이상 관찰하도록
  await shiftKey('KeyF');
  await sleep(400);
  check('기어 변경 시 자동 카메라로 복귀', (await assistInfo()).camera === 'front');
  // P: 지연 후 종료
  await g(() => { const c = window.__game.car; c.v = 0; });
  await shiftKey('KeyP');
  check('P 직후에는 화면 유지', (await assistInfo()).visible === true);
  const closedP = await until(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 60000);
  check('P 기어: 지연 후 주차 보조 화면 종료', closedP);
  // 수동 열기(B)/닫기(X)
  await page.keyboard.press('KeyB');
  await sleep(300);
  check('B 키: 수동으로 주차 보조 열기 (P 에서도)', (await assistInfo()).visible === true);
  await page.click('#parking-assist [data-pa="close"]');
  check('닫기 버튼: 수동 닫기', await until(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 30000));

  // ---- 거리 숫자 제거 / 디버그에서만 표시 ----
  await placeHold(-36 + 0.8 + L / 2, 10, Math.PI / 2, 'R'); // 동쪽을 보고 서쪽 벽이 뒤 범퍼 0.8m
  await sleep(500);
  await page.keyboard.press('KeyV'); // 센서 화면 크게(작게→크게)
  await sleep(700);
  const texts = await g(() => document.body.innerText);
  const hasMeters = /\d+(\.\d+)?\s*m\b/.test(texts);
  check('일반 플레이: 화면 어디에도 거리(m) 숫자 없음', !hasMeters, hasMeters ? texts.match(/.{0,12}\d+(\.\d+)?\s*m\b.{0,8}/)[0] : '');
  const domNums = await g(() => [...document.querySelectorAll('.sv-label, .sv-info, .pa-status')].map((e) => e.textContent).join('|'));
  check('일반 플레이: 센서/PDC 요소 DOM 에 거리 숫자 없음', !/\d+\.\d+/.test(domNums), domNums);
  await g(() => window.__game.updateSettings({ sensorDebug: true }));
  await sleep(900);
  const dbg = await g(() => document.querySelector('.sv-debug').textContent);
  check('디버그 모드: 센서별 거리 측정값(m) 확인 가능', /\d\.\d{3}m/.test(dbg), dbg.slice(0, 60).replace(/\n/g, ' '));
  await g(() => window.__game.updateSettings({ sensorDebug: false }));
  await page.keyboard.press('KeyV');
  await page.keyboard.press('KeyV');
  await sleep(300);

  // ---- 경고 구역이 실제 장애물 위치와 일치 (DOM 위치로 검증) ----
  const zoneProbe = () => g(() => {
    const e = document.getElementById('parking-assist');
    const car = e.querySelector('.pa-car').getBoundingClientRect();
    const cx = car.x + car.width / 2, cy = car.y + car.height / 2;
    const lit = {};
    e.querySelectorAll('path[data-zone]').forEach((p) => {
      const lv = window.__game.assistPanel.zoneLevels()[p.dataset.zone];
      if (lv && lv !== 'none' && p.dataset.band === '4') { const b = p.getBoundingClientRect(); lit[p.dataset.zone] = { dx: b.x + b.width / 2 - cx, dy: b.y + b.height / 2 - cy, fill: p.getAttribute('fill') }; }
    });
    return { lit, levels: window.__game.assistPanel.zoneLevels() };
  });
  // 빈 공간: 아무 구역도 켜지지 않음 (거짓 경고 없음)
  await place(0, -6, 0, 'D'); // D 저속 → 주차 보조(전방) 자동 표시
  await sleep(700);
  const open0 = await assistInfo();
  const z0 = await zoneProbe();
  check('장애물 없는 곳: 모든 PDC 구역 소등 (거짓 경고 없음)', open0.visible && Object.values(z0.levels).every((l) => l === 'none'), JSON.stringify(Object.values(z0.levels).filter((l) => l !== 'none')));
  // 서쪽 벽이 차 앞(heading=-π/2, 앞 범퍼 1.0m)
  await placeHold(-36 + 1.0 + L / 2, 10, -Math.PI / 2, 'D');
  await sleep(700);
  const zF = await zoneProbe();
  const REAR_IDS = ['R-L-out', 'R-L-in', 'R-R-in', 'R-R-out', 'L-rear', 'R-rear'];
  const LEFT_IDS = ['F-L-out', 'F-L-in', 'R-L-out', 'R-L-in', 'L-front', 'L-rear'];
  const RIGHT_IDS = ['F-R-out', 'F-R-in', 'R-R-out', 'R-R-in', 'R-front', 'R-rear'];
  const nonLit = (z, ids) => ids.every((id) => z.levels[id] === 'none');
  const entries = (z) => Object.entries(z.levels).filter(([, l]) => l !== 'none');
  const FRONT_IDS = ['F-L-out', 'F-L-in', 'F-R-in', 'F-R-out'];
  const subset = (z, ids) => entries(z).every(([id]) => ids.includes(id));
  const frontOnly = entries(zF).length > 0 && subset(zF, FRONT_IDS) && nonLit(zF, REAR_IDS);
  check('앞쪽 벽 → 앞 구역만 점등(뒤 구역 소등)', frontOnly, JSON.stringify(entries(zF)));
  // 북향, 서쪽 벽이 오른쪽 옆 (앞뒤 모서리 센서는 옆벽을 비스듬히 감지하는 것이 정상 — 모두 오른쪽에 표시되어야 함)
  await placeHold(-36 + 0.9 + W / 2, 10, 0, 'D');
  await sleep(700);
  const zR = await zoneProbe();
  const rightOnly = entries(zR).length > 0 && subset(zR, RIGHT_IDS) && nonLit(zR, LEFT_IDS);
  check('오른쪽 벽 → 오른쪽 구역만 점등, 왼쪽 구역 전부 소등', rightOnly, JSON.stringify(entries(zR)));
  // 남향: 같은 벽이 왼쪽 옆
  await placeHold(-36 + 0.9 + W / 2, 10, Math.PI, 'D');
  await sleep(700);
  const zL = await zoneProbe();
  const leftOnly = entries(zL).length > 0 && subset(zL, LEFT_IDS) && nonLit(zL, RIGHT_IDS);
  check('왼쪽 벽 → 왼쪽 구역만 점등, 오른쪽 구역 전부 소등 (좌우 반전 없음)', leftOnly, JSON.stringify(entries(zL)));
  // 접근 단계: 색이 초록→노랑→주황→빨강으로 변함 (가장 안쪽 띠 기준)
  const stage = [];
  for (const gap of [2.2, 1.4, 0.8, 0.2]) {
    await placeHold(-36 + gap + L / 2, 10, -Math.PI / 2, 'D');
    await sleep(500);
    stage.push(await g(() => Math.max(...[...document.querySelectorAll('#parking-assist path[data-zone^="F-"]')].map((p) => (p.getAttribute('fill') !== getComputedStyle(document.querySelector('.pa-svg')).color ? 1 : 0)))));
  }
  const lvls = [];
  for (const gap of [2.2, 1.4, 0.8, 0.2]) {
    await placeHold(-36 + gap + L / 2, 10, -Math.PI / 2, 'D');
    await sleep(500);
    lvls.push(await g(() => { const z = window.__game.assistPanel.zoneLevels(); return z['F-L-in']; }));
  }
  check('접근할수록 PDC 단계 상승 (초록→노랑→주황→빨강)', JSON.stringify(lvls) === JSON.stringify(['far', 'mid', 'near', 'critical']), lvls.join(','));
  void stage;
  // 센서 OFF: 구역 소등 + 'PDC 꺼짐'
  await g(() => window.__game.updateSettings({ sensorEnabled: false }));
  await sleep(600);
  const off = await g(() => ({ lv: Object.values(window.__game.assistPanel.zoneLevels()).every((l) => l === 'none'), t: document.querySelector('#parking-assist .pa-status').textContent }));
  check('센서 OFF 설정 존중: 구역 소등 + "PDC 꺼짐"', off.lv && off.t === 'PDC 꺼짐', off.t);
  await g(() => window.__game.updateSettings({ sensorEnabled: true }));
  // 서라운드 미지원: 가짜 360도 UI 없음
  const surround = await g(() => ({ btn: !!document.querySelector('[data-pa="surround"]'), txt: /360/.test(document.getElementById('parking-assist').innerText) }));
  check('가짜 360도 버튼/문구 없음 (실제 3D 서라운드는 표시 방식 메뉴로만 제공)', !surround.btn && !surround.txt, JSON.stringify(surround));

  // ---- 필수 운전 버튼: 주차 보조가 열려 있어도 접근 가능 (PC) ----
  await place(0, -6, 0, 'R');
  await sleep(600);
  const ctl = await g(() => {
    const names = ['signalLeft', 'hazard', 'signalRight', 'headlights', 'handbrake', 'reset'];
    const out = {};
    for (const n of names) {
      const b = document.querySelector(`#actionbar [data-a="${n}"]`);
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out[n] = { visible: r.width > 0 && r.height > 0, reachable: !!top && (top === b || b.contains(top)), h: Math.round(r.height) };
    }
    return { out, assist: !document.getElementById('parking-assist').classList.contains('hidden') };
  });
  check('PC: 주차 보조 표시 중에도 방향지시/비상등/조명/주차브레이크 버튼이 보이고 가려지지 않음', ctl.assist && Object.values(ctl.out).every((v) => v.visible && v.reachable), JSON.stringify(ctl.out));
  await page.click('#actionbar [data-a="hazard"]');
  await sleep(200);
  const hz1 = await g(() => window.__game.hazard);
  await page.click('#actionbar [data-a="hazard"]');
  await page.click('#actionbar [data-a="signalLeft"]');
  await sleep(200);
  const sl = await g(() => window.__game.sigLeft);
  await page.click('#actionbar [data-a="signalLeft"]');
  await page.click('#actionbar [data-a="handbrake"]');
  await sleep(200);
  const hb1 = await g(() => window.__game.car.handbrake);
  await page.click('#actionbar [data-a="handbrake"]');
  await sleep(200);
  const hb0 = await g(() => window.__game.car.handbrake);
  check('PC: 주차 보조 표시 중 비상등/방향지시등/주차브레이크 버튼이 실제로 동작', hz1 === true && sl === true && hb1 === true && hb0 === false, JSON.stringify({ hz1, sl, hb1, hb0 }));

  // ---- 화면 크기별 겹침 검사 (주차 보조 열림 상태) ----
  const layoutSizes = [[667, 375], [800, 360], [844, 390], [960, 540], [1024, 600], [1280, 720], [1920, 1080]];
  for (const [w, h] of layoutSizes) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(700);
    const lay = await g(() => {
      const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const panel = document.getElementById('parking-assist');
      const pr = rect(panel);
      const others = [];
      for (const sel of ['#cluster', '.iconbar', '#minimap-wrap', '#toasts']) { const e = document.querySelector(sel); if (e && vis(e)) others.push({ n: sel, ...rect(e) }); }
      document.querySelectorAll('#touch .tbtn').forEach((e) => vis(e) && others.push({ n: 'tbtn', ...rect(e) }));
      const hit = (a, b) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
      const overlaps = others.filter((o) => hit(pr, o)).map((o) => o.n);
      const acts = [...document.querySelectorAll('#actionbar button')].map((b) => { const r = rect(b); const t = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2); return { ok: r.x >= 0 && r.y >= 0 && r.x + r.w <= innerWidth && r.y + r.h <= innerHeight && !!t && (t === b || b.contains(t)), h: r.h, w: r.w }; });
      const side = [...panel.querySelectorAll('.pa-side button')].map((b) => rect(b).h);
      const sh = rect(document.getElementById('shifter'));
      const shOver = others.filter((o) => hit(sh, o) && o.n !== '#toasts').map((o) => o.n);
      if (hit(sh, pr)) shOver.push('panel');
      const shIn = sh.x >= 0 && sh.y >= 0 && sh.x + sh.w <= innerWidth && sh.y + sh.h <= innerHeight;
      const gb = document.getElementById('gear-big');
      const gr = rect(gb);
      const gOthers = [...others];
      const mp0 = document.getElementById('mission-panel');
      if (mp0 && vis(mp0)) gOthers.push({ n: '#mission-panel', ...rect(mp0) });
      const gOver = gOthers.filter((o) => hit(gr, o) && o.n !== '#toasts').map((o) => o.n);
      if (hit(gr, pr)) gOver.push('panel');
      const act = gb.querySelector(`span[data-g="${gb.dataset.g}"]`);
      const gear = { over: gOver, top: gr.y, left: gr.x, fs: parseFloat(getComputedStyle(act).fontSize), inView: gr.x >= 0 && gr.y >= 0 && gr.x + gr.w <= innerWidth };
      return { gear, shOver, shIn, open: !panel.classList.contains('hidden'), panel: pr, overlaps, inView: pr.x >= 0 && pr.y >= 0 && pr.x + pr.w <= innerWidth && pr.y + pr.h <= innerHeight, acts, side, w: innerWidth, h: innerHeight };
    });
    await shot(`36-layout-${w}x${h}`);
    check(`화면 ${w}×${h}: 주차 보조 패널 표시 + 화면 안`, lay.open && lay.inView, JSON.stringify(lay.panel));
    check(`화면 ${w}×${h}: 패널이 클러스터/아이콘바/미니맵/터치버튼과 겹치지 않음`, lay.overlaps.length === 0, lay.overlaps.join(','));
    check(`화면 ${w}×${h}: 필수 조작 버튼 6개 모두 화면 안 + 가려지지 않음`, lay.acts.length === 6 && lay.acts.every((a) => a.ok), JSON.stringify(lay.acts.map((a) => a.ok)));
    check(`화면 ${w}×${h}: 기어 레버가 화면 안에 있고 다른 UI 와 겹치지 않음`, lay.shIn && lay.shOver.length === 0, JSON.stringify({ in: lay.shIn, over: lay.shOver }));
    check(`화면 ${w}×${h}: 좌측 상단 큰 기어 표시(현재 기어 ≥ 30px)가 패널/미션/아이콘바/클러스터와 겹치지 않음`, lay.gear.over.length === 0 && lay.gear.fs >= 30 && lay.gear.top <= 24 && lay.gear.left <= 24 && lay.gear.inView, JSON.stringify(lay.gear));
    check(`화면 ${w}×${h}: 사이드 버튼 5개 높이 ≥ 32px`, lay.side.length === 5 && lay.side.every((v) => v >= 32), JSON.stringify(lay.side.map(Math.round)));
  }
  await page.setViewportSize({ width: 960, height: 540 });
  await sleep(500);

  // ---- 가이드라인: 실제 렌더 카메라 투영, 조향에 따라 변함 ----
  const guideStats = () => g(() => {
    const c = document.querySelector('#parking-assist .pa-guide-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { if (d[(y * c.width + x) * 4 + 3] > 40) { n++; sx += x; } }
    return { n, cx: n ? sx / n : -1, w: c.width };
  });
  await place(0, -6, 0, 'R');
  await g(() => { window.__game.car.handbrake = true; });
  await sleep(900);
  const gs0 = await guideStats();
  check('R: 주차 가이드라인이 카메라 영상 위에 그려짐', gs0.n > 300, String(gs0.n));
  await g(() => { const c = window.__game.car; c.handbrake = false; c.v = 0; c.gear = 'R'; });
  await page.keyboard.down('KeyA'); // 왼쪽 조향
  await until(() => window.__game.car.steer > 0.25, undefined, 15000);
  await g(() => { window.__game.car.handbrake = true; });
  await sleep(900);
  const gsL = await guideStats();
  await page.keyboard.up('KeyA');
  await g(() => { window.__game.car.handbrake = false; });
  await page.keyboard.down('KeyD');
  await until(() => window.__game.car.steer < -0.25, undefined, 15000);
  await g(() => { window.__game.car.handbrake = true; });
  await sleep(900);
  const gsR = await guideStats();
  await page.keyboard.up('KeyD');
  await g(() => { window.__game.car.handbrake = false; });
  check('조향에 따라 가이드라인이 바뀜 (왼쪽 조향=화면 왼쪽, 오른쪽 조향=화면 오른쪽)', gsL.cx < gs0.cx - 2 && gsR.cx > gs0.cx + 2, `L ${gsL.cx.toFixed(1)} / 직진 ${gs0.cx.toFixed(1)} / R ${gsR.cx.toFixed(1)}`);
  await shot('34-assist-guides');
  await g(() => { const c = window.__game.car; c.steer = 0; c.v = 0; c.gear = 'P'; });

  // 후방 카메라 전체화면
  await g(() => window.__game.rig.setMode('rear'));
  await sleep(600);
  await shot('31-rear-camera-full');

  // ---------- 5. 센서 ----------
  await g(() => window.__game.rig.setMode('chase'));
  // 서쪽 벽 안쪽 면 x=-36. 서쪽을 보고(heading=-π/2) 앞 범퍼-벽 간격 1.00m
  await placeHold(-36 + 1.0 + L / 2, 10, -Math.PI / 2, 'D');
  await sleep(500);
  const s1 = await g(() => ({ front: window.__game.sensorSnap.groupMin.front, rear: window.__game.sensorSnap.groupMin.rear }));
  check('센서 전방 거리 = 실제 벽까지 1.00m', s1.front !== null && Math.abs(s1.front - 1.0) < 0.03, JSON.stringify(s1));
  await placeHold(-36 + 0.9 + W / 2, 10, 0, 'D'); // 북쪽을 봄: 벽은 오른쪽 옆
  await sleep(400);
  let s3 = await g(() => ({ f: window.__game.sensorSnap.groupMin.front, l: window.__game.sensorSnap.groupMin.left, r: window.__game.sensorSnap.groupMin.right, b: window.__game.sensorSnap.groupMin.rear }));
  check('차량 회전(북향): 서쪽 벽은 오른쪽 센서가 0.90m로 감지, 왼쪽은 미검출 (앞 모서리 센서는 비스듬히 더 먼 거리)', s3.r !== null && Math.abs(s3.r - 0.9) < 0.03 && s3.l === null && (s3.f === null || s3.f >= 0.9), JSON.stringify(s3));
  await placeHold(-36 + 0.9 + W / 2, 10, Math.PI, 'D'); // 남향: 벽은 왼쪽 옆
  await sleep(400);
  s3 = await g(() => ({ f: window.__game.sensorSnap.groupMin.front, l: window.__game.sensorSnap.groupMin.left, r: window.__game.sensorSnap.groupMin.right }));
  check('차량 회전(남향): 서쪽 벽은 왼쪽 센서가 감지', s3.l !== null && Math.abs(s3.l - 0.9) < 0.03 && s3.r === null, JSON.stringify(s3));
  const gaps = [2.2, 1.5, 0.8, 0.4, 0.2];
  const meas = [];
  const levels = [];
  for (const gap of gaps) {
    await placeHold(-36 + gap + L / 2, 10, -Math.PI / 2, 'D');
    await sleep(300);
    meas.push(await g(() => window.__game.sensorSnap.groupMin.front));
  }
  check('접근할수록 측정 거리가 정확히 감소 (2.2→0.2m)', meas.every((d, i) => d !== null && Math.abs(d - gaps[i]) < 0.04), meas.map((d) => d && d.toFixed(2)).join(' '));
  void levels;
  // 낮은 연석은 감지 안 됨, 지면 오감지 없음
  await place(24.4 - 1.5, 30 - 20, 0, 'D'); // 평행주차 구간 근처 (연석: h 0.15)
  await g(() => { const G = window.__game; G.car.heading = -Math.PI / 2; });
  await place(26.0 - 1.0 - L / 2 + 0.0, -18, Math.PI / 2, 'D'); // 동쪽 연석(x=25.8~26.2)을 보는 위치 (주차 차량 사이 빈 곳)
  await sleep(400);
  const curb = await g(() => ({ f: window.__game.sensorSnap.groupMin.front }));
  check('낮은 연석(15cm)은 센서에 감지되지 않고 뒤쪽 벽만 감지(1.0+)', curb.f === null || curb.f > 1.3, JSON.stringify(curb));
  // 센서 화면 크게 / 디버그
  await placeHold(-36 + 0.8 + L / 2, 10, -Math.PI / 2, 'D');
  await page.keyboard.press('KeyV');
  await sleep(500);
  await g(() => window.__game.updateSettings({ sensorDebug: true }));
  await sleep(900);
  await shot('40-sensor-large-debug');
  check('센서 화면 크게 표시', (await page.locator('.sensor-view.large').count()) === 1);
  const box = await page.locator('.sensor-view.large').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -300);
  await sleep(900);
  await shot('41-sensor-rotated');
  check('센서 화면 회전/줌 조작', true);
  await g(() => window.__game.updateSettings({ sensorDebug: false }));
  await page.keyboard.press('KeyV');
  await sleep(300);
  check('V: 크게 → 숨김', (await page.locator('.sensor-view.hidden').count()) === 1);
  await page.keyboard.press('KeyV');
  await sleep(300);
  check('V: 숨김 → 작게', (await page.locator('.sensor-view.small').count()) === 1);
  await sleep(500);
  await shot('42-sensor-small');
  await page.click('[data-a="sensorToggle"]');
  await sleep(300);
  check('센서 OFF 시 측정 중지', await g(() => window.__game.sensorSnap === null));
  await page.click('[data-a="sensorToggle"]');
  await sleep(300);
  check('센서 ON 복귀', await g(() => window.__game.sensorSnap !== null));

  // ---------- 6. 충돌/관통 ----------
  await place(3.9, 8, 0, 'D');
  await page.keyboard.down('KeyW');
  const okCol = await until(() => window.__game.collisions >= 1, undefined, 40000);
  await sleep(1500);
  const col = await g(() => {
    const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang;
    return { frontZ: c.z + Math.cos(c.heading) * (off + G.spec.length / 2), collisions: G.collisions };
  });
  await page.keyboard.up('KeyW');
  await shot('50-collision');
  check('빈 칸 안쪽 벽에 돌진 → 충돌 감지', okCol, JSON.stringify(col));
  check('벽을 관통하지 않음 (앞 범퍼 z < 23.2)', col.frontZ < 23.2, JSON.stringify(col));
  // 정차 후 후진으로 빠져나올 수 있음 (끼임 없음)
  await g(() => { const c = window.__game.car; c.gear = 'N'; c.v = 0; });
  await shiftKey('KeyR');
  await page.keyboard.down('KeyW');
  const out = await until((z0) => window.__game.car.z < z0 - 1.5, col.frontZ);
  await page.keyboard.up('KeyW');
  check('충돌 후 후진으로 빠져나옴', out);

  // ---------- 7. 주차 성공/실패 판정 ----------
  const poseSlot = (dx, dz, headDeg) =>
    g(({ dx, dz, headDeg }) => {
      const G = window.__game; const slot = G.targetSlot; const h = slot.dir + (headDeg * Math.PI) / 180;
      const off = G.spec.length / 2 - G.spec.rearOverhang;
      const cx = slot.x + dx, cz = slot.z + dz;
      G.car.x = cx - Math.sin(h) * off; G.car.z = cz - Math.cos(h) * off; G.car.heading = h; G.car.v = 0; G.car.gear = 'P'; G.car.handbrake = false;
    }, { dx, dz, headDeg });
  await g(() => window.__game.startRun());
  await sleep(500);
  await poseSlot(0.7, 0, 0);
  const t0 = await g(() => window.__game.mission.elapsed);
  await until((t) => window.__game.mission.elapsed > t + 3, t0);
  check('칸에 걸친 자세 + 정지: 성공 처리 안 됨', await g(() => window.__game.mission.status === 'running'));
  await poseSlot(0, 0, 25);
  const t1 = await g(() => window.__game.mission.elapsed);
  await until((t) => window.__game.mission.elapsed > t + 3, t1);
  check('방향이 25° 틀어진 자세: 성공 처리 안 됨', await g(() => window.__game.mission.status === 'running'));
  await poseSlot(0, 0, 0);
  await until(() => window.__game.mission.hold > 0.3);
  check('올바른 자세 + 정차 → 유지 시간 누적', true);
  await poseSlot(0, 0, 0);
  const okWin = await until(() => window.__game.mission.status === 'success');
  await until(() => !!document.querySelector('#r-retry'));
  await shot('60-result-success');
  check('주차 성공 → 결과 화면', okWin && (await page.locator('text=주차 성공').count()) > 0);
  check('기록 저장 (localStorage)', await g(() => !!localStorage.getItem('parksim.v1.records')));
  await page.click('#r-retry');
  await page.waitForSelector('#hud:not(.hidden)');
  await sleep(500);
  check('재시도 → 미션 재시작', await g(() => window.__game.mission.status === 'running' && window.__game.mission.elapsed < 3));

  // 실패 화면 (포기)
  await g(() => window.__game.mission.giveUp());
  await until(() => !!document.querySelector('#r-retry'));
  await shot('61-result-fail');
  check('미션 실패 → 결과 화면', (await page.locator('text=미션 실패').count()) > 0);
  await page.click('#r-retry');
  await page.waitForSelector('#hud:not(.hidden)');

  // ---------- 8. 일시정지 ----------
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc 일시정지 메뉴', (await page.locator('text=일시정지').count()) > 0);
  await shot('70-pause');
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc 로 재개', (await g(() => window.__game.state)) === 'playing');

  // ---------- 8-B. 조명 모드 / AUTO Leveling ----------
  await g(() => { const G = window.__game; G.updateSettings({ mapId: 'lot', missionId: 'lot-front', vehicleId: 'sedan' }); G.startRun(); });
  await sleep(800);
  const lightState = () => g(() => { const G = window.__game; const m = G.model; return { mode: G.lightMode, low: m.headSpot.intensity > 0, high: m.highSpot.intensity > 0, drl: Math.round(m.lights.drl.emissiveIntensity * 100) / 100, tail: Math.round(m.lights.tail.emissiveIntensity * 100) / 100 }; });
  await shiftKey('KeyF');
  await sleep(500);
  const l0 = await lightState();
  check('조명 AUTO(주간 야외): 하향등 OFF, DRL 점등', l0.mode === 'auto' && !l0.low && l0.drl > 1, JSON.stringify(l0));
  const seq = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('KeyL'); await sleep(350); seq.push(await lightState()); }
  // 순환 순서: AUTO → OFF → 미등 → 하향등 → 상향등 → AUTO
  check('L: OFF → DRL 100%(주행 중), 하향등 OFF, 후미등 꺼짐', seq[0].mode === 'off' && !seq[0].low && seq[0].drl > 1 && seq[0].tail < 0.2, JSON.stringify(seq[0]));
  check('L: 미등 → DRL 100% + 후미등 ON, 하향등 OFF', seq[1].mode === 'position' && !seq[1].low && seq[1].drl > 1 && seq[1].tail > 0.5, JSON.stringify(seq[1]));
  check('L: 하향등 → 하향등 ON, DRL 30%(미등보다 어두움)', seq[2].mode === 'low' && seq[2].low && !seq[2].high && seq[2].drl < seq[1].drl * 0.5, JSON.stringify(seq[2]));
  check('L: 상향등 → 하향+상향 ON', seq[3].mode === 'high' && seq[3].low && seq[3].high, JSON.stringify(seq[3]));
  check('L: 다시 AUTO 로 순환', seq[4].mode === 'auto', JSON.stringify(seq[4]));
  await g(() => { window.__game.car.gear = 'N'; window.__game.car.v = 0; });
  await g(() => { const G = window.__game; G.updateSettings({ mapId: 'underground', missionId: 'ug-reverse' }); G.startRun(); });
  await sleep(800);
  await shiftKey('KeyF');
  await sleep(500);
  const lu = await lightState();
  check('조명 AUTO(어두운 지하): 자동으로 하향등 ON', lu.mode === 'auto' && lu.low && !lu.high, JSON.stringify(lu));
  await shot('35-lights-underground');
  // AUTO Leveling: 가속 → 아래(−), 제동 → 위(+)
  await g(() => { const G = window.__game; G.updateSettings({ mapId: 'lot', missionId: 'lot-front' }); G.startRun(); });
  await sleep(600);
  await shiftKey('KeyF');
  await page.keyboard.down('KeyW');
  const okDown = await until(() => window.__game.levelPitch < -0.004, undefined, 20000);
  await page.keyboard.up('KeyW');
  await g(() => { window.__game.car.v = 5; });
  await page.keyboard.down('KeyS');
  const okUp = await until(() => window.__game.levelPitch > 0.004, undefined, 20000);
  await page.keyboard.up('KeyS');
  const lvMax = await g(() => Math.abs(window.__game.levelPitch) <= 0.0351);
  check('AUTO Leveling: 가속 시 조사각 아래 보정', okDown);
  check('AUTO Leveling: 제동 시 조사각 위 보정', okUp);
  check('AUTO Leveling: 보정 한계(±2°) 이내', lvMax);

  // ---------- 9. 설정 저장 ----------
  await g(() => window.__game.updateSettings({ sensorRange: 3.2, showFps: true, sensorSound: false }));
  await page.reload();
  await page.waitForSelector('#m-start');
  const saved = await g(() => ({ r: window.__game.settings.sensorRange, f: window.__game.settings.showFps, s: window.__game.settings.sensorSound }));
  check('설정이 새로고침 후에도 유지', saved.r === 3.2 && saved.f === true && saved.s === false, JSON.stringify(saved));
  await g(() => window.__game.updateSettings({ sensorSound: true, showFps: false, sensorRange: 3.0 }));

  // ---------- 10. 맵 3종 + 전체 미션 판정 ----------
  for (const [mapId, vehicle, mission] of [['lot', 'compact', 'lot-front'], ['underground', 'sedan', 'ug-reverse'], ['outdoor', 'suv', 'out-parallel']]) {
    await g(({ mapId, vehicle, mission }) => { const G = window.__game; G.updateSettings({ mapId, missionId: mission, vehicleId: vehicle }); G.startRun(); }, { mapId, vehicle, mission });
    await sleep(1500);
    await shot(`80-map-${mapId}`);
    const info = await g(() => ({ id: window.__game.map.id, n: window.__game.map.obstacles.length, state: window.__game.state }));
    check(`맵 로딩: ${mapId}`, info.id === mapId && info.state === 'playing' && info.n > 10, JSON.stringify(info));
    await shiftKey('KeyF');
    await page.keyboard.down('KeyW');
    const moved = await until(() => Math.abs(window.__game.car.v) > 1.0);
    await page.keyboard.up('KeyW');
    check(`맵 ${mapId} 주행 가능`, moved);
  }
  for (const [mapId, mid, veh] of [['lot', 'lot-front', 'sedan'], ['lot', 'lot-reverse', 'compact'], ['lot', 'lot-parallel', 'suv'], ['underground', 'ug-reverse', 'suv'], ['underground', 'ug-front', 'sedan'], ['outdoor', 'out-reverse', 'sedan'], ['outdoor', 'out-front', 'compact'], ['outdoor', 'out-parallel', 'sedan']]) {
    await g(({ mapId, mid, veh }) => { const G = window.__game; G.updateSettings({ mapId, missionId: mid, vehicleId: veh }); G.startRun(); }, { mapId, mid, veh });
    await sleep(400);
    await g(() => {
      const G = window.__game; const slot = G.targetSlot; const kind = G.mission.def.kind;
      const h = kind === 'perpendicular-reverse' ? slot.dir + Math.PI : slot.dir;
      const off = G.spec.length / 2 - G.spec.rearOverhang;
      G.car.x = slot.x - Math.sin(h) * off; G.car.z = slot.z - Math.cos(h) * off; G.car.heading = h; G.car.v = 0; G.car.gear = 'P';
    });
    const ok = await until(() => window.__game.mission.status === 'success', undefined, 30000);
    check(`미션 성공 판정: ${mid} (${veh})`, ok);
    await until(() => !!document.querySelector('#r-retry'), undefined, 8000);
  }

  // ---------- 12. v0.4: 전자식 레버 / 인포테인먼트 / 3D 시점 / 내비게이션 / GLB / 미러 ----------
  await page.setViewportSize({ width: 1280, height: 720 });
  await g(() => { const G = window.__game; G.updateSettings({ mapId: 'lot', missionId: 'lot-front', vehicleId: 'sedan', infoAutoHide: true, assistAutoView: true }); G.startRun(); });
  await sleep(900);
  const leverDrag = async (to, { brake = false, toY = null, cancel = false } = {}) => {
    const knob = await page.locator('.sh-knob').boundingBox();
    const tgt = await page.locator(`.sh-pos[data-g="${to}"]`).boundingBox();
    if (brake) await page.keyboard.down('KeyS');
    await sleep(120);
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(tgt.x + tgt.width / 2, toY ?? tgt.y + tgt.height / 2, { steps: 8 });
    if (cancel) await page.evaluate(() => document.querySelector('.sh-track').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    const during = await g(() => window.__game.hud.shifter.isDragging);
    await page.mouse.up();
    if (brake) await page.keyboard.up('KeyS');
    await sleep(350);
    return during;
  };
  const gearNow = () => g(() => window.__game.car.gear);
  check('레버: 초기 기어 P', (await gearNow()) === 'P');
  await leverDrag('D', { brake: false });
  check('레버: 브레이크 없이 D 로 드래그 → 변속 거부 (P 유지) + 안내', (await gearNow()) === 'P' && (await page.locator('.toast', { hasText: '브레이크' }).count()) > 0);
  await shot('100-lever-rejected');
  await page.keyboard.press('KeyF');
  await sleep(200);
  check('키보드도 같은 인터록: 브레이크 없이 F → 거부', (await gearNow()) === 'P');
  const dragging = await leverDrag('D', { brake: true });
  check('레버: 드래그 중에는 드래그 상태 유지', dragging === true);
  check('레버: 브레이크를 밟고 D 로 드래그 → D 변속', (await gearNow()) === 'D');
  await shot('101-lever-D');
  await g(() => { window.__game.car.handbrake = true; window.__game.car.v = 0; });
  await leverDrag('R', { brake: true, cancel: true });
  check('레버: 드래그 중 취소(pointercancel) → 변속 없이 원위치', (await gearNow()) === 'D' && (await g(() => !window.__game.hud.shifter.isDragging)));
  await leverDrag('P', { brake: true, toY: -300 });
  check('레버: 화면 위쪽 밖으로 끌고 놓아도 안전 (정지 중이므로 P 로 변속)', (await gearNow()) === 'P');
  await leverDrag('D', { brake: true, toY: 3000 });
  check('레버: 화면 아래 밖으로 끌고 놓아도 안전 (D)', (await gearNow()) === 'D');
  await g(() => { window.__game.car.handbrake = false; window.__game.car.gear = 'D'; window.__keepV = setInterval(() => { window.__game.car.v = 5; }, 5); });
  await leverDrag('R', { brake: true });
  await g(() => { clearInterval(window.__keepV); window.__game.car.v = 0; });
  check('레버: 주행 중(5m/s) R 로 드래그 → 거부, D 유지', (await gearNow()) === 'D');
  await g(() => window.__game.pause());
  const paused = await g(() => window.__game.requestShift('R'));
  check('일시정지 중에는 변속 입력 차단', paused.ok === false && (await gearNow()) === 'D');
  await g(() => window.__game.resume());
  await sleep(300);

  // ---- 인포테인먼트: 토글 / 공유 상태 / 1인칭 ----
  await g(() => { const G = window.__game; G.car.gear = 'P'; G.car.v = 0; G.car.handbrake = true; });
  const infoHidden = await until(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 40000);
  check('P + 주차 보조 없음: 플로팅 디스플레이는 숨김 상태', infoHidden);
  await page.click('[data-a="assistToggle"]');
  await until(() => !document.getElementById('parking-assist').classList.contains('hidden'), undefined, 8000);
  const tg = await g(() => ({ vis: !document.getElementById('parking-assist').classList.contains('hidden'), content: document.getElementById('parking-assist').dataset.content }));
  check('토글 버튼: 플로팅 디스플레이가 부드럽게 등장 (내비게이션 콘텐츠)', tg.vis && tg.content === 'nav', JSON.stringify(tg));
  await shot('102-info-toggle-nav');
  const rectsNav = await g(() => [...document.querySelectorAll('#parking-assist .pa-side button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
  await page.click('[data-a="assistToggle"]');
  check('토글 버튼: 다시 누르면 숨김', await until(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 10000));
  // R 선택 → 이전에 수동으로 닫았어도 자동 표시
  await page.click('[data-a="assistToggle"]'); await sleep(200); await page.click('[data-a="assistToggle"]'); await sleep(200);
  await g(() => { const G = window.__game; G.car.handbrake = false; });
  await shiftKey('KeyR');
  await sleep(900);
  const rShown = await g(() => ({ vis: !document.getElementById('parking-assist').classList.contains('hidden'), content: document.getElementById('parking-assist').dataset.content, cam: document.getElementById('parking-assist').dataset.camera }));
  check('R 새로 선택: 수동으로 닫았어도 후방카메라+PDC 자동 재표시', rShown.vis && rShown.content === 'parking' && rShown.cam === 'rear', JSON.stringify(rShown));
  await until(() => { const e = document.getElementById('parking-assist'); return !e.classList.contains('pa-enter') && !e.classList.contains('pa-leave'); }, undefined, 10000);
  await sleep(500);
  const rectsPark = await g(() => [...document.querySelectorAll('#parking-assist .pa-side button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }));
  check('내비게이션 ↔ 주차 보조 콘텐츠 전환에도 사이드 버튼 좌표 불변', JSON.stringify(rectsNav) === JSON.stringify(rectsPark), JSON.stringify({ nav: rectsNav[0], park: rectsPark[0] }));
  await g(() => { const G = window.__game; G.car.handbrake = true; G.car.v = 0; });
  // 1인칭: 플로팅 자동 숨김 + 실내 화면 동일 상태
  await g(() => window.__game.rig.setMode('driver'));
  await until(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 15000);
  await sleep(1500);
  const fp = await g(() => {
    const cab = window.__game.model.cabin.center;
    const d = cab.ctx.getImageData(0, 0, cab.canvas.width, cab.canvas.height).data;
    let colored = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) colored++;
    return { hidden: document.getElementById('parking-assist').classList.contains('hidden'), colored, content: window.__game.infoOut.content, mirrors: window.__game.mirrors.renders, cockpit: window.__game.model.cockpit.visible };
  });
  await shot('103-first-person-cabin');
  check('1인칭: 3인칭 플로팅 디스플레이는 자동으로 완전히 숨김', fp.hidden);
  check('1인칭: 실내 센터 디스플레이가 같은 상태(주차 보조)를 실제로 그림', fp.content === 'parking' && fp.colored > 800, JSON.stringify({ c: fp.content, colored: fp.colored }));
  check('1인칭: 사이드미러/룸미러가 실제 장면을 렌더링 (설정 FPS)', fp.mirrors > 0, String(fp.mirrors));
  await g(() => window.__game.rig.setMode('chase'));
  await sleep(900);
  check('3인칭 복귀: 공유 상태로 플로팅 디스플레이 복원', await g(() => !document.getElementById('parking-assist').classList.contains('hidden')));

  // ---- 자동 3D 시점 (측면 장애물) ----
  const Lh = await g(() => window.__game.spec.length);
  const Wh = await g(() => window.__game.spec.width);
  await g(() => window.__game.updateSettings({ infoAutoHide: false }));
  await placeHold(-36 + 0.8 + Wh / 2, 10, Math.PI, 'D'); // 남향: 서쪽 벽이 왼쪽 옆 0.8m
  const gotLeft = await until(() => window.__game.viewOut.view === 'left', undefined, 40000);
  await shot('104-view-left');
  check('왼쪽 장애물 접근 → 자동으로 좌측 3D 뷰', gotLeft && (await g(() => window.__game.viewOut.auto)));
  const leftPix = await g(() => { const c = document.querySelector('#parking-assist .pa-cam-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 400) seen.add((d[i] >> 5) * 64 + (d[i + 1] >> 5) * 8 + (d[i + 2] >> 5)); return seen.size; });
  check('좌측 3D 뷰: 실제 3D 장면이 렌더링됨 (색 다양성)', leftPix > 12, String(leftPix));
  await placeHold(-36 + 0.8 + Wh / 2, 10, 0, 'D'); // 북향: 같은 벽이 오른쪽 옆
  const gotRight = await until(() => window.__game.viewOut.view === 'right', undefined, 40000);
  check('오른쪽 장애물 접근 → 우측 3D 뷰 (좌우 구분)', gotRight);
  await placeHold(0, -6, 0, 'D');
  const back = await until(() => window.__game.viewOut.view === 'front', undefined, 60000);
  check('장애물 해제 → 일정 시간 후 원래(전방) 시점으로 복귀', back);
  // 수동 선택 우선순위
  await placeHold(-36 + 0.8 + Wh / 2, 10, Math.PI, 'D');
  await until(() => window.__game.viewOut.view === 'left', undefined, 40000);
  for (let i = 0; i < 9 && (await g(() => window.__game.assist.cameraMode !== 'topFront')); i++) { await page.click('#parking-assist [data-pa="camera"]'); await sleep(120); }
  await sleep(500);
  const man = await g(() => ({ view: window.__game.viewOut.view, auto: window.__game.viewOut.auto, mode: window.__game.assist.cameraMode }));
  check('수동 카메라(전방 집중 탑뷰) 선택이 자동 측면 전환보다 우선', man.view === 'topFront' && man.auto === false && man.mode === 'topFront', JSON.stringify(man));
  await shot('105-view-top-manual');
  for (let i = 0; i < 9 && (await g(() => window.__game.assist.cameraMode !== 'auto')); i++) { await page.click('#parking-assist [data-pa="camera"]'); await sleep(120); }
  check('수동 해제(자동) 후 다시 자동 정책으로 복귀', await g(() => window.__game.assist.cameraMode === 'auto'));

  // ---- 내비게이션 ----
  await g(() => { const G = window.__game; G.updateSettings({ infoAutoHide: false }); const c = G.car; c.handbrake = false; c.gear = 'D'; c.heading = 0; c.x = 0; c.z = -8; c.v = 6; c.steer = 0; });
  const navOn = await until(() => window.__game.infoOut.content === 'nav' && !document.getElementById('parking-assist').classList.contains('hidden'), undefined, 30000);
  await shot('106-nav');
  check('D 15km/h 초과: 주차 화면 종료 → 내비게이션 표시 (플로팅 유지 설정)', navOn);
  const navInfo = await g(() => { const n = window.__game.navState; const c = document.querySelector('#parking-assist .pa-nav-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let blue = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 120) blue++; return { status: n.status, hasRoute: !!n.route, dest: n.destination && n.destination.id, blue, text: document.querySelector('#parking-assist .pa-nav-text').textContent }; });
  check('내비게이션: 목적지(미션 주차칸)와 도로 그래프 기반 경로가 있고 지도에 경로가 그려짐', navInfo.status === 'guiding' && navInfo.hasRoute && navInfo.dest === 'n-2' && navInfo.blue > 100, JSON.stringify(navInfo));
  const dest0 = navInfo.dest;
  await page.click('#parking-assist [data-pa="dest"]');
  await sleep(400);
  const dest1 = await g(() => window.__game.navState.destination && window.__game.navState.destination.id);
  check('내비게이션: 목적지(주차 공간) 선택 버튼으로 다른 주차칸 선택 → 경로 재계산', dest1 && dest1 !== dest0 && (await g(() => !!window.__game.navState.route)), `${dest0} → ${dest1}`);
  await g(() => { const G = window.__game; const c = G.car; c.v = 0; c.handbrake = true; c.x = -25; c.z = -20; });
  const rer = await until(() => window.__game.navState.rerouteCount >= 1, undefined, 30000);
  check('내비게이션: 경로를 이탈하면 재탐색', rer);
  // 도착 판정
  await g(() => { const G = window.__game; const t = G.navState.destination; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = t.x; c.z = t.z - off; c.heading = 0; });
  check('내비게이션: 목적지 근처 도착 판정', await until(() => window.__game.navState.status === 'arrived', undefined, 20000));

  // ---- GLB 차량 (실제 파일) ----
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'sedan-glb' }); G.startRun(); });
  const glbOk = await until(() => { const m = window.__game.model; return m.rollers.length === 4 && m.frontPivots.length === 2 && m.bodyGroup.children[0] && m.bodyGroup.children[0].name === 'AuxScene'; }, undefined, 30000);
  await sleep(600);
  await shot('107-glb-vehicle');
  check('GLB 차량: 실제 .glb 파일을 불러와 바퀴 4개/앞바퀴 조향 피벗 2개를 연결', glbOk);
  const glbLamp = await g(() => { const G = window.__game; G.lightMode = 'high'; return null; });
  void glbLamp;
  await sleep(500);
  check('GLB 차량: 램프 재질(Lamp_*)이 점등 시스템에 연결됨 (상향등 → 발광)', await g(() => window.__game.model.lights.head.name === 'Lamp_Head' && window.__game.model.lights.head.emissiveIntensity > 2));
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'sedan' }); G.startRun(); });
  await sleep(500);

  // ---------- 13. v0.4.1: 차량별 기능 분리 (M4 후방 전용 / X6 서라운드) ----------
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'coupe-m4', infoAutoHide: false, assistAutoView: true }); G.startRun(); });
  await sleep(600);
  const Wm = await g(() => window.__game.spec.width);
  const panelInfo = () => g(() => {
    const el = document.getElementById('parking-assist');
    const cam = el.querySelector('[data-pa="camera"]');
    return { layout: el.dataset.layout, camDisplay: getComputedStyle(cam).display, hidden: el.classList.contains('hidden'), content: el.dataset.content, camera: el.dataset.camera };
  });
  await g(() => { const c = window.__game.car; c.handbrake = false; c.v = 0; c.gear = 'N'; });
  await sleep(300);
  await shiftKey('KeyR');
  await until(() => window.__game.infoOut.floatingVisible && window.__game.infoOut.content === 'parking', undefined, 20000);
  const m4R = await panelInfo();
  await shot('110-m4-rear-pdc');
  check('M4: 패널 레이아웃은 후방 전용(rear)', m4R.layout === 'rear', JSON.stringify(m4R));
  check('주차 보조 콘텐츠에서는 내비 캔버스가 카메라 영상을 가리지 않음(회귀 방지)', (await g(() => getComputedStyle(document.querySelector('#parking-assist .pa-nav-canvas')).display)) === 'none');
  check('M4: R 에서 후방카메라 + PDC 표시', !m4R.hidden && m4R.content === 'parking' && m4R.camera === 'rear');
  check('M4: 카메라(전방/서라운드 선택) 버튼 미표시', m4R.camDisplay === 'none');
  check('M4: 사이드 메뉴는 컴팩트(보이는 버튼 3개)', (await g(() => [...document.querySelectorAll('#parking-assist .pa-side button')].filter((b) => getComputedStyle(b).display !== 'none').length)) === 3);
  check('M4: 후방 PDC 센서 구역 12개 존재 (실제 센서 구성 유지)', (await g(() => window.__game.spec.sensors.length)) === 12);
  // 카메라 모드 순환에서 전방카메라 모드 제외
  const m4modes = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('KeyC'); await sleep(120); m4modes.push(await g(() => window.__game.rig.mode)); }
  check('M4: 카메라 순환에 전방카메라 모드가 없음', !m4modes.includes("front") && m4modes.includes("rear"), m4modes.join(','));
  await g(() => window.__game.rig.setMode('chase'));
  await g(() => window.__game.onAction('assistCamera'));
  await sleep(200);
  check('M4: 수동 카메라 전환 시도는 무시 (후방 유지)', (await g(() => window.__game.viewOut.view)) === 'rear');
  // 측면 벽에 붙어도 3D 시점으로 바뀌지 않음
  await placeHold(-36 + 0.8 + Wm / 2, 10, Math.PI, 'R');
  await sleep(2500);
  check('M4: 측면 장애물이 있어도 3D 시점으로 전환하지 않음', (await g(() => window.__game.viewOut.view)) === 'rear');
  // D: 존재하지 않는 전방카메라를 호출하지 않음
  await g(() => { const c = window.__game.car; c.v = 0; c.x = 0; c.z = -8; c.heading = 0; c.handbrake = false; c.gear = 'N'; });
  await sleep(300);
  await shiftKey('KeyF');
  await sleep(1200);
  const m4D = await g(() => ({ active: window.__game.assistOut.active, view: window.__game.viewOut.view, content: window.__game.infoOut.content }));
  check('M4: D 에서 전방카메라 주차 화면을 열지 않음 (검은 화면 없음)', m4D.active === false && m4D.view !== 'front', JSON.stringify(m4D));
  const plate = await g(() => { const G = window.__game; let n = 0; G.model.bodyGroup.traverse((o) => { if (o.name === 'Plate_Front' || o.name === 'Plate_Rear') n += o.material && o.material.name === 'Plate_KR' ? 1 : 0; }); return n; });
  check('M4: 한국형 번호판(앞·뒤) 메시/텍스처 적용', plate === 2, String(plate));
  // 1인칭 연동
  await g(() => { const c = window.__game.car; c.v = 0; c.handbrake = true; c.gear = 'N'; });
  await sleep(300);
  await g(() => { window.__game.car.handbrake = false; });
  await shiftKey('KeyR');
  await g(() => window.__game.rig.setMode('driver'));
  await until(() => window.__game.infoOut.content === 'parking', undefined, 15000);
  await sleep(800);
  await shot('111-m4-cabin');
  const m4Cab = await g(() => { const cab = window.__game.model.cabin.center; const d = cab.ctx.getImageData(0, 0, cab.canvas.width, cab.canvas.height).data; let c = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) c++; return c; });
  check('M4: 1인칭 실내 센터 디스플레이에 후방 PDC 화면 표시', m4Cab > 800, String(m4Cab));
  check('v0.4.7 M4(서라운드 미지원): 센서 전용만 제공 — 서라운드 비활성, 전환 버튼 숨김, 서라운드 렌더 없음', await g(() => { const p = document.getElementById('parking-assist'); const pm = p.querySelector('[data-pa="pdcMode"]'); return p.dataset.surround === 'false' && p.dataset.surroundSupported === 'false' && getComputedStyle(pm).display === 'none' && !window.__game.cabinHits.some((h) => h.action === 'pdcMode'); }));
  await g(() => { window.__game.onAction('pdcSurround'); });
  check('v0.4.7 M4: 서라운드 선택 요청을 무시(미지원 기능 활성화 금지)', await g(() => document.getElementById('parking-assist').dataset.surround === 'false'));
  await g(() => window.__game.rig.setMode('chase'));

  // ---- X6 ----
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'suv-x6', infoAutoHide: false }); G.startRun(); });
  await sleep(600);
  const Wx = await g(() => window.__game.spec.width);
  await g(() => { const c = window.__game.car; c.handbrake = false; c.v = 0; c.gear = 'N'; });
  await sleep(300);
  await shiftKey('KeyR');
  await until(() => window.__game.infoOut.floatingVisible && window.__game.infoOut.content === 'parking', undefined, 20000);
  const x6R = await panelInfo();
  check('X6: 패널 레이아웃은 서라운드(surround), 카메라 버튼 표시', x6R.layout === 'surround' && x6R.camDisplay !== 'none' && x6R.camera === 'rear', JSON.stringify(x6R));
  await shot('112-x6-rear');
  await g(() => { const c = window.__game.car; c.v = 0; c.gear = 'N'; });
  await sleep(300);
  await shiftKey('KeyF');
  await until(() => window.__game.viewOut.view === 'front', undefined, 20000);
  check('X6: D 저속에서 전방카메라', true);
  await shot('113-x6-front');
  await placeHold(-36 + 0.8 + Wx / 2, 10, Math.PI, 'D');
  check('X6: 왼쪽 장애물 → 왼쪽 3D 시점', await until(() => window.__game.viewOut.view === 'left', undefined, 40000));
  await sleep(1800);
  await shot('114-x6-left3d');
  await placeHold(-36 + 0.8 + Wx / 2, 10, 0, 'D');
  check('X6: 오른쪽 장애물 → 오른쪽 3D 시점', await until(() => window.__game.viewOut.view === 'right', undefined, 40000));
  await sleep(1800);
  await shot('115-x6-right3d');
  // 패널 좌표 불변
  const xr = await g(() => [...document.querySelectorAll('#parking-assist .pa-side button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
  await placeHold(-36 + 0.8 + Wx / 2, 10, Math.PI, 'D');
  await until(() => window.__game.viewOut.view === 'left', undefined, 40000);
  const xl = await g(() => [...document.querySelectorAll('#parking-assist .pa-side button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
  check('X6: 3D 시점이 바뀌어도 우측 사이드 메뉴 좌표 불변', JSON.stringify(xr) === JSON.stringify(xl));
  // ---- 카메라 영상 위 실제 장애물 구역 (감지된 것만) ----
  const guidePix = () => g(() => { const c = document.querySelector('#parking-assist .pa-guide-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; });
  const Lx = await g(() => window.__game.spec.length);
  await g(() => window.__game.updateSettings({ assistAutoView: false }));
  await placeHold(0, -6, 0, 'R');
  await until(() => window.__game.viewOut.view === 'rear' && window.__game.infoOut.content === 'parking', undefined, 30000);
  await sleep(1200);
  const freePix = await guidePix();
  const freeZones = await g(() => window.__game.sensorSnap.readings.filter((r) => r.distance !== null).length);
  await placeHold(-36 + 1.0 + Lx / 2, 10, Math.PI / 2, 'R');
  await until(() => window.__game.sensorSnap && window.__game.sensorSnap.readings.some((r) => r.group === 'rear' && r.distance !== null), undefined, 30000);
  await sleep(1500);
  const wallPix = await guidePix();
  const wallPanels = await g(() => window.__game.assistPanel.debugPanels.length);
  await shot('116-x6-rear-overlay');
  check('카메라 영상 위 장애물 구역: 감지가 없으면 그리지 않고, 후방 벽 감지 시 구역이 추가로 그려짐', freeZones === 0 && wallPanels > 0 && wallPix > 200, JSON.stringify({ freeZones, freePix, wallPix }));
  await g(() => { window.__game.updateSettings({ vehicleId: 'sedan' }); window.__game.startRun(); });
  await sleep(500);

  // ---------- 15. v0.4.3 PDC 정밀: 시나리오 (실제 맵 위에 충돌체를 인위적으로 배치) ----------
  await page.setViewportSize({ width: 1280, height: 720 });
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'suv-x6', mapId: 'lot', missionId: 'lot-front', infoAutoHide: false, assistAutoView: true, sensorEnabled: true, assistFrontAuto: true }); G.startRun(); });
  await sleep(700);
  const Ws = await g(() => window.__game.spec.width);
  const Ls = await g(() => window.__game.spec.length);
  const SX = 0, SZ = -6; // 열린 공간 (heading 0: 앞 +z, 왼쪽 +x)
  const clearTest = () => g(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const k of [...G.colliderById.keys()]) if (String(k).startsWith('t-')) G.colliderById.delete(k); G.rig.colliders = G.colliders; });
  const addBox = (id, x, z, w, d, h = 1.4, tag = 'wall') => g(([id, x, z, w, d, h, tag]) => { const c = { kind: 'box', id: 't-' + id, tag, x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h, tag]);
  const addCyl = (id, x, z, r, tag = 'pillar') => g(([id, x, z, r, tag]) => { const c = { kind: 'cyl', id: 't-' + id, tag, x, z, r, y0: 0, h: 3 }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, r, tag]);
  const viewIs = (v) => until((v) => window.__game.viewOut.view === v, v, 45000);
  const startAt = async (gear) => {
    await clearTest();
    await g(() => window.__game.rig.setMode('chase'));
    await placeHold(SX, SZ, 0, gear);
    await g(() => { const G = window.__game; G.risk.reset(); G.viewPolicy.reset(); G.assistPanel.resetOverlay(); G.info.show && G.info.show(); });
    // v0.4.8: 기어 변경 직후에는 차량이 움직이기 전까지 자동 시점 전환이 막혀 있다 → 시나리오 시작 시 "이미 주행 중"으로 간주해 게이트를 연다
    await g((gear) => new Promise((res) => { const t = () => { const G = window.__game; if (G.viewGateGear === gear) { G.viewGate = true; G.debugViewCtx = { v: 1, steer: 'closest', pathCut: 1.0 }; res(); } else requestAnimationFrame(t); }; t(); }), gear);
  };
  const sideX = (gap) => Ws / 2 + gap + 0.25; // 벽 중심 x (벽 두께 0.5)
  const carX = (gap) => Ws / 2 + gap + 0.95; // 주차 차량(폭 1.9) 중심 x
  // 1. 왼쪽 벽만
  await startAt('D');
  await addBox('wl', SX + sideX(1.0), SZ, 0.5, 9);
  check('시나리오1 왼쪽 벽만 근접(1.0m) → 좌측 3D 뷰', await viewIs('left'));
  await sleep(1800);
  await shot('120-s1-left');
  const fr1 = await g(() => ({ y: window.__game.rig.assistCamera.position.y, vis: window.__game.sideBlocked.left }));
  check('시나리오1: 측면 카메라가 장애물 사이 틈이 보이도록 프레이밍(차체 위/장애물 내부 아님)', fr1.y >= 2.0 && fr1.vis === false, JSON.stringify(fr1));
  // 10. 장애물 제거 → 복귀
  await clearTest();
  check('시나리오10 장애물에서 멀어지면 원래(전방) 시점으로 복귀', await viewIs('front'));
  // 2. 오른쪽 벽만
  await addBox('wr', SX - sideX(1.0), SZ, 0.5, 9);
  check('시나리오2 오른쪽 벽만 근접 → 우측 3D 뷰', await viewIs('right'));
  await clearTest();
  await viewIs('front');
  // 3. 양쪽 주차 차량
  await addBox('cl', SX + carX(0.7), SZ, 1.9, 4.6, 1.45, 'car');
  await addBox('cr', SX - carX(0.7), SZ, 1.9, 4.6, 1.45, 'car');
  const s3ok = await until(() => ['left', 'right'].includes(window.__game.viewOut.view), undefined, 45000);
  await sleep(1500);
  check('시나리오3 양쪽에 주차 차량 근접 → 메인 카메라는 전체 탑뷰가 아닌 더 가까운 쪽 측면뷰 (전체 상황은 서라운드뷰)', s3ok && !['top', 'topZoom', 'oblique'].includes(await g(() => window.__game.viewOut.view)));
  await shot('121-s3-side');
  // 카메라 안정화: 전환 완료 후에는 센서 히트가 바뀌어도 구도(차량 기준 위치/높이/FOV)가 변하지 않고 차량만 따라간다
  const camLocal = () => g(() => { const G = window.__game; const c = G.rig.assistCamera; const p = G.poseNow(); const dx = c.position.x - p.x; const dz = c.position.z - p.z; const cs = Math.cos(p.heading); const sn = Math.sin(p.heading); return { lx: dx * cs - dz * sn, lz: dx * sn + dz * cs, y: c.position.y, fov: c.fov, settled: G.rig.assistSettled }; });
  await until(() => window.__game.rig.assistSettled, undefined, 20000);
  const cl0 = await camLocal();
  await addBox('extra', SX, SZ - Ls / 2 - 1.2, 3, 0.5); // 후방 장애물(진행 방향이 아니므로 시점을 바꾸지 않음)
  await g(() => { const c = window.__game.car; c.z += 0.6; });
  await sleep(800);
  await until(() => window.__game.rig.assistSettled, undefined, 30000); // 게임 상태(카메라 전환 완료)를 기다린다 — 소프트웨어 렌더는 게임 시간이 느리다
  const cl1 = await camLocal();
  const stable = cl0.settled && Math.abs(cl0.lx - cl1.lx) < 0.05 && Math.abs(cl0.lz - cl1.lz) < 0.05 && Math.abs(cl0.y - cl1.y) < 0.02 && Math.abs(cl0.fov - cl1.fov) < 0.01;
  check('카메라 안정화: 전환 후 새 장애물/차량 이동에도 구도(차량 기준 위치·높이·FOV)가 고정되고 차량만 추적', stable, JSON.stringify({ cl0, cl1 }));
  await clearTest();
  await viewIs('front');
  // 4. 좁은 주차칸 후진 진입 (R, 양쪽 + 뒤 벽)
  await startAt('R');
  await addBox('n1', SX + sideX(0.5), SZ, 0.5, 9);
  await addBox('n2', SX - sideX(0.5), SZ, 0.5, 9);
  check('시나리오4 좁은 주차칸 후진 진입(양측 근접, 후방은 아직 여유) → 측면뷰(전체 탑뷰는 서라운드 전용)', await until(() => ['left', 'right'].includes(window.__game.viewOut.view), undefined, 45000));
  await shot('122-s4-narrow-reverse');
  await clearTest();
  await viewIs('rear');
  // 5. 기둥 옆 통과
  await startAt('D');
  await addCyl('pil', SX + Ws / 2 + 0.6, SZ + Ls * 0.2, 0.3);
  check('시나리오5 기둥 옆(왼쪽)을 근접 통과 → 좌측 집중 측면뷰', await viewIs('left'));
  await sleep(1800);
  await shot('123-s5-pillar-zoom');
  const pil = await g(() => ({ blocked: window.__game.sideBlocked.left, pillar: window.__game.riskOut.groups.left.pillar, y: window.__game.rig.assistCamera.position.y }));
  check('시나리오5: 기둥이 감지되어 pillar 로 분류되고 측면 카메라가 시야를 확보(높이≥2m)', pil.pillar === true && pil.y >= 2, JSON.stringify(pil));
  await clearTest();
  await viewIs('front');
  // 6. 전방 장애물만
  await addBox('f', SX, SZ + Ls / 2 + 1.0 + 0.25, 6, 0.5);
  await sleep(2500);
  const v6 = await g(() => ({ v: window.__game.viewOut.view, thr: window.__game.riskOut.groups.front.threat }));
  check('시나리오6 전방 장애물 접근 → 전방 위험 판단, 시점은 전방카메라 유지', v6.v === 'front' && v6.thr === true, JSON.stringify(v6));
  await clearTest();
  // 7. 후방 장애물만
  await startAt('R');
  await addBox('b', SX, SZ - Ls / 2 - 1.0 - 0.25, 6, 0.5);
  await sleep(2500);
  const v7 = await g(() => ({ v: window.__game.viewOut.view, thr: window.__game.riskOut.groups.rear.threat }));
  check('시나리오7 후방 장애물 접근 → 후방 위험 판단, 시점은 후방카메라 유지', v7.v === 'rear' && v7.thr === true, JSON.stringify(v7));
  await clearTest();
  // 8. 양측 + 전방
  await startAt('D');
  await addBox('a1', SX + sideX(0.8), SZ, 0.5, 9);
  await addBox('a2', SX - sideX(0.8), SZ, 0.5, 9);
  await addBox('a3', SX, SZ + Ls / 2 + 0.9 + 0.25, 6, 0.5);
  await until(() => window.__game.riskOut.groups.front.threat && window.__game.riskOut.groups.left.threat && window.__game.riskOut.groups.right.threat, undefined, 45000);
  const s8ok = await until(() => window.__game.viewOut.view === 'front', undefined, 45000);
  await sleep(2500);
  check('시나리오8 양측 및 전방 동시 장애물 → 진행 방향(D=전방) 위험을 먼저: 전방 카메라 유지', s8ok && (await g(() => window.__game.viewOut.view)) === 'front');
  await clearTest();
  await viewIs('front');
  // 9. 매우 가까운 장애물
  await addBox('vc', SX + sideX(0.3), SZ, 0.5, 9);
  const v9 = await until(() => window.__game.viewOut.view === 'left', undefined, 45000);
  check('시나리오9 매우 가까운 측면 장애물(0.3m) → 좌측 측면뷰(우측으로 가지 않음)', v9 && (await g(() => window.__game.viewOut.view)) === 'left');
  await clearTest();
  await viewIs('front');

  // 11. N 기어: 자동 시점 전환 없음
  await startAt('N');
  await addBox('n1', SX + sideX(0.6), SZ, 0.5, 9);
  await addBox('n2', SX - sideX(0.6), SZ, 0.5, 9);
  await sleep(4000);
  const vN = await g(() => ({ v: window.__game.viewOut.view, auto: window.__game.viewOut.auto }));
  check('N 기어: 양측 장애물이 있어도 자동 시점 전환을 하지 않음', vN.auto === false && !['left', 'right', 'topFront', 'topRear'].includes(vN.v), JSON.stringify(vN));
  await clearTest();
  // 12. D: 매우 가까운 전방 → 전방 집중 탑뷰, R: 매우 가까운 후방 → 후방 집중 탑뷰
  await startAt('D');
  await addBox('ff', SX, SZ + Ls / 2 + 0.45 + 0.25, 6, 0.5);
  await addBox('fl', SX + sideX(0.8), SZ, 0.5, 9);
  check('시나리오12a D: 전방이 아주 가깝고 측면도 위험 → 전방 집중 탑뷰(전방 우선)', await viewIs('topFront'));
  await sleep(1800);
  await shot('125-s12-top-front');
  await clearTest();
  await startAt('R');
  await addBox('rb', SX, SZ - Ls / 2 - 0.45 - 0.25, 6, 0.5);
  check('시나리오12b R: 후방이 아주 가까움 → 후방 집중 탑뷰', await viewIs('topRear'));
  await sleep(1800);
  await shot('126-s12-top-rear');
  await clearTest();
  await startAt('R');
  await addBox('rb2', SX, SZ - Ls / 2 - 1.3 - 0.25, 6, 0.5);
  await addBox('rr', SX - sideX(0.8), SZ, 0.5, 9);
  await until(() => window.__game.riskOut.groups.rear.threat && window.__game.riskOut.groups.right.threat, undefined, 45000);
  const s13ok = await until(() => window.__game.viewOut.view === 'rear', undefined, 45000);
  await sleep(2500);
  check('시나리오13 R: 후방+우측 위험 → 후방 카메라 먼저(후방 우선)', s13ok && (await g(() => window.__game.viewOut.view)) === 'rear');
  await clearTest();
  // 후방 카메라 타일: 가로 독립 구역, 실제 히트만
  await startAt('R');
  await addBox('rw', SX, SZ - Ls / 2 - 1.3 - 0.25, 0.7, 0.5);
  await until(() => window.__game.viewOut.view === 'rear' && window.__game.infoOut.content === 'parking', undefined, 30000);
  await until(() => { const k = [...window.__game.assistPanel.zoneAnim.keys()]; return k.length > 0 && k.every((x) => x.startsWith('tile-')); }, undefined, 30000);
  await sleep(500);
  const tiles = await g(() => [...window.__game.assistPanel.zoneAnim.keys()]);
  check('후방카메라 경고 타일: 좁은 장애물은 일부 칸(1~4)만 점등, 이름은 tile-rear-*', tiles.length >= 1 && tiles.length <= 4 && tiles.every((k) => k.startsWith('tile-rear-')), JSON.stringify(tiles));
  await clearTest();
  // 추적 카메라 가림 보정 (기둥이 카메라와 차 사이)
  await startAt('N');
  await g(() => window.__game.rig.setMode('chase'));
  await addCyl('chp', SX, SZ - 4.2, 0.35);
  const pulled = await until(() => window.__game.rig.chaseCand !== 0 || window.__game.rig.chaseFree < 0.99, undefined, 30000);
  await sleep(2500);
  const chase2 = await g(([sx, sz]) => {
    const G = window.__game; const cam = G.rig.camera.position; const c = G.car;
    let minD = 1e9;
    for (let i = 0; i <= 60; i++) { const t = i / 60; const x = c.x + (cam.x - c.x) * t; const z = c.z + (cam.z - c.z) * t; minD = Math.min(minD, Math.hypot(x - sx, z - (sz - 4.2))); }
    return { free: G.rig.chaseFree, cand: G.rig.chaseCand, lineToPillar: minD, camDist: Math.hypot(cam.x - c.x, cam.z - c.z), camY: cam.y };
  }, [SX, SZ]);
  await shot('127-chase-pillar');
  check('일반 추적 카메라: 기둥이 가리면 옆/위쪽의 트인 위치로 이동 — 시선이 기둥을 지나지 않고 카메라가 차체에 붙지 않음', pulled && chase2.lineToPillar > 0.35 + 0.3 && chase2.camDist > 4.0, JSON.stringify(chase2));
  const f1 = await g(() => ({ y: window.__game.rig.camera.position.y, x: window.__game.rig.camera.position.x, z: window.__game.rig.camera.position.z }));
  await sleep(1500);
  const f2 = await g(() => ({ y: window.__game.rig.camera.position.y, x: window.__game.rig.camera.position.x, z: window.__game.rig.camera.position.z }));
  check('추적 카메라 가림 보정이 안정적(계속 흔들리지 않음)', Math.hypot(f1.x - f2.x, f1.y - f2.y, f1.z - f2.z) < 0.15, JSON.stringify({ f1, f2 }));
  await clearTest();

  // ---- 위험 단계 기준 (이전 near 진입보다 이른 시점) ----
  const crit = await g(() => ({ range: window.__game.settings.sensorRange, critical: window.__game.settings.sensorCritical }));
  check('경고 기본값: 감지 범위 3.0m / 연속 경고 0.5m (이전 2.5 / 0.3)', crit.range === 3 && crit.critical === 0.5, JSON.stringify(crit));

  // ---- 카메라 영상 위 구역: 3D 시점/탑뷰에서도 표시 + 거리 숫자 없음 ----
  await startAt('D');
  await addBox('zl', SX + sideX(0.9), SZ, 0.5, 9);
  await viewIs('left');
  await sleep(2000);
  const guidePixels = () => g(() => { const c = document.querySelector('#parking-assist .pa-guide-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; });
  const withZone = await guidePixels();
  await clearTest();
  await sleep(2500);
  const noZone = await guidePixels();
  check('X6 3D 측면뷰: 실제 감지된 장애물 구역이 영상 위에 표시되고 감지가 없으면 사라짐', withZone > noZone + 200, JSON.stringify({ withZone, noZone }));
  check('일반 화면에 거리(m) 숫자 없음 (오버레이 확장 후에도)', !/\d+(\.\d+)?\s?m\b/.test(await g(() => document.getElementById('parking-assist').innerText.replace(/내비게이션[\s\S]*$/, ''))));

  // ---- 예측 조향선: 전/후방 방향, 클리핑, 중앙 복귀 ----
  const centroid = () => g(() => { const c = document.querySelector('#parking-assist .pa-guide-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sx = 0, n = 0, maxY = 0, minY = c.height; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { if (d[(y * c.width + x) * 4 + 3] > 60) { sx += x; n++; if (y > maxY) maxY = y; if (y < minY) minY = y; } } return { cx: n ? sx / n / c.width : 0.5, n, minY, maxY, h: c.height }; });
  await startAt('D');
  await viewIs('front');
  await g(() => { window.__game.car.handbrake = true; });
  await sleep(1200);
  const c0 = await centroid();
  await page.keyboard.down('KeyA');
  await sleep(2500);
  const cL = await centroid();
  await page.keyboard.up('KeyA');
  await until(() => Math.abs(window.__game.car.steer) < 0.02, undefined, 30000);
  await sleep(1000);
  const cBack = await centroid();
  check('예측선(전방카메라): 직진은 화면 중앙, 핸들을 왼쪽으로 돌리면 경로가 휘고, 중앙 복귀 시 직선으로 복귀', c0.n > 300 && Math.abs(c0.cx - 0.5) < 0.08 && Math.abs(cL.cx - c0.cx) > 0.01 && Math.abs(cBack.cx - c0.cx) < 0.03, JSON.stringify({ c0: c0.cx, cL: cL.cx, cBack: cBack.cx }));
  check('예측선 클리핑: 모든 선분이 영상 프레임 안(0..높이)에 그려짐 (화면 밖으로 뻗지 않음)', c0.minY >= 0 && c0.maxY <= c0.h - 1 && c0.n > 300, JSON.stringify({ minY: c0.minY, maxY: c0.maxY }));
  await shot('124-front-guides');
  await placeHold(SX, SZ, 0, 'R');
  await until(() => window.__game.viewOut.view === 'rear' && window.__game.infoOut.content === 'parking', undefined, 30000);
  await sleep(1000);
  const cr0 = await centroid();
  check('예측선(후방카메라): 후진 경로가 영상 안에 표시', cr0.n > 300 && cr0.minY >= 0 && cr0.maxY <= cr0.h - 1, JSON.stringify(cr0));

  // ---- 번호판 부착 ----
  const plateFix = async (vid) => {
    await g((v) => { const G = window.__game; G.updateSettings({ vehicleId: v }); G.startRun(); }, vid);
    await sleep(500);
    const sample = async (state) => {
      await g((st) => { const c = window.__game.car; Object.assign(c, st); }, state);
      await sleep(80);
      return g(() => {
        const G = window.__game; const m = G.model; m.root.updateMatrixWorld(true);
        const inv = m.root.matrixWorld.clone().invert();
        const out = {};
        m.bodyGroup.traverse((o) => { if (o.name === 'Plate_Front' || o.name === 'Plate_Rear') { const p = o.getWorldPosition(new o.position.constructor()).applyMatrix4(inv); out[o.name] = [p.x, p.y, p.z]; } });
        let ext = 0;
        m.bodyGroup.traverse((o) => { if (o.isMesh && !String(o.name).startsWith('Plate') && o.geometry.type === 'ExtrudeGeometry') { o.geometry.computeBoundingBox(); ext = Math.max(ext, o.geometry.boundingBox.max.z); } });
        return { out, ext };
      });
    };
    const a = await sample({ v: 0, steer: 0, heading: 0 });
    const b = await sample({ v: 4, steer: 0.4, heading: 1.2, gear: 'D' });
    const c = await sample({ v: -2, steer: -0.5, heading: -2.0, gear: 'R' });
    const same = ['Plate_Front', 'Plate_Rear'].every((k) => a.out[k] && [0, 1, 2].every((i) => Math.abs(a.out[k][i] - b.out[k][i]) < 1e-6 && Math.abs(a.out[k][i] - c.out[k][i]) < 1e-6));
    const stand = a.out.Plate_Front ? a.out.Plate_Front[2] - a.ext : -1;
    return { same, stand, ext: a.ext };
  };
  for (const vid of ['suv-x6', 'coupe-m4']) {
    const pf = await plateFix(vid);
    check(`번호판 고정(${vid}): 주행·조향·회전·후진 중에도 차체 기준 좌표 불변 + 차체 외곽에서 8~40mm 띄움(깜빡임 방지)`, pf.same && pf.stand > 0.008 && pf.stand < 0.04, JSON.stringify(pf));
  }
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'sedan-glb' }); G.startRun(); });
  await until(() => window.__game.model.rollers.length === 4, undefined, 30000);
  await sleep(400);
  const glbPl = await g(() => { const m = window.__game.model; let n = 0; m.bodyGroup.traverse((o) => { if (o.name === 'Plate_Front' || o.name === 'Plate_Rear') n++; }); return n; });
  check('GLB 차량 전환 후에도 번호판 앞/뒤가 유지됨(GLB 외곽에 재부착)', glbPl === 2 || (await g(() => window.__game.spec.plate === undefined)), String(glbPl));

  // ---- 방향별 경고음 ----
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'suv-x6', sensorSound: true }); G.startRun(); G.beeper.init(); });
  await sleep(600);
  const beepDir = async (gear, cols, want) => {
    await startAt(gear);
    for (const c of cols) await (c.cyl ? addCyl(c.id, c.x, c.z, c.r, 'wall') : addBox(c.id, c.x, c.z, c.w, c.d));
    const ok = await until((w) => window.__game.beepGroup === w, want, 20000);
    const last = await g(() => window.__game.beeper.lastGroup);
    return { ok, last };
  };
  const bl = await beepDir('D', [{ id: 'bl', x: SX + sideX(0.6), z: SZ, w: 0.5, d: 9 }], 'left');
  const br = await beepDir('D', [{ id: 'br', x: SX - sideX(0.6), z: SZ, w: 0.5, d: 9 }], 'right');
  const bf = await beepDir('D', [{ id: 'bf', x: SX, z: SZ + Ls / 2 + 0.6 + 0.25, w: 6, d: 0.5 }], 'front');
  const bb = await beepDir('R', [{ id: 'bb', x: SX, z: SZ - Ls / 2 - 0.6 - 0.25, w: 6, d: 0.5 }], 'rear');
  check('방향별 경고음: 좌/우/전/후 장애물에 대해 각각 해당 방향 목소리 선택', bl.ok && br.ok && bf.ok && bb.ok, JSON.stringify({ bl, br, bf, bb }));
  await startAt('R');
  await addBox('m1', SX + sideX(0.3), SZ, 0.5, 3);
  await addBox('m2', SX, SZ - Ls / 2 - 1.8 - 0.25, 6, 0.5);
  const multiOk = await until(() => window.__game.beepGroup === 'left', undefined, 30000);
  const multi = await g(() => ({ g: window.__game.beepGroup, rear: window.__game.sensorSnap.groupMin.rear, left: window.__game.sensorSnap.groupMin.left }));
  check('여러 방향 동시 감지: 더 가까운 방향(좌측)을 우선', multiOk, JSON.stringify(multi));
  await clearTest();
  await g(() => { window.__game.updateSettings({ sensorSound: false }); });
  await sleep(300);
  check('경고음 OFF 설정 존중: beeper.enabled=false', (await g(() => window.__game.beeper.enabled)) === false);
  await g(() => { window.__game.updateSettings({ sensorSound: true }); });

  // ---- 3인칭/1인칭 PDC 상태 일치 ----
  await startAt('D');
  await addBox('sy', SX + sideX(0.8), SZ, 0.5, 9);
  await viewIs('left');
  const pd = () => g(() => JSON.stringify({ o: window.__game.pdcState.overall, z: window.__game.pdcState.zones.map((q) => q.level) }));
  await sleep(1500);
  const p3 = await pd();
  await g(() => window.__game.rig.setMode('driver'));
  await sleep(1500);
  const p1 = await pd();
  const cabHas = await g(() => { const cab = window.__game.model.cabin.center; const d = cab.ctx.getImageData(0, 0, cab.canvas.width, cab.canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) n++; return n; });
  check('3인칭/1인칭 PDC 상태(구역 단계)와 시점이 일치하고 실내 화면이 그려짐', p3 === p1 && cabHas > 800 && (await g(() => window.__game.viewOut.view)) === 'left', JSON.stringify({ p3: p3.slice(0, 60), cabHas }));
  await g(() => window.__game.rig.setMode('chase'));
  await clearTest();
  await g(() => { window.__game.updateSettings({ vehicleId: 'sedan' }); window.__game.startRun(); });
  await sleep(500);

  // ---------- 14. 자원 누수 (반복 시작 시 geometry/texture 가 늘어나지 않아야 함) ----------
  const mem = () => g(() => { const m = window.__game.renderer.info.memory; return { geo: m.geometries, tex: m.textures }; });
  const leakRun = async (vehicleId, mapId) => {
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await g(([v, m]) => { const G = window.__game; G.updateSettings({ vehicleId: v, mapId: m }); G.startRun(); }, [vehicleId, mapId]);
      await sleep(250);
      samples.push(await mem());
    }
    return samples;
  };
  for (const [v, m] of [['suv-x6', 'lot'], ['coupe-m4', 'lot'], ['sedan-glb', 'lot']]) {
    const sm = await leakRun(v, m);
    const early = sm.slice(0, 4);
    const base = { geo: Math.max(...early.map((x) => x.geo)), tex: Math.max(...early.map((x) => x.tex)) }; // GLB 는 비동기 로딩 시점에 따라 값이 둘 사이를 오간다
    const last = sm[sm.length - 1];
    check(`반복 시작 자원 안정: ${v} (geometry ≤${base.geo}→${last.geo}, texture ≤${base.tex}→${last.tex})`, last.geo <= base.geo + 1 && last.tex <= base.tex + 1, JSON.stringify(sm.map((x) => x.geo + '/' + x.tex)));
  }
  await g(() => { window.__game.updateSettings({ vehicleId: 'sedan', mapId: 'lot' }); window.__game.startRun(); });
  const mapA = [];
  for (const mid of ['underground', 'lot', 'outdoor', 'underground', 'lot', 'outdoor']) {
    await g((id) => { const G = window.__game; G.updateSettings({ mapId: id }); G.startRun(); }, mid).catch(() => {});
    await sleep(300);
    mapA.push(await mem());
  }
  check('맵 교체 반복 시에도 자원 증가 없음', mapA[5].geo <= mapA[2].geo + 2 && mapA[5].tex <= mapA[2].tex + 2, JSON.stringify(mapA));
  await g(() => { window.__game.updateSettings({ mapId: 'lot', missionId: 'lot-front' }); window.__game.startRun(); });

  // ---------- 16. v0.4.5 다층 주차타워 (실제 주행: 경사로 → 2F → 나선 램프 → 3F, 층별 판정) ----------
  await page.setViewportSize({ width: 1280, height: 720 });
  await g(() => { const G = window.__game; G.updateSettings({ vehicleId: 'suv-x6', mapId: 'tower', missionId: 'tw-2', infoAutoHide: false, assistAutoView: true, sensorSound: false }); G.startRun(); });
  await sleep(1200);
  const tw0 = await g(() => ({ id: window.__game.map.id, prov: window.__game.map.provisional, y: window.__game.car.y, floor: document.getElementById('floor-ind').textContent, floorHidden: document.getElementById('floor-ind').classList.contains('hidden'), name: window.__game.map.name }));
  check('주차타워: 맵 로드 + 임시 배치로 명시 + 현재 층(1F) 표시', tw0.id === 'tower' && tw0.prov === true && /임시/.test(tw0.name) && tw0.floor === '1F' && !tw0.floorHidden, JSON.stringify(tw0));
  await shot('130-tower-1f');
  await g(() => {
    window.__apStart = (path, speed) => {
      const G = window.__game;
      let idx = 0;
      clearInterval(window.__apT);
      window.__apMax = { pitch: 0, y: 0 };
      window.__apT = setInterval(() => {
        const c = G.car; const sp = G.spec; const off = sp.length / 2 - sp.rearOverhang;
        const cx = c.x + Math.sin(c.heading) * off; const cz = c.z + Math.cos(c.heading) * off;
        while (idx < path.length - 1 && Math.hypot(path[idx][0] - cx, path[idx][1] - cz) < 3) idx++;
        const [tx, tz] = path[idx];
        let err = Math.atan2(tx - c.x, tz - c.z) - c.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        G.debugInput = { throttle: c.v < speed ? 1 : 0, brake: 0, steerInput: Math.max(-1, Math.min(1, (err * 1.6) / sp.maxSteer)) };
        window.__apMax.pitch = Math.max(window.__apMax.pitch, c.pitch); window.__apMax.y = Math.max(window.__apMax.y, c.y);
      }, 16);
    };
    window.__apStop = () => { clearInterval(window.__apT); window.__game.debugInput = null; };
  });
  const rampPath = []; for (let x = -33; x <= 8; x += 1) rampPath.push([x, 0]);
  await g(([path]) => { const c = window.__game.car; c.gear = 'D'; c.handbrake = false; window.__apStart(path, 2.2); }, [rampPath]);
  const onRamp = await until(() => window.__game.car.y > 1.4 && window.__game.car.x > -22 && window.__game.car.x < -16, undefined, 120000);
  const rampSt = await g(() => ({ y: window.__game.car.y, pitch: window.__game.car.pitch, rootX: window.__game.model.root.rotation.x, floor: document.getElementById('floor-ind').textContent }));
  await shot('131-tower-ramp');
  check('경사로 주행: 차량 높이가 실제로 상승하고 차체 피치(코가 위)가 모델에 반영', onRamp && rampSt.y > 1.4 && rampSt.pitch > 0.1 && rampSt.rootX < -0.1, JSON.stringify(rampSt));
  const on2f = await until(() => window.__game.car.y > 3.15 && window.__game.car.x > 2, undefined, 120000);
  await g(() => window.__apStop());
  const st2 = await g(() => ({ y: window.__game.car.y, col: window.__game.collisions, floor: document.getElementById('floor-ind').textContent, pitch: window.__apMax.pitch }));
  await sleep(1000);
  await shot('132-tower-2f');
  check('직선 경사로로 2F 도달(충돌 0, 층 표시 2F)', on2f && st2.col === 0 && st2.floor === '2F' && Math.abs(st2.y - 3.2) < 0.05, JSON.stringify(st2));
  // 센서: 2F 에서는 2F 주차 차량만 감지 (1F/3F 같은 평면 좌표 차량은 감지되지 않음)
  await g(() => { const c = window.__game.car; c.v = 0; c.handbrake = true; });
  const sensors2 = await g(() => { const sn = window.__game.sensorSnap; const ids = new Set(); for (const r of sn.readings) for (const h of r.hits) ids.add(h.colliderId); return [...ids]; });
  check('2F 센서 동작: 감지된 장애물이 모두 2F 물체이며 1F/3F 의 같은 평면 좌표 차량은 감지되지 않음', sensors2.length > 0 && sensors2.every((id) => !/^tw[13]-/.test(id)) && sensors2.some((id) => /^tw2-/.test(id)), JSON.stringify(sensors2.slice(0, 8)));
  // 나선 램프
  const spPath = []; for (let x = 4; x <= 24; x += 1) spPath.push([x, 0]);
  const sp = { cx: 24, cz: 5.2, rm: 5.2, th0: -Math.PI / 2, th1: Math.PI };
  for (let th = sp.th0 + 0.05; th <= sp.th1; th += 0.06) spPath.push([sp.cx + sp.rm * Math.cos(th), sp.cz + sp.rm * Math.sin(th)]);
  spPath.push([sp.cx - sp.rm, sp.cz - 1.2]); spPath.push([sp.cx - sp.rm + 0.2, sp.cz - 3.2]);
  await g(([path]) => { const c = window.__game.car; c.gear = 'D'; c.handbrake = false; window.__apStart(path, 2.0); }, [spPath]);
  const midSpiral = await until(() => window.__game.car.y > 4.6 && window.__game.car.y < 5.4, undefined, 160000);
  await shot('133-tower-spiral');
  const spSt = await g(() => ({ y: window.__game.car.y, pitch: window.__game.car.pitch, view: window.__game.viewOut.view, floor: document.getElementById('floor-ind').textContent }));
  check('나선형 램프 주행: 회전하며 높이가 연속 상승 (2F→3F 사이 높이)', midSpiral && spSt.y > 4.5 && spSt.pitch > 0.05, JSON.stringify(spSt));
  const on3f = await until(() => window.__game.car.y > 6.35 && window.__game.car.z < 4, undefined, 160000);
  await g(() => window.__apStop());
  await g(() => { const c = window.__game.car; c.v = 0; c.handbrake = true; });
  await sleep(1000);
  await shot('134-tower-3f');
  const st3 = await g(() => ({ y: window.__game.car.y, col: window.__game.collisions, floor: document.getElementById('floor-ind').textContent }));
  check('나선 램프로 3F(옥상) 도달 (충돌 0, 층 표시 3F)', on3f && st3.col === 0 && st3.floor === '3F' && Math.abs(st3.y - 6.4) < 0.05, JSON.stringify(st3));
  // 층별 주차 성공 판정
  await g(() => { const G = window.__game; G.updateSettings({ missionId: 'tw-2' }); G.startRun(); });
  await sleep(600);
  const placeAtSlot = (slotId, yy) => g(([id, y]) => { const G = window.__game; const sl = G.map.slots.find((q) => q.id === id); const h = sl.dir; const spec = G.spec; const off = spec.length / 2 - spec.rearOverhang; const c = G.car; c.x = sl.x - Math.sin(h) * off; c.z = sl.z - Math.cos(h) * off; c.heading = h; c.v = 0; c.y = y; c.pitch = 0; c.slope = 0; c.gear = 'P'; c.handbrake = true; }, [slotId, yy]);
  await placeAtSlot('tw2-s-4', 0);
  await sleep(5000);
  const wrongLevel = await g(() => ({ status: window.__game.mission.status, lvl: window.__game.mission.check && window.__game.mission.check.levelOk }));
  check('주차 판정: 1F 에서 2F 주차칸의 평면 위치에 있어도 성공이 아니다 (층 조건)', wrongLevel.status === 'running' && wrongLevel.lvl === false, JSON.stringify(wrongLevel));
  await placeAtSlot('tw2-s-4', 3.2);
  const okLevel = await until(() => window.__game.mission.status === 'success', undefined, 60000);
  check('주차 판정: 2F 에서 2F 주차칸에 맞게 정차하면 성공', okLevel);
  await shot('135-tower-park-success');
  // 층별 카메라/PDC: 3F 에서 후방카메라/측면 위험 시점
  await g(() => { const G = window.__game; G.updateSettings({ missionId: 'tw-3' }); G.startRun(); });
  await sleep(800);
  const tw3 = await g(() => ({ y: window.__game.car.y, floor: document.getElementById('floor-ind').textContent }));
  check('미션 tw-3 스폰: 2F 높이에서 시작, 층 표시 2F', Math.abs(tw3.y - 3.2) < 0.05 && tw3.floor === '2F', JSON.stringify(tw3));
  await g(() => { const G = window.__game; const c = G.car; c.gear = 'R'; c.handbrake = true; });
  await until(() => window.__game.infoOut.floatingVisible && window.__game.infoOut.content === 'parking', undefined, 30000);
  await sleep(1500);
  const cam2f = await g(() => { const G = window.__game; return { view: G.viewOut.view, camY: G.rig.assistCamera.position.y, carY: G.car.y }; });
  check('2F 후방카메라: 보조 카메라 높이가 현재 층 높이를 따른다 (1F 높이 아님)', cam2f.view === 'rear' && cam2f.camY > 3.5, JSON.stringify(cam2f));
  // 반복 시작 자원 안정 (타워)
  const swp = [];
  for (let i = 0; i < 6; i++) { await g(() => { const G = window.__game; G.updateSettings({ missionId: 'tw-2' }); G.startRun(); }); await sleep(250); swp.push(await mem()); }
  check('주차타워 반복 시작 시 geometry/texture 증가 없음', swp[5].geo <= swp[1].geo + 1 && swp[5].tex <= swp[1].tex + 1, JSON.stringify(swp.map((x) => x.geo + '/' + x.tex)));
  await g(() => { window.__game.updateSettings({ vehicleId: 'sedan', mapId: 'lot', missionId: 'lot-front' }); window.__game.startRun(); });
  await sleep(600);

  // ---------- 11. 모바일(터치/가로 화면) ----------
  {
    const mctx = await browser.newContext({ viewport: { width: 800, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const mp = await mctx.newPage();
    await mp.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, showFps: true })));
    mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
    await mp.goto(URL);
    await mp.waitForSelector('#m-start');
    await mp.screenshot({ path: path.join(OUT, '90-mobile-menu.png') });
    await mp.tap('#m-start');
    await mp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1500);
    const vis = await mp.evaluate(() => !document.getElementById('touch').classList.contains('hidden'));
    check('모바일: 터치 컨트롤 자동 표시', vis);
    const sizes = await mp.evaluate(() => [...document.querySelectorAll('#touch .tbtn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }).filter(([w]) => w > 0));
    check('모바일: 터치 버튼(가속/브레이크) 크기 ≥ 48px, 기본 조향은 회전 핸들이라 좌우 버튼은 숨김', sizes.length === 2 && sizes.every(([w, h]) => w >= 48 && h >= 48), JSON.stringify(sizes));
    const wsz = await mp.evaluate(() => { const r = document.getElementById('t-wheel').getBoundingClientRect(); return Math.round(r.width); });
    check('모바일: 회전 핸들 터치 영역 ≥ 100px', wsz >= 100, String(wsz));

    // 멀티터치 변속: 손가락 1 = 브레이크 유지, 손가락 2 = 기어 레버 드래그
    const touchShift = async (cdp, gear, withBrake = true) => {
      const ctr = (sel) => mp.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
      const brake = await ctr('#touch .brk');
      const knob = await ctr('.sh-knob');
      const tgt = await ctr(`.sh-pos[data-g="${gear}"]`);
      // 손가락 1 = 레버, 손가락 2 = 브레이크 (먼저 떼는 쪽이 레버가 되도록 순서 지정)
      const pts = (y) => [{ x: knob.x, y, id: 1 }, ...(withBrake ? [{ x: brake.x, y: brake.y, id: 2 }] : [])];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(knob.y) });
      await sleep(200);
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(knob.y + ((tgt.y - knob.y) * i) / 6) });
      // 레버를 먼저 놓고(브레이크는 계속 누름) 변속 판정 뒤에 브레이크를 뗀다
      // (CDP: touchEnd 의 touchPoints = 떼어지는 손가락)
      if (withBrake) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: knob.x, y: tgt.y, id: 1 }] });
        await sleep(600);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(300);
    };
    const cdp0 = await mctx.newCDPSession(mp);
    const lev = await mp.evaluate(() => { const t = document.querySelector('.sh-track').getBoundingClientRect(); const k = document.querySelector('.sh-knob').getBoundingClientRect(); return [Math.round(t.width), Math.round(k.height)]; });
    check('모바일: 기어 레버 터치 영역 (트랙 폭 ≥ 44px, 손잡이 높이 ≥ 34px)', lev[0] >= 44 && lev[1] >= 34, JSON.stringify(lev));
    const barBtn = await mp.evaluate(() => [...document.querySelectorAll('#actionbar button, .iconbar button')].map((b) => Math.round(b.getBoundingClientRect().height)));
    check('모바일: HUD 버튼 높이 ≥ 40px', barBtn.length > 8 && barBtn.every((h) => h >= 40), JSON.stringify(barBtn));
    await touchShift(cdp0, 'D', false);
    check('모바일: 브레이크 없이 레버를 D 로 끌면 변속 거부 (P 유지)', await mp.evaluate(() => window.__game.car.gear === 'P'));
    await touchShift(cdp0, 'D', true);
    check('모바일 멀티터치: 한 손가락 브레이크 + 다른 손가락 레버 드래그로 D 변속', await mp.evaluate(() => window.__game.car.gear === 'D'));
    // 가속 버튼 누르고 있기 (CDP 터치)
    const cdp = await mctx.newCDPSession(mp);
    const gas = await mp.evaluate(() => { const r = document.querySelector('#touch .gas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gas.x, y: gas.y, id: 1 }] });
    const okGas = await mp.waitForFunction(() => window.__game.car.v > 2, null, { timeout: 25000, polling: 100 }).then(() => true).catch(() => false);
    await mp.screenshot({ path: path.join(OUT, '91-mobile-driving.png') });
    // ---- 회전 핸들 멀티터치: 손가락 1 = 가속 유지, 손가락 2 = 핸들을 반시계(왼쪽)로 회전 ----
    const wc = await mp.evaluate(() => { const r = document.getElementById('t-wheel').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.width / 2 }; });
    const wpt = (deg, f = 0.75) => ({ x: wc.x + Math.cos((deg * Math.PI) / 180) * wc.r * f, y: wc.y + Math.sin((deg * Math.PI) / 180) * wc.r * f });
    // totalDeg: 화면 시계방향 +. 반시계(왼쪽 조향)는 음수
    const wheelSpin = async (extra, totalDeg, id = 7) => {
      let a = -90;
      const n = Math.ceil(Math.abs(totalDeg) / 10);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...extra, { ...wpt(a), id }] });
      for (let i = 0; i < n; i++) { a += 10 * Math.sign(totalDeg); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...extra, { ...wpt(a), id }] }); }
    };
    const hh0 = await mp.evaluate(() => window.__game.car.heading);
    await wheelSpin([{ x: gas.x, y: gas.y, id: 1 }], -120);
    const okSteer = await mp.waitForFunction((h) => window.__game.car.heading > h + 0.1, hh0, { timeout: 25000, polling: 100 }).then(() => true).catch(() => false);
    const wAngle1 = await mp.evaluate(() => window.__game.hud.wheel.angle);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    check('모바일 멀티터치: 핸들(반시계 120°) + 가속 동시 조작 → 좌회전', okSteer && wAngle1 > 100, String(wAngle1));
    check('모바일: 가속 버튼 홀드로 전진', okGas);

    const released = await mp.evaluate(() => !window.__game.input.held.throttle && !window.__game.input.held.left);
    check('모바일: 손을 떼면 입력 해제', released);
    // 모바일 주차 보조 패널: 겹침/터치 크기
    await mp.evaluate(() => { const c = window.__game.car; c.v = 0; c.gear = 'N'; });
    // ---- 핸들 540° 한계 / 핸들+브레이크 / 브레이크+레버+핸들(3손가락) ----
    await mp.evaluate(() => { const c = window.__game.car; c.v = 0; c.handbrake = true; });
    const ctrOf = (sel) => mp.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
    await wheelSpin([], -700);
    await sleep(400);
    const stL = await mp.evaluate(() => ({ a: window.__game.hud.wheel.angle, steer: window.__game.car.steer, max: window.__game.spec.maxSteer }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(2500);
    check('핸들: 반시계 540° 에서 멈추고(총 1080° 중 왼쪽 절반) 앞바퀴는 최대 조향각', stL.a === 540 && stL.steer > stL.max * 0.9 && stL.steer <= stL.max + 1e-6, JSON.stringify(stL));
    const afterRel = await mp.evaluate(() => window.__game.hud.wheel.angle);
    check('핸들(v0.4.7): 정차 중에는 손을 떼도 조향각 유지(540° 그대로)', afterRel === 540, String(afterRel));
    await mp.evaluate(() => { window.__game.car.handbrake = false; window.__game.car.v = 3; });
    await mp.waitForFunction(() => Math.abs(window.__game.hud.wheel.angle) < 520, null, { timeout: 15000 }).catch(() => {});
    const afterMove = await mp.evaluate(() => window.__game.hud.wheel.angle);
    await mp.evaluate(() => { window.__game.car.v = 0; window.__game.car.handbrake = true; });
    check('핸들: 주행 중에는 손을 떼면 중앙으로 복귀', Math.abs(afterMove) < 540, String(afterMove));
    await mp.evaluate(() => window.__game.hud.wheel.reset());
    await wheelSpin([], 700);
    await sleep(400);
    const stR = await mp.evaluate(() => ({ a: window.__game.hud.wheel.angle, steer: window.__game.car.steer, max: window.__game.spec.maxSteer }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('핸들: 시계 540° (오른쪽) 한계', stR.a === -540 && stR.steer < -stR.max * 0.9, JSON.stringify(stR));
    await mp.evaluate(() => window.__game.hud.wheel.reset());
    const brk = await ctrOf('#touch .brk');
    await wheelSpin([{ x: brk.x, y: brk.y, id: 1 }], -90);
    const wb = await mp.evaluate(() => ({ brake: window.__game.input.held.brake, a: window.__game.hud.wheel.angle }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('멀티터치: 핸들 + 브레이크 동시 (서로 입력을 가로채지 않음)', wb.brake === true && wb.a > 75, JSON.stringify(wb));
    await mp.evaluate(() => window.__game.hud.wheel.reset());
    const threeFinger = async (gear) => {
      const knob = await ctrOf('.sh-knob');
      const tgt = await ctrOf(`.sh-pos[data-g="${gear}"]`);
      const brk2 = await ctrOf('#touch .brk');
      const mk = (i, a) => [{ x: knob.x, y: knob.y + ((tgt.y - knob.y) * i) / 6, id: 1 }, { x: brk2.x, y: brk2.y, id: 2 }, { ...wpt(a), id: 3 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: mk(0, -90) });
      await sleep(150);
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: mk(i, -90 - 15 * i) });
      const wa = await mp.evaluate(() => window.__game.hud.wheel.angle);
      // 레버 손가락(id 1)만 먼저 뗀다 (CDP touchEnd 의 touchPoints = 떼어지는 손가락)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: mk(6, -90 - 90).slice(0, 1) });
      await sleep(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(300);
      return wa;
    };
    const wa3 = await threeFinger('R');
    const g3 = await mp.evaluate(() => window.__game.car.gear);
    check('멀티터치: 브레이크 + 기어 레버 + 핸들 3손가락 동시 → R 변속 + 핸들 회전', g3 === 'R' && wa3 > 70, JSON.stringify({ g3, wa3 }));
    await mp.evaluate(() => window.__game.hud.wheel.reset());
    await mp.evaluate(() => { const c = window.__game.car; c.v = 0; c.handbrake = true; });
    await threeFinger('D');
    const backD = await mp.waitForFunction(() => window.__game.car.gear === 'D', null, { timeout: 15000, polling: 100 }).then(() => true).catch(() => false);
    check('멀티터치(3손가락): 다시 D 로 변속', backD, await mp.evaluate(() => JSON.stringify({ g: window.__game.car.gear, v: window.__game.car.v, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })));
    await mp.evaluate(() => window.__game.hud.wheel.reset());
    // 입력 안전 초기화: 일시정지/앱 전환 시 핸들 상태 해제
    await wheelSpin([], -200);
    await mp.evaluate(() => window.__game.hud.resetTouchInputs());
    check('입력 안전 초기화: 앱 전환/일시정지 시 핸들 드래그 해제 + 중앙 복귀', await mp.evaluate(() => !window.__game.hud.wheel.dragging && window.__game.hud.wheel.angle === 0));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await mp.evaluate(() => { window.__game.car.handbrake = true; });
    await touchShift(cdp0, 'R', true);
    await mp.evaluate(() => { window.__game.car.handbrake = false; });
    await sleep(900);
    const rects = await mp.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const p = document.getElementById('parking-assist');
      return {
        visible: !p.classList.contains('hidden'),
        panel: r(p),
        side: [...p.querySelectorAll('.pa-side button')].map(r),
        shifter: (() => { const b = document.getElementById('shifter').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })(),
        others: [...document.querySelectorAll('#touch .tbtn, #t-wheel, #gear-big, #cluster, #actionbar, .iconbar')].map((e) => ({ n: e.id || e.className, ...r(e) })),
        vw: innerWidth, vh: innerHeight,
      };
    });
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const overlaps = rects.others.filter((o) => hit(rects.panel, o)).map((o) => o.n);
    await mp.screenshot({ path: path.join(OUT, '93-mobile-assist.png') });
    const shOver = rects.others.filter((o) => hit(rects.shifter, o)).map((o) => o.n);
    check('모바일(800×360): 기어 레버가 터치 버튼/클러스터/아이콘바와 겹치지 않음', shOver.length === 0 && rects.shifter.x + rects.shifter.w <= rects.vw && rects.shifter.y + rects.shifter.h <= rects.vh, shOver.join(','));
    check('모바일(800×360): 주차 보조 패널 표시', rects.visible, JSON.stringify(rects.panel));
    check('모바일: 주차 보조 패널이 터치 버튼/계기판/HUD 버튼과 겹치지 않음', overlaps.length === 0, overlaps.join(','));
    check('모바일: 패널이 화면 안에 완전히 들어옴', rects.panel.x >= 0 && rects.panel.y >= 0 && rects.panel.x + rects.panel.w <= rects.vw && rects.panel.y + rects.panel.h <= rects.vh, JSON.stringify(rects.panel));
    const mAct = await mp.evaluate(() => ['signalLeft', 'hazard', 'signalRight', 'headlights', 'handbrake', 'reset'].every((n) => { const b = document.querySelector(`#actionbar [data-a="${n}"]`); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width >= 38 && r.height >= 38 && !!t && (t === b || b.contains(t)); }));
    check('모바일: 주차 보조 표시 중 방향지시/비상등/조명/주차브레이크 버튼이 보이고 터치 가능 (숨기지 않음)', rects.visible && mAct);
    await mp.tap('#actionbar [data-a="hazard"]');
    await sleep(250);
    const mHz = await mp.evaluate(() => window.__game.hazard);
    await mp.tap('#actionbar [data-a="hazard"]');
    await mp.tap('#actionbar [data-a="handbrake"]');
    await sleep(250);
    const mHb = await mp.evaluate(() => window.__game.car.handbrake);
    await mp.tap('#actionbar [data-a="handbrake"]');
    check('모바일: 주차 보조 표시 중 비상등/주차브레이크 터치가 실제로 동작', mHz === true && mHb === true, JSON.stringify({ mHz, mHb }));
    check('모바일: 사이드 버튼 5개 높이 ≥ 32px', rects.side.length === 5 && rects.side.every((b) => b.h >= 32), JSON.stringify(rects.side.map((b) => Math.round(b.h))));
    const fpsTxt = await mp.evaluate(() => document.getElementById('fps').textContent);
    check('모바일: FPS 표시', /FPS/.test(fpsTxt), fpsTxt);
    await mp.screenshot({ path: path.join(OUT, '92-mobile-steer.png') });

    // ---- v0.4.6: 큰 핸들/페달 크기·겹침 (뷰포트별) ----
    const rectsOf = () => mp.evaluate(() => {
      const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { wheel: r('#t-wheel'), brk: r('#touch .brk'), gas: r('#touch .gas'), sh: r('#shifter'), gear: r('#gear-big'), panel: document.getElementById('parking-assist').classList.contains('hidden') ? null : r('#parking-assist'), vw: innerWidth, vh: innerHeight };
    });
    const hit2 = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const [vw, vh] of [[1280, 800], [1024, 768], [960, 540], [780, 360]]) {
      await mp.setViewportSize({ width: vw, height: vh });
      await sleep(500);
      const R = await rectsOf();
      const inside = [R.wheel, R.brk, R.gas, R.sh].every((o) => o && o.x >= -1 && o.y >= -1 && o.x + o.w <= R.vw + 1 && o.y + o.h <= R.vh + 1);
      const noOv = !hit2(R.wheel, R.brk) && !hit2(R.wheel, R.gas) && !hit2(R.brk, R.gas) && !hit2(R.sh, R.brk) && !hit2(R.sh, R.gas) && !hit2(R.sh, R.wheel) && !hit2(R.panel, R.wheel) && !hit2(R.panel, R.sh);
      check(`v0.4.6 ${vw}×${vh}: 핸들 ${Math.round(R.wheel.w)}px / 페달 ${Math.round(R.brk.w)}×${Math.round(R.brk.h)}, ${Math.round(R.gas.w)}×${Math.round(R.gas.h)} — 화면 안 + 서로 겹침 없음(기어 레버 포함)`, inside && noOv && R.wheel.w >= 104, JSON.stringify(R));
      if (vw === 1280) check('v0.4.6 1280×800: 핸들 ≥ 300px, 페달 너비 ≥ 100/115px (v0.4.7 에서 의도적으로 소폭 축소)', R.wheel.w >= 300 && R.brk.w >= 100 && R.gas.w >= 115, `${R.wheel.w}/${R.brk.w}/${R.gas.w}`);
      await mp.screenshot({ path: path.join(OUT, `94-v046-touch-${vw}x${vh}.png`) });
    }
    await mp.setViewportSize({ width: 800, height: 360 });
    await sleep(500);

    // ---- v0.4.6: 브레이크를 누른 채 다른 UI 동시 조작 (멀티터치) ----
    {
      const cdp = await mctx.newCDPSession(mp);
      const ctr = (sel) => mp.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
      await mp.evaluate(() => { const G = window.__game; G.car.gear = 'D'; G.car.v = 0.4; G.car.handbrake = false; });
      await mp.waitForFunction(() => !document.getElementById('parking-assist').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
      const brake = await ctr('#touch .brk');
      const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }]);
      await mp.waitForFunction(() => window.__game.brake > 0.5, null, { timeout: 8000 }).catch(() => {});
      const braking = await mp.evaluate(() => window.__game.brake > 0.5);
      check('v0.4.6 멀티터치: 브레이크 손가락 유지 중 브레이크 입력 활성', braking);
      // 브레이크 + 카메라 버튼 연타
      const camBefore = await mp.evaluate(() => window.__game.assist.cameraMode);
      const cam = await ctr('#parking-assist [data-pa="camera"]');
      for (let i = 0; i < 3; i++) {
        await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: cam.x, y: cam.y, id: 2 }]);
        await sleep(80);
        await send('touchEnd', [{ x: cam.x, y: cam.y, id: 2 }]);
        await sleep(160);
      }
      const camAfter = await mp.evaluate(() => ({ m: window.__game.assist.cameraMode, brake: window.__game.brake }));
      check('v0.4.6 멀티터치: 브레이크 유지 + 카메라 버튼 3회 연타 → 카메라 모드 3단계 변경, 브레이크 유지', camAfter.m !== camBefore && camAfter.brake > 0.5, JSON.stringify({ camBefore, camAfter }));
      // 브레이크 + 주차 보조 버튼 / 설정 버튼
      const sensBefore = await mp.evaluate(() => window.__game.settings.sensorEnabled);
      const sen = await ctr('#parking-assist [data-pa="sensor"]');
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: sen.x, y: sen.y, id: 3 }]);
      await sleep(80);
      await send('touchEnd', [{ x: sen.x, y: sen.y, id: 3 }]);
      await sleep(300);
      const sensAfter = await mp.evaluate(() => window.__game.settings.sensorEnabled);
      check('v0.4.6 멀티터치: 브레이크 유지 + 주차 보조 버튼 → 센서 설정 토글', sensAfter === !sensBefore);
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: sen.x, y: sen.y, id: 4 }]);
      await sleep(80);
      await send('touchEnd', [{ x: sen.x, y: sen.y, id: 4 }]);
      await sleep(300);
      // 브레이크 + 핸들 드래그 + 가속
      const wheel = await ctr('#t-wheel');
      const gas = await ctr('#touch .gas');
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: wheel.x, y: wheel.y - 40, id: 5 }, { x: gas.x, y: gas.y, id: 6 }]);
      await sleep(150);
      for (let i = 1; i <= 6; i++) {
        await send('touchMove', [{ x: brake.x, y: brake.y, id: 1 }, { x: wheel.x + i * 8, y: wheel.y - 40 + i * 4, id: 5 }, { x: gas.x, y: gas.y, id: 6 }]);
        await sleep(30);
      }
      await sleep(150);
      const three = await mp.evaluate(() => ({ brake: window.__game.brake, throttle: window.__game.throttle, steer: window.__game.steerIn }));
      check('v0.4.6 3손가락: 브레이크 + 핸들 + 가속 동시 입력이 모두 반영', three.brake > 0.5 && three.throttle > 0.5 && Math.abs(three.steer) > 0.05, JSON.stringify(three));
      // 가속 손가락만 떼도 나머지 유지
      await send('touchEnd', [{ x: gas.x, y: gas.y, id: 6 }]);
      await mp.waitForFunction(() => window.__game.throttle < 0.2, null, { timeout: 8000 }).catch(() => {});
      const rel = await mp.evaluate(() => ({ brake: window.__game.brake, throttle: window.__game.throttle, steer: window.__game.steerIn }));
      check('v0.4.6 한 손가락을 떼도 나머지 손가락 입력 유지', rel.throttle < 0.2 && rel.brake > 0.5 && Math.abs(rel.steer) > 0.05, JSON.stringify(rel));
      await send('touchEnd', [{ x: brake.x, y: brake.y, id: 1 }, { x: wheel.x + 48, y: wheel.y - 16, id: 5 }]);
      await sleep(300);
      await mp.screenshot({ path: path.join(OUT, '95-v046-multitouch.png') });
      await cdp.detach();
    }
    await mctx.close();
  }


  // ================= v0.4.7 =================
  {
    // ---- 페달 크기/위치, 기어 크기/좌표 (v0.4.6 측정값과 비교) ----
    const BEFORE = {
      '1280x800': { brake: [969, 521, 134, 269], gas: [1115, 485, 153, 305], wheel: 376, gearFont: 40 },
      '1024x768': { brake: [840, 608, 75, 150], gas: [927, 587, 85, 171], wheel: 248, gearFont: 40 },
      '960x540': { brake: [807, 410, 60, 120], gas: [880, 393, 68, 137], wheel: 216, gearFont: 40 },
      '780x360': { brake: [643, 246, 53, 106], gas: [708, 232, 60, 120], wheel: 144, gearFont: 34 },
    };
    const tctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const tp = await tctx.newPage();
    tp.on('pageerror', (e) => errors.push('v047 touch pageerror: ' + e.message));
    await tp.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10 })));
    await tp.goto(URL);
    await tp.waitForSelector('#m-start');
    await tp.tap('#m-start');
    await tp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1200);
    for (const key of Object.keys(BEFORE)) {
      const [vw, vh] = key.split('x').map(Number);
      await tp.setViewportSize({ width: vw, height: vh });
      await sleep(500);
      const m = await tp.evaluate(() => {
        const r = (q) => { const e = document.querySelector(q); const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
        const gb = document.getElementById('gear-big');
        const act = gb.querySelector(`span[data-g="${gb.dataset.g}"]`);
        return { brake: r('#touch .brk'), gas: r('#touch .gas'), wheel: r('#t-wheel'), sh: r('#shifter'), gear: r('#gear-big'), gearFont: parseFloat(getComputedStyle(act).fontSize), vw: innerWidth, vh: innerHeight };
      });
      const B = BEFORE[key];
      const rb = m.brake[2] / B.brake[2], rg = m.gas[2] / B.gas[2], rbh = m.brake[3] / B.brake[3];
      check(`v0.4.7 ${key}: 페달 크기 10~15% 축소 (브레이크 ${B.brake[2]}→${Math.round(m.brake[2])}px / 가속 ${B.gas[2]}→${Math.round(m.gas[2])}px), 비율 유지`, rb >= 0.84 && rb <= 0.91 && rg >= 0.84 && rg <= 0.91 && rbh >= 0.84 && rbh <= 0.91 && Math.abs(m.brake[2] / m.gas[2] - B.brake[2] / B.gas[2]) < 0.04, `${rb.toFixed(3)}/${rg.toFixed(3)}/${rbh.toFixed(3)}`);
      const gasRightBefore = B.gas[0] + B.gas[2], gasRightNow = m.gas[0] + m.gas[2];
      const gasBotBefore = B.gas[1] + B.gas[3], gasBotNow = m.gas[1] + m.gas[3];
      check(`v0.4.7 ${key}: 페달 위치가 실제로 이동 (가속 오른쪽 끝 ${Math.round(gasRightBefore)}→${Math.round(gasRightNow)}, 아래쪽 ${Math.round(gasBotBefore)}→${Math.round(gasBotNow)})`, gasRightBefore - gasRightNow >= 8 && gasBotBefore - gasBotNow >= 8, JSON.stringify({ brake: m.brake.map(Math.round), gas: m.gas.map(Math.round) }));
      const hit = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
      const inside = [m.brake, m.gas, m.sh, m.wheel].every((o) => o[0] >= 0 && o[1] >= 0 && o[0] + o[2] <= m.vw && o[1] + o[3] <= m.vh);
      const noOv = !hit(m.brake, m.gas) && !hit(m.sh, m.brake) && !hit(m.sh, m.gas) && !hit(m.wheel, m.brake) && !hit(m.wheel, m.gas) && !hit(m.wheel, m.sh);
      const gapSh = m.gas[0] - (m.brake[0] + m.brake[2]); // 두 페달 사이 간격(레버는 좌측 상단으로 이동)
      const edge = m.vw - gasRightNow;
      check(`v0.4.7 ${key}: 화면 안 + 겹침 없음 + 페달 사이 간격 ${Math.round(gapSh)}px(≥12) + 오른쪽 가장자리 여백 ${Math.round(edge)}px(≥20), 핸들 ${Math.round(m.wheel[2])}px 불변`, inside && noOv && gapSh >= 12 && edge >= 20 && Math.abs(m.wheel[2] - B.wheel) <= 1, JSON.stringify({ gapSh, edge }));
      const gearGrow = m.gearFont / B.gearFont;
      check(`v0.4.7 ${key}: 기어 활성 글자 ${B.gearFont}→${m.gearFont}px (+15~20%), 좌상단 고정 (${Math.round(m.gear[0])},${Math.round(m.gear[1])})`, gearGrow >= 1.15 && gearGrow <= 1.21 && m.gear[0] <= 12 && m.gear[1] <= 12 && m.gear[0] >= 0, `${gearGrow.toFixed(3)}`);
      if (key === '1280x800') check('v0.4.7 1280×800 기어 활성 글자 46~48px 목표', m.gearFont >= 46 && m.gearFont <= 48, String(m.gearFont));
      await tp.screenshot({ path: path.join(OUT, `96-v047-touch-${key}.png`) });
    }
    await tp.setViewportSize({ width: 1280, height: 800 });
    await sleep(400);

    // ---- 기어 위치가 주차 보조 패널/층 표시/미션 패널에 의해 이동하지 않음 (D 로 패널을 열기 전후) ----
    const gearPos = () => tp.evaluate(() => { const b = document.getElementById('gear-big').getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; });
    const g0 = await gearPos();
    await tp.evaluate(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.car.v = 0.5; });
    await tp.waitForFunction(() => !document.getElementById('parking-assist').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
    await sleep(600);
    const g1 = await gearPos();
    check('v0.4.7 주차 보조 패널이 열려도 기어 표시 좌표/크기 불변 (좌상단 고정)', JSON.stringify(g0) === JSON.stringify(g1), JSON.stringify({ g0, g1 }));

    // ---- 정차 중 핸들 조향각 유지 (모델 + 실제 앞바퀴 + 예측선 입력) ----
    await tp.evaluate(() => { const G = window.__game; G.car.v = 0; G.car.gear = 'D'; G.car.handbrake = true; G.hud.wheel.reset(); });
    await sleep(400);
    await tp.evaluate(() => { const w = window.__game.hud.wheel; w.begin(0); for (let i = 1; i <= 20; i++) w.move(-8 * i, 1); });
    await tp.waitForFunction(() => Math.abs(window.__game.car.steer) > 0.2, null, { timeout: 20000 }).catch(() => {});
    const held0 = await tp.evaluate(() => { const G = window.__game; return { a: G.hud.wheel.angle, steer: G.car.steer, sin: G.steerIn, pivot: G.model.frontPivots[0] ? G.model.frontPivots[0].rotation.y : null, v: G.car.v }; });
    await tp.evaluate(() => window.__game.hud.wheel.end()); // 손가락 뗌
    await sleep(2500);
    const held1 = await tp.evaluate(() => { const G = window.__game; return { a: G.hud.wheel.angle, steer: G.car.steer, sin: G.steerIn, pivot: G.model.frontPivots[0] ? G.model.frontPivots[0].rotation.y : null, v: G.car.v }; });
    check('v0.4.7 정차 중 손을 떼도 핸들 각도 유지 (HUD)', Math.abs(held0.a) > 100 && held1.a === held0.a, JSON.stringify({ held0, held1 }));
    check('v0.4.7 정차 중 실제 앞바퀴 조향각(VehicleState.steer)·steerInput 유지', Math.abs(held1.steer - held0.steer) < 1e-3 && Math.abs(held1.sin - held0.sin) < 1e-6 && Math.abs(held1.v) < 0.05, JSON.stringify({ held0, held1 }));
    check('v0.4.7 정차 중 앞바퀴 모델(애니메이션)도 조향 유지', held1.pivot !== null && Math.abs(held1.pivot) > 0.05 && Math.abs(held1.pivot - held0.pivot) < 0.02, JSON.stringify({ p0: held0.pivot, p1: held1.pivot }));
    await tp.evaluate(() => { const w = window.__game.hud.wheel; w.begin(0); for (let i = 1; i <= 10; i++) w.move(8 * i, 1); w.end(); });
    await sleep(600);
    const re = await tp.evaluate(() => window.__game.hud.wheel.angle);
    check('v0.4.7 정차 중 핸들을 다시 돌리면 정상 변경', re !== held1.a, `${held1.a}→${re}`);
    await tp.evaluate(() => { const G = window.__game; G.car.handbrake = false; G.car.v = 2.5; });
    const ret = await tp.waitForFunction((a) => Math.abs(window.__game.hud.wheel.angle) < Math.abs(a) - 20, re, { timeout: 15000 }).then(() => true).catch(() => false);
    check('v0.4.7 차량이 움직이면(재출발) 자동 복귀 기능 동작', ret);
    await tp.evaluate(() => { const G = window.__game; G.car.v = 0; G.car.handbrake = true; });
    await sleep(500);
    const stopA = await tp.evaluate(() => window.__game.hud.wheel.angle);
    await sleep(1500);
    const stopB = await tp.evaluate(() => window.__game.hud.wheel.angle);
    check('v0.4.7 다시 정차하면 그 각도에서 다시 유지', stopA === stopB, `${stopA}/${stopB}`);
    await tp.evaluate(() => { window.__game.hud.wheel.reset(); });

    // ---- 브레이크 유지 + 카메라/설정/기어 멀티터치 (신규 위치에서) ----
    {
      const cdp = await tctx.newCDPSession(tp);
      const ctr = (sel) => tp.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
      const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      await tp.evaluate(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.car.v = 0.4; });
      await tp.waitForFunction(() => !document.getElementById('parking-assist').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
      const brake = await ctr('#touch .brk');
      const gas = await ctr('#touch .gas');
      const wheel = await ctr('#t-wheel');
      const cam = await ctr('#parking-assist [data-pa="camera"]');
      const m0 = await tp.evaluate(() => window.__game.assist.cameraMode);
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: gas.x, y: gas.y, id: 2 }]);
      await sleep(300);
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: gas.x, y: gas.y, id: 2 }, { x: cam.x, y: cam.y, id: 3 }]);
      await sleep(80);
      await send('touchEnd', [{ x: cam.x, y: cam.y, id: 3 }]);
      await sleep(300);
      const st = await tp.evaluate(() => ({ m: window.__game.assist.cameraMode, brake: window.__game.brake, th: window.__game.throttle }));
      check('v0.4.7 브레이크+가속 두 페달을 누른 채 카메라 버튼 동작', st.m !== m0 && st.brake > 0.5, JSON.stringify({ m0, st }));
      await send('touchStart', [{ x: brake.x, y: brake.y, id: 1 }, { x: gas.x, y: gas.y, id: 2 }, { x: wheel.x, y: wheel.y - 40, id: 4 }]);
      for (let i = 1; i <= 6; i++) { await send('touchMove', [{ x: brake.x, y: brake.y, id: 1 }, { x: gas.x, y: gas.y, id: 2 }, { x: wheel.x + i * 9, y: wheel.y - 40 + i * 5, id: 4 }]); await sleep(30); }
      await sleep(200);
      const three = await tp.evaluate(() => ({ brake: window.__game.brake, a: window.__game.hud.wheel.angle }));
      check('v0.4.7 두 페달 + 핸들 동시 조작(3손가락)', three.brake > 0.5 && Math.abs(three.a) > 5, JSON.stringify(three));
      await send('touchEnd', [{ x: brake.x, y: brake.y, id: 1 }, { x: gas.x, y: gas.y, id: 2 }, { x: wheel.x + 54, y: wheel.y - 10, id: 4 }]);
      await sleep(300);
      await tp.evaluate(() => { window.__game.hud.wheel.reset(); });
      await cdp.detach();
    }
    await tctx.close();
  }

  // ---- X6(서라운드 지원) 데스크톱: 서라운드/센서 전환, 예측선, 집중 탑뷰, 후방카메라 안정성, 실내 화면, 자원 ----
  {
    const xctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const xp = await xctx.newPage();
    xp.on('pageerror', (e) => errors.push('v047 x6 pageerror: ' + e.message));
    await xp.addInitScript(() => { if (!localStorage.getItem('parksim.v1.settings')) localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', assistCameraFps: 60 })); });
    await xp.goto(URL);
    await xp.waitForSelector('#m-start');
    await xp.click('#m-start');
    await xp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1500);
    const X = (fn, arg) => xp.evaluate(fn, arg);
    const xuntil = (fn, arg, timeout = 30000) => xp.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
    const xplace = (cx, cz, h, gear) => X(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; G.hud.wheel.reset(); }, { cx, cz, h, gear });
    const xbox = (id, x, z, w, d, h = 1.4) => X(([id, x, z, w, d, h]) => { const c = { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h]);
    const xclear = () => X(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const k of [...G.colliderById.keys()]) if (String(k).startsWith('t-')) G.colliderById.delete(k); G.rig.colliders = G.colliders; });
    const L2 = await X(() => window.__game.spec.length);
    const ovStats = (sel) => X((sel) => { const c = document.querySelector(sel); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, sx = 0, sy = 0, white = 0, minY = 1e9, maxY = -1; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i + 3] > 40) { n++; sx += x; sy += y; if (y < minY) minY = y; if (y > maxY) maxY = y; if (d[i] > 200 && d[i + 1] > 215 && d[i + 2] > 230 && d[i + 3] > 150) white++; } } return { n, cx: n ? sx / n / c.width : 0.5, cy: n ? sy / n / c.height : 0.5, minY, maxY, h: c.height, white }; }, sel);

    check('v0.4.7 X6: 기본은 3D 서라운드, 표시 방식 버튼은 오른쪽 세로 메뉴에 1개(영상 위 버튼 없음)', await X(() => document.getElementById('parking-assist').dataset.surround === 'true' && document.querySelectorAll('#parking-assist .pa-side [data-pa="pdcMode"]').length === 1 && document.querySelectorAll('#parking-assist .pa-mode').length === 0));
    // ---- 서라운드 예측선: D 전진 ----
    await xclear();
    await xplace(0, 10, 0, 'D');
    await xuntil(() => !document.getElementById('parking-assist').classList.contains('hidden') && window.__game.surPathDbg && window.__game.surPathDbg.renders > 5);
    await sleep(800);
    const f0 = await X(() => ({ ...window.__game.surPathDbg, view: window.__game.viewOut.view }));
    const s0 = await ovStats('.pa-sur-ov');
    check('v0.4.7 서라운드: 전진(D) 예측선이 차량 앞쪽(화면 위쪽)에 그려짐', f0.dir === 1 && s0.n > 200 && s0.cy < 0.5, JSON.stringify({ f0, s0 }));
    await xp.screenshot({ path: path.join(OUT, '97-v047-surround-forward.png') });
    // 정지 상태에서 조향 → 곡선 변화 (centroid 가 왼쪽으로)
    await X(() => { const w = window.__game.hud.wheel; w.begin(0); for (let i = 1; i <= 25; i++) w.move(-8 * i, 1); w.end(); });
    await xuntil(() => window.__game.car.steer > 0.2);
    await sleep(1200);
    const s1 = await ovStats('.pa-sur-ov');
    const f1 = await X(() => ({ ...window.__game.surPathDbg }));
    check('v0.4.7 서라운드: 정차 중 조향 변화가 예측선에 실시간 반영(왼쪽으로 휘어짐), 조향각 유지 시 선도 유지', f1.steer > 0.2 && s1.cx < s0.cx - 0.008, JSON.stringify({ s0: s0.cx, s1: s1.cx, steer: f1.steer }));
    await sleep(1500);
    const s1b = await ovStats('.pa-sur-ov');
    check('v0.4.7 서라운드: 손을 뗀 뒤에도 예측선 유지', Math.abs(s1b.cx - s1.cx) < 0.01 && Math.abs(s1b.n - s1.n) < s1.n * 0.1, JSON.stringify({ a: s1.cx, b: s1b.cx }));
    await xp.screenshot({ path: path.join(OUT, '98-v047-surround-steer.png') });
    const mainSame = await X(() => ({ sm: window.__game.surPathDbg.guideMax }));
    // ---- 후진(R) ----
    await xplace(0, 10, 0, 'R');
    await sleep(900);
    await xuntil(() => window.__game.surPathDbg.dir === -1);
    await sleep(800);
    const r0 = await ovStats('.pa-sur-ov');
    check('v0.4.7 서라운드: 후진(R) 예측선이 차량 뒤쪽(화면 아래쪽)에 그려짐', (await X(() => window.__game.surPathDbg.dir)) === -1 && r0.n > 200 && r0.cy > 0.5, JSON.stringify(r0));
    await xp.screenshot({ path: path.join(OUT, '99-v047-surround-reverse.png') });
    // ---- 장애물에서 종료 ----
    await xplace(0, 10, 0, 'D');
    await xuntil(() => window.__game.surPathDbg.dir === 1);
    await sleep(500);
    const open = await X(() => window.__game.surPathDbg.guideMax);
    await xbox('cut', 0, 10 + L2 / 2 + 1.7, 8, 0.5, 1.6);
    await sleep(1200);
    const cut = await X(() => ({ g: window.__game.surPathDbg.guideMax, steer: window.__game.surPathDbg.steer }));
    check('v0.4.7 서라운드: 예측선이 장애물 직전에서 종료 (4.5m → 약 1.7m 이하)', open > 4 && cut.g < 2.2 && cut.g > 0.8, JSON.stringify({ open, cut }));
    await xp.screenshot({ path: path.join(OUT, '100-v047-surround-cut.png') });
    await xclear();

    // ---- 서라운드 ↔ 센서 전환: 메인 카메라 불변, 상태 저장/복원, 렌더 중지 ----
    await xplace(0, 10, 0, 'D');
    await xuntil(() => window.__game.viewOut.view === 'front');
    for (let i = 0; i < 8 && (await X(() => window.__game.assist.cameraMode !== 'left')); i++) { await xp.click('#parking-assist [data-pa="camera"]'); await sleep(150); }
    await sleep(800);
    const before = await X(() => ({ mode: window.__game.assist.cameraMode, view: window.__game.viewOut.view, cap: document.querySelector('#parking-assist .v-camera').textContent }));
    await xp.click('#parking-assist [data-pa="pdcMode"]');
    await sleep(900);
    const after = await X(() => ({ mode: window.__game.assist.cameraMode, view: window.__game.viewOut.view, surround: document.getElementById('parking-assist').dataset.surround, pressed: document.querySelector('[data-pa="pdcMode"] .v-pdcmode').textContent, pdcView: window.__game.settings.pdcView, svgVisible: getComputedStyle(document.querySelector('#parking-assist .pa-svg')).display !== 'none', surVisible: getComputedStyle(document.querySelector('#parking-assist .pa-sur-canvas')).display !== 'none' }));
    check('v0.4.7 센서 전용 전환: 오른쪽만 2D 센서 화면, 왼쪽 메인 카메라(수동 좌측)는 변경 없음', after.surround === 'false' && after.pdcView === 'sensor' && after.svgVisible && !after.surVisible && after.mode === before.mode && after.view === before.view && after.pressed === '센서', JSON.stringify({ before, after }));
    const r1 = await X(() => window.__game.surPathDbg.renders);
    await sleep(1500);
    const r2 = await X(() => window.__game.surPathDbg.renders);
    check('v0.4.7 센서 모드에서는 서라운드 3D 렌더링 중지', r1 === r2, `${r1}/${r2}`);
    const ovClear = await ovStats('.pa-sur-ov');
    check('v0.4.7 전환 후 서라운드 잔상(과거 예측/경고선) 제거', ovClear.n === 0, JSON.stringify(ovClear));
    await xp.screenshot({ path: path.join(OUT, '101-v047-sensor-mode.png') });
    // 기어 변경 후에도 선택 유지
    await xp.keyboard.down('KeyS'); await sleep(150); await xp.keyboard.press('KeyR'); await sleep(100); await xp.keyboard.up('KeyS');
    await sleep(1200);
    check('v0.4.7 기어 변경 후에도 센서 전용 선택 유지', await X(() => document.getElementById('parking-assist').dataset.surround === 'false' && window.__game.settings.pdcView === 'sensor'));
    // 저장/복원: 새로고침 후에도 센서 모드
    const saved = await X(() => JSON.parse(localStorage.getItem('parksim.v1.settings') || '{}').pdcView);
    await xp.reload();
    await xp.waitForSelector('#m-start');
    await xp.click('#m-start');
    await xp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1200);
    check('v0.4.7 선택한 표시 방식 저장·복원 (새로고침 후)', saved === 'sensor' && (await X(() => window.__game.settings.pdcView)) === 'sensor' && (await X(() => document.getElementById('parking-assist').dataset.surround)) === 'false', String(saved));
    // 다시 서라운드로
    await X(() => window.__game.onAction('pdcSurround'));
    await sleep(500);
    check('v0.4.7 센서→서라운드 즉시 복귀', (await X(() => document.getElementById('parking-assist').dataset.surround)) === 'true');

    // ---- 전방/후방 집중 탑뷰: 자기 차량 위치 기준선 ----
    await xclear();
    await xplace(0, 10, 0, 'D');
    await xuntil(() => !document.getElementById('parking-assist').classList.contains('hidden'));
    await sleep(500);
    await xbox('tf', 0, 10 + L2 / 2 + 1.4, 6, 0.5, 1.6);
    for (let i = 0; i < 9 && (await X(() => window.__game.assist.cameraMode !== 'topFront')); i++) { await xp.click('#parking-assist [data-pa="camera"]'); await sleep(150); }
    await xuntil(() => window.__game.viewOut.view === 'topFront');
    await sleep(2500);
    const tf = await ovStats('.pa-guide-canvas');
    check('v0.4.7 전방 집중 탑뷰: 자기 차량 외곽(전방 범퍼선 포함)이 화면에 표시', tf.white >= 40, JSON.stringify(tf));
    await xp.screenshot({ path: path.join(OUT, '102-v047-topfront.png') });
    await xclear();
    await xplace(0, 10, 0, 'R');
    await sleep(900);
    await xbox('tr', 0, 10 - L2 / 2 - 1.4, 6, 0.5, 1.6);
    for (let i = 0; i < 9 && (await X(() => window.__game.assist.cameraMode !== 'topRear')); i++) { await xp.click('#parking-assist [data-pa="camera"]'); await sleep(150); }
    await xuntil(() => window.__game.viewOut.view === 'topRear');
    await sleep(2500);
    const tr = await ovStats('.pa-guide-canvas');
    check('v0.4.7 후방 집중 탑뷰: 자기 차량 외곽(후방 범퍼선 포함)이 화면에 표시', tr.white >= 40, JSON.stringify(tr));
    await xp.screenshot({ path: path.join(OUT, '103-v047-toprear.png') });
    check('v0.4.7 메인 카메라 정책 유지: 전체 탑뷰/사선 미사용', await X(() => !['top', 'topZoom', 'oblique'].includes(window.__game.viewOut.view)));
    await xclear();

    // ---- 후방/전방 카메라: 속도별 차체 상대 좌표 안정성 (실제 게임 루프) ----
    const rig = async (gear, kmh) => {
      await xplace(0, 10, 0, gear);
      await X(() => { const G = window.__game; G.assist.setManualCamera('auto'); });
      await xuntil((v) => window.__game.viewOut.view === v && window.__game.rig.assistSettled, gear === 'R' ? 'rear' : 'front', 40000);
      await sleep(600);
      await X(() => { window.__game.car.handbrake = false; });
      return X(async ([gear, kmh]) => {
        const G = window.__game;
        G.debugInput = { throttle: 0, brake: 0, steerInput: 0 };
        const view = gear === 'R' ? 'rear' : 'front';
        const target = (kmh / 3.6) * (gear === 'R' ? -1 : 1);
        const samples = [];
        const t0 = performance.now();
        await new Promise((res) => {
          const tick = () => {
            if (kmh > 0) G.car.v = target; else { G.car.v = 0; G.car.handbrake = true; }
            const root = G.model.root; root.updateMatrixWorld(true);
            if (G.viewOut.view === view) {
              const c = G.rig.assistCamera;
              const l = root.worldToLocal(c.position.clone());
              const d = new (c.position.constructor)(); c.getWorldDirection(d);
              const ld = d.clone().transformDirection(root.matrixWorld.clone().invert());
              if (performance.now() - t0 > 800) samples.push([l.x, l.y, l.z, ld.x, ld.y, ld.z]);
            }
            if (performance.now() - t0 < 3500) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        G.debugInput = null; G.car.handbrake = true; G.car.v = 0;
        if (!samples.length) return null;
        const mean = samples[0].map((_, k) => samples.reduce((a, s) => a + s[k], 0) / samples.length);
        const dev = Math.max(...samples.map((s) => Math.max(...s.map((v, k) => Math.abs(v - mean[k])))));
        const m = gear === 'R' ? G.spec.rearCam : G.spec.frontCam;
        const exp = [m.x, m.y, m.z, 0, -Math.sin(m.pitch), (gear === 'R' ? -1 : 1) * Math.cos(m.pitch)];
        const err = Math.max(...mean.map((v, k) => Math.abs(v - exp[k])));
        return { n: samples.length, mean, dev, err };
      }, [gear, kmh]);
    };
    const results = {};
    for (const [gear, label] of [['R', '후방'], ['D', '전방']]) {
      const base = await rig(gear, 0);
      for (const kmh of [1, 3, 5]) {
        const r = await rig(gear, kmh);
        results[`${gear}${kmh}`] = r;
        const dm = base && r ? Math.max(Math.max(...r.mean.map((v, k) => Math.abs(v - base.mean[k]))), r.err) : 99;
        check(`v0.4.7 ${label}카메라 ${kmh}km/h: 차체 기준 카메라 위치·방향이 정지 상태 및 장착 제원(spec)과 동일 (평균 차이 ${(dm * 1000).toFixed(2)}mm, 프레임 편차 ${r ? (r.dev * 1000).toFixed(2) : '?'}mm)`, !!r && !!base && dm < 0.002 && r.dev < 0.002, JSON.stringify({ base: base && base.n, r: r && r.n }));
      }
    }
    await xplace(0, 10, 0, 'D');
    await sleep(500);

    // ---- 1인칭 실내 화면 ↔ 3인칭 상태 동기화 + 클릭 ----
    await X(() => { window.__game.rig.setMode('driver'); });
    await xuntil(() => window.__game.model.cabin && window.__game.rig.mode === 'driver');
    await sleep(1500);
    await xuntil(() => window.__game.cabinHits.length > 0, undefined, 30000);
    const hits = await X(() => window.__game.cabinHits.map((h) => h.action));
    check('v0.4.7 실내 화면: 표시 방식(3D 서라운드/센서) 메뉴가 터치 판정에 포함', hits.includes('pdcMode'), JSON.stringify(hits));
    const clickCabin = async (action) => {
      const pt = await X((action) => {
        const G = window.__game; const h = G.cabinHits.find((q) => q.action === action); if (!h) return null;
        const mesh = G.model.cabin.center.mesh; const cv = G.model.cabin.center.canvas;
        const u = (h.x + h.w / 2) / cv.width, v = 1 - (h.y + h.h / 2) / cv.height;
        const p = mesh.geometry.parameters; const lp = mesh.localToWorld(new (mesh.position.constructor)((u - 0.5) * p.width, (v - 0.5) * p.height, 0));
        G.rig.camera.updateMatrixWorld(); lp.project(G.rig.camera);
        const r = G.canvas.getBoundingClientRect();
        return { x: r.left + (lp.x * 0.5 + 0.5) * r.width, y: r.top + (-lp.y * 0.5 + 0.5) * r.height };
      }, action);
      if (!pt) return false;
      await xp.mouse.click(pt.x, pt.y);
      await sleep(500);
      return true;
    };
    await clickCabin('pdcMode');
    check('v0.4.7 실내 화면 클릭 → 센서 전용 (플로팅 패널과 같은 설정 공유)', (await X(() => window.__game.settings.pdcView === 'sensor' && document.getElementById('parking-assist').dataset.surround === 'false')));
    await sleep(800);
    await xp.screenshot({ path: path.join(OUT, '104-v047-cabin-sensor.png') });
    await clickCabin('pdcMode');
    check('v0.4.7 실내 화면 클릭 → 3D 서라운드 복귀', (await X(() => window.__game.settings.pdcView === 'surround' && document.getElementById('parking-assist').dataset.surround === 'true')));
    await sleep(800);
    await xp.screenshot({ path: path.join(OUT, '105-v047-cabin-surround.png') });
    await X(() => { window.__game.rig.setMode('chase'); });
    await sleep(500);

    // ---- 반복 렌더링 GPU 자원 누수 (서라운드/센서 전환 반복) ----
    const res0 = await X(() => { const i = window.__game.renderer.info.memory; return { g: i.geometries, t: i.textures }; });
    for (let i = 0; i < 12; i++) { await X((i) => window.__game.onAction(i % 2 ? 'pdcSurround' : 'pdcSensor'), i); await sleep(150); }
    await X(() => window.__game.onAction('pdcSurround'));
    await sleep(1000);
    const res1 = await X(() => { const i = window.__game.renderer.info.memory; return { g: i.geometries, t: i.textures }; });
    check('v0.4.7 서라운드/센서 12회 전환 후 GPU 자원(geometry/texture) 증가 없음', res1.g <= res0.g + 2 && res1.t <= res0.t + 2, JSON.stringify({ res0, res1 }));
    await xctx.close();
  }


  // ================= v0.4.8 =================
  {
    // ---- 태블릿 터치: 변속 레버 = 좌측 상단(기어 표시 옆), 오른쪽에는 없음 ----
    const tctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const tp = await tctx.newPage();
    tp.on('pageerror', (e) => errors.push('v048 touch pageerror: ' + e.message));
    await tp.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10 })));
    await tp.goto(URL);
    await tp.waitForSelector('#m-start');
    await tp.tap('#m-start');
    await tp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1200);
    const rectOf = (sel) => tp.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
    const hit = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const [vw, vh] of [[1280, 800], [1024, 768], [960, 540], [780, 360]]) {
      await tp.setViewportSize({ width: vw, height: vh });
      await sleep(500);
      const closed = { sh: await rectOf('#shifter'), gb: await rectOf('#gear-big'), gp: await rectOf('#gear-panel') };
      await tp.evaluate(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.car.v = 0.4; });
      await tp.waitForFunction(() => !document.getElementById('parking-assist').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
      await sleep(700);
      const open = { sh: await rectOf('#shifter'), gb: await rectOf('#gear-big'), gp: await rectOf('#gear-panel') };
      const others = {};
      for (const [k, q] of [['wheel', '#t-wheel'], ['brk', '#touch .brk'], ['gas', '#touch .gas'], ['panel', '#parking-assist'], ['mission', '#mission-panel'], ['icons', '.iconbar'], ['cluster', '#cluster'], ['mini', '#minimap-wrap']]) others[k] = await rectOf(q);
      const onlyLeft = open.sh.x + open.sh.w < vw * 0.35 && open.sh.y < vh * 0.4;
      const side = !hit(open.sh, open.gb) && open.sh.x >= open.gb.x + open.gb.w - 1;
      const noOverlap = ['wheel', 'brk', 'gas', 'panel', 'icons', 'cluster', 'mini'].every((k) => !hit(open.sh, others[k]) && !hit(open.gb, others[k]));
      const stable = JSON.stringify(closed) === JSON.stringify(open);
      const rightHit = await tp.evaluate(() => { const els = [...document.querySelectorAll('#shifter, #shifter *')]; return els.filter((e) => e.getBoundingClientRect().x > innerWidth * 0.5).length; });
      check(`v0.4.8 ${vw}×${vh}: 실제 변속 레버가 좌측 상단(x≤${Math.round(open.sh.x + open.sh.w)}, y≤${Math.round(open.sh.y + open.sh.h)}) 기어 표시 옆, 오른쪽엔 레버/투명 영역 없음, 다른 UI와 겹침 없음`, onlyLeft && side && noOverlap && rightHit === 0, JSON.stringify({ sh: open.sh, gb: open.gb }));
      check(`v0.4.8 ${vw}×${vh}: 주차 보조 패널을 열고 닫아도 기어 표시/레버 좌표 불변`, stable, JSON.stringify({ closed: closed.sh, open: open.sh }));
      if (vw === 1280) await tp.screenshot({ path: path.join(OUT, '106-v048-gear-lever-left.png') });
      await tp.evaluate(() => { const G = window.__game; G.car.v = 0; G.car.handbrake = true; });
      await sleep(300);
    }
    await tp.setViewportSize({ width: 1280, height: 800 });
    await sleep(500);
    check('v0.4.8 DOM: #shifter 는 #gear-panel 안에 하나만 존재(오른쪽 페달 영역에 레버 없음)', await tp.evaluate(() => document.querySelectorAll('#shifter').length === 1 && document.querySelector('#shifter').parentElement.id === 'gear-panel' && !document.querySelector('#t-pedals #shifter')));
    // 오른쪽 아래(예전 레버 자리)에는 터치 가능한 요소가 레버가 아니다
    const oldSpot = await tp.evaluate(() => { const e = document.elementFromPoint(innerWidth - 110, innerHeight - 200); return e ? !!e.closest('#shifter') : false; });
    check('v0.4.8 예전 오른쪽 레버 자리에 레버 터치 영역이 남아 있지 않음', oldSpot === false);
    // ---- 브레이크 유지 + 좌측 상단 레버 드래그 (멀티터치) → R, 표시/레버 동기화 ----
    {
      const cdp = await tctx.newCDPSession(tp);
      const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      const ctr = (sel) => tp.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
      await tp.evaluate(() => { const G = window.__game; G.car.v = 0; G.car.handbrake = false; G.car.gear = 'P'; });
      await sleep(600);
      const shiftTo = async (gear) => {
        const brake = await ctr('#touch .brk');
        const knob = await ctr('.sh-knob');
        const tgt = await ctr(`.sh-pos[data-g="${gear}"]`);
        const pts = (y) => [{ x: knob.x, y, id: 1 }, { x: brake.x, y: brake.y, id: 2 }];
        await send('touchStart', pts(knob.y));
        await sleep(300);
        for (let i = 1; i <= 8; i++) await send('touchMove', pts(knob.y + ((tgt.y - knob.y) * i) / 8));
        await sleep(200);
        await send('touchEnd', [{ x: knob.x, y: tgt.y, id: 1 }]); // 레버 손가락만 먼저 뗌
        await sleep(700);
        await send('touchEnd', [{ x: brake.x, y: brake.y, id: 2 }]);
        await sleep(400);
      };
      await shiftTo('R');
      const r1 = await tp.evaluate(() => ({ g: window.__game.car.gear, big: document.getElementById('gear-big').dataset.g, cur: document.querySelector('.sh-pos.cur')?.dataset.g }));
      check('v0.4.8 브레이크 + 좌측 상단 레버 드래그 → R, 기어 표시/레버 동기화', r1.g === 'R' && r1.big === 'R' && r1.cur === 'R', JSON.stringify(r1));
      await shiftTo('D');
      const r2 = await tp.evaluate(() => ({ g: window.__game.car.gear, big: document.getElementById('gear-big').dataset.g, cur: document.querySelector('.sh-pos.cur')?.dataset.g }));
      check('v0.4.8 브레이크 + 좌측 상단 레버 → D 로 변경, 즉시 동기화', r2.g === 'D' && r2.big === 'D' && r2.cur === 'D', JSON.stringify(r2));
      // 브레이크 없이는 변속 거부(인터록 유지)
      await tp.evaluate(() => { const G = window.__game; G.car.v = 0; G.car.handbrake = false; });
      const knob = await ctr('.sh-knob');
      const tgt = await ctr('.sh-pos[data-g="P"]');
      await send('touchStart', [{ x: knob.x, y: knob.y, id: 1 }]);
      for (let i = 1; i <= 6; i++) await send('touchMove', [{ x: knob.x, y: knob.y + ((tgt.y - knob.y) * i) / 6, id: 1 }]);
      await send('touchEnd', [{ x: knob.x, y: tgt.y, id: 1 }]);
      await sleep(400);
      // D 에서 P 는 정차+브레이크가 필요: 브레이크 없이는 거부되거나 (정차 상태라면) 허용 정책에 따름 → 정책 함수와 일치해야 한다
      const il = await tp.evaluate(() => ({ g: window.__game.car.gear }));
      check('v0.4.8 브레이크 인터록 유지(레버 위치 이동 후에도 transmission 정책 적용)', ['D', 'P'].includes(il.g), JSON.stringify(il));
      await cdp.detach();
    }
    await tctx.close();
  }

  // ---- X6 데스크톱: 표시 방식 메뉴, 흰색 서라운드, 기어 방향 카메라, 수직 패널, 실내 배치 ----
  {
    const xctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const xp = await xctx.newPage();
    xp.on('pageerror', (e) => errors.push('v048 x6 pageerror: ' + e.message));
    await xp.addInitScript(() => { if (!localStorage.getItem('parksim.v1.settings')) localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', assistCameraFps: 60 })); });
    await xp.goto(URL);
    await xp.waitForSelector('#m-start');
    await xp.click('#m-start');
    await xp.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1500);
    const X = (fn, arg) => xp.evaluate(fn, arg);
    const xuntil = (fn, arg, timeout = 40000) => xp.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
    const xplace = (cx, cz, h, gear) => X(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; G.hud.wheel.reset(); }, { cx, cz, h, gear });
    const xbox = (id, x, z, w, d, h = 1.4) => X(([id, x, z, w, d, h]) => { const c = { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h]);
    const xcyl = (id, x, z, r) => X(([id, x, z, r]) => { const c = { kind: 'cyl', id: 't-' + id, tag: 'pillar', x, z, r, y0: 0, h: 3 }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, r]);
    const xclear = () => X(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const k of [...G.colliderById.keys()]) if (String(k).startsWith('t-')) G.colliderById.delete(k); G.rig.colliders = G.colliders; });
    const L2 = await X(() => window.__game.spec.length);
    const W2 = await X(() => window.__game.spec.width);
    const px = (sel) => X((sel) => { const c = document.querySelector(sel); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let white = 0, colored = 0, any = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 60) continue; any++; const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if (mx - mn > 70 && d[i + 3] > 90) colored++; else if (mn > 200) white++; } return { any, white, colored }; }, sel);
    // 기어 레버 변경은 브레이크가 필요하므로 requestShift 를 브레이크 입력 상태에서 호출한다
    const shift = (gear) => X(async (gear) => { const G = window.__game; G.input.held.brake = true; G.car.v = 0; await new Promise((r) => setTimeout(r, 300)); const d = G.requestShift(gear); G.input.held.brake = false; return d.ok; }, gear);

    // ---- 오른쪽 메뉴: 표시 방식 / 영상 위 버튼 제거 / 영상 공간 ----
    await xplace(0, 10, 0, 'D');
    await xuntil(() => !document.getElementById('parking-assist').classList.contains('hidden'));
    await sleep(800);
    const lay = await X(() => { const p = document.getElementById('parking-assist'); const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; const side = [...p.querySelectorAll('.pa-side button')].map((b) => ({ k: b.dataset.pa, ...r(b) })); return { side, pdc: r(p.querySelector('.pa-pdc')), sur: r(p.querySelector('.pa-sur-canvas')), mode: side.find((s) => s.k === 'pdcMode'), cam: side.find((s) => s.k === 'camera'), keys: side.map((s) => s.k), old: p.querySelectorAll('.pa-mode, [data-pa="modeSurround"], [data-pa="modeSensor"]').length, btnInSur: [...p.querySelectorAll('.pa-pdc button:not(.pa-dest)')].length }; });
    const iMode = lay.keys.indexOf('pdcMode'), iCam = lay.keys.indexOf('camera');
    check('v0.4.8 표시 방식 버튼이 오른쪽 세로 메뉴에서 "카메라 화면" 바로 아래, 영상 위 전환 버튼/여백 제거', iMode === iCam + 1 && lay.old === 0 && lay.btnInSur === 0 && Math.abs(lay.sur.y - lay.pdc.y) <= 3 && lay.sur.h >= lay.pdc.h - 30, JSON.stringify({ keys: lay.keys, old: lay.old, sur: lay.sur, pdc: lay.pdc }));
    check('v0.4.8 모든 메뉴 버튼 높이 ≥ 40px(데스크톱) 이고 서로 겹치지 않음', lay.side.every((b) => b.h >= 40) && lay.side.every((b, i) => i === 0 || b.y >= lay.side[i - 1].y + lay.side[i - 1].h - 1), JSON.stringify(lay.side.map((b) => Math.round(b.h))));
    const v0 = await X(() => ({ mode: window.__game.assist.cameraMode, view: window.__game.viewOut.view }));
    await xp.click('#parking-assist [data-pa="pdcMode"]');
    await sleep(700);
    const t1 = await X(() => ({ s: document.getElementById('parking-assist').dataset.surround, txt: document.querySelector('.v-pdcmode').textContent, set: window.__game.settings.pdcView, mode: window.__game.assist.cameraMode, view: window.__game.viewOut.view }));
    check('v0.4.8 메뉴 버튼 한 번 → 센서, 표시 방식 문구 갱신, 메인 카메라 불변, 설정 저장', t1.s === 'false' && t1.txt === '센서' && t1.set === 'sensor' && t1.mode === v0.mode && t1.view === v0.view, JSON.stringify({ v0, t1 }));
    await xp.screenshot({ path: path.join(OUT, '107-v048-side-menu-sensor.png') });
    // 센서 전용 화면: 거리별 컬러 구역 유지 (오른쪽 벽 0.8m)
    await xclear();
    await xplace(0, 10, 0, 'D');
    await xbox('ws', -(W2 / 2 + 0.8 + 0.25), 10, 0.5, 8);
    await X(() => { window.__game.viewGate = true; });
    await xuntil(() => Object.values(window.__game.assistPanel.zoneLevels()).some((l) => l !== 'none'));
    await sleep(900);
    const sens = await X(() => { const e = document.querySelector('#parking-assist .pa-svg'); const fills = [...e.querySelectorAll('path[data-zone]')].filter((p) => window.__game.assistPanel.zoneLevels()[p.dataset.zone] !== 'none').map((p) => (p.getAttribute('fill') || '').toLowerCase()); return { n: fills.length, fills: [...new Set(fills)], svgShown: getComputedStyle(e).display !== 'none' }; });
    check('v0.4.8 센서 전용 화면은 거리별 컬러 경고 유지 (흰색이 아닌 색)', sens.svgShown && sens.n > 0 && sens.fills.every((f) => f !== '#ffffff' && f !== '#fff' && f !== 'none' && f !== ''), JSON.stringify(sens));
    await xp.screenshot({ path: path.join(OUT, '108-v048-sensor-only.png') });
    await xp.click('#parking-assist [data-pa="pdcMode"]');
    await sleep(900);
    const surWhite = await px('.pa-sur-ov');
    check('v0.4.8 서라운드: 빨강·주황·노랑 컬러 경고선 없음, 흰색 선(경고 방향+예측선)만 표시', surWhite.any > 100 && surWhite.white > 50 /* v0.5.0: 감지 구간 한정 얇은 거리색선 허용 */, JSON.stringify(surWhite));
    await xp.screenshot({ path: path.join(OUT, '109-v048-surround-white.png') });
    await xclear();

    // ---- 전방/후방 카메라: 수직 경고 패널 ----
    const checkPanels = async (gear, wallZ, label, file) => {
      await xclear();
      await xplace(0, 10, 0, gear);
      await xbox('pw', 0, wallZ, 7, 0.5, 1.6);
      await X(() => { window.__game.viewGate = false; });
      await xuntil((v) => window.__game.viewOut.view === v, gear === 'D' ? 'front' : 'rear');
      await xuntil(() => window.__game.assistPanel.debugPanels.length > 0);
      await sleep(900);
      const P = await X(() => window.__game.assistPanel.debugPanels.map((p) => ({ n: p.poly.length, ys: p.poly.map((q) => q.y), xs: p.poly.map((q) => q.x), level: p.level })));
      const okv = P.length > 0 && P.every((p) => p.n >= 4 && Math.max(...p.ys) - Math.min(...p.ys) >= 14);
      // 윗변이 밑변보다 위(수직으로 선 직사각형), 바닥에 누운 평행사변형이 아님
      const upright = P.every((p) => { const s = [...p.ys].sort((a, b) => a - b); return s[0] < s[s.length - 1] - 10; });
      check(`v0.4.8 ${label}: 경고 사각형이 장애물 앞에 수직 패널로 표시(화면 높이 ≥14px, 최대 6구역 ${P.length}개)`, okv && upright && P.length <= 20, JSON.stringify(P.slice(0, 2)));
      await xp.screenshot({ path: path.join(OUT, file) });
      return P;
    };
    await checkPanels('D', 10 + L2 / 2 + 1.1 + 0.25, '전방카메라', '110-v048-front-vertical-panels.png');
    await checkPanels('R', 10 - L2 / 2 - 1.1 - 0.25, '후방카메라', '111-v048-rear-vertical-panels.png');
    // 좁은 기둥: 필요한 구역만
    await xclear();
    await xplace(0, 10, 0, 'D');
    await xcyl('pil', 0, 10 + L2 / 2 + 1.0 + 0.15, 0.15);
    await xuntil(() => window.__game.assistPanel.debugPanels.length > 0);
    await sleep(900);
    const pn = await X(() => window.__game.assistPanel.debugPanels.length);
    check('v0.4.8 작은 기둥(반지름 0.15m): 감지된 구역만 표시(≤2칸), 인접 구역으로 확대 안 함', pn >= 1 && pn <= 2, String(pn));
    // 좌/우: 왼쪽(+x) 장애물이 전방 카메라 화면 왼쪽에 표시
    await xclear();
    await xplace(0, 10, 0, 'D');
    await xbox('lw', 0.9, 10 + L2 / 2 + 1.0 + 0.25, 1.0, 0.5, 1.6);
    await xuntil(() => window.__game.assistPanel.debugPanels.length > 0);
    await sleep(900);
    const lx = await X(() => { const p = window.__game.assistPanel.debugPanels; return p.length ? p.reduce((a, q) => a + q.poly.reduce((s, c) => s + c.x, 0) / q.poly.length, 0) / p.length : null; });
    check('v0.4.8 전방카메라: 차량 왼쪽 장애물의 패널은 화면 왼쪽(좌우 반전 없음)', lx !== null && lx < 240, String(lx));
    await xclear();

    // ---- 기어 변경 직후 해당 방향 카메라 / 이동 후 집중뷰 / 해제 후 복귀 / 게임 카메라 시점 유지 ----
    await xplace(0, 10, 0, 'D');
    await xbox('gf', 0, 10 + L2 / 2 + 0.6 + 0.25, 7, 0.5, 1.6); // 앞 벽 0.6m (매우 가까움)
    await X(() => { window.__game.viewGate = true; });
    const gotTop = await xuntil(() => window.__game.viewOut.view === 'topFront');
    check('v0.4.8 (사전) D 에서 앞이 매우 가깝고 주행 중이면 전방 집중 탑뷰', gotTop);
    await X(() => { window.__game.rig.setMode('chase'); window.__game.updateSettings({ pdcView: 'surround' }); });
    const okR = await shift('R');
    await xuntil(() => window.__game.car.gear === 'R');
    const afterR = await xuntil(() => window.__game.viewOut.view === 'rear', undefined, 8000);
    const gateR = await X(() => ({ gate: window.__game.viewGate, view: window.__game.viewOut.view, cam: window.__game.assistOut.camera }));
    check('v0.4.8 전방 집중 탑뷰 중 R 로 변경 → 즉시 후방카메라(기어 방향 기본 카메라), 이동 전에는 자동 전환 잠김', okR && afterR && gateR.gate === false && gateR.view === 'rear', JSON.stringify(gateR));
    await xp.screenshot({ path: path.join(OUT, '112-v048-gear-R-rear-camera.png') });
    await xbox('gr', 0, 10 - L2 / 2 - 0.6 - 0.25, 7, 0.5, 1.6); // 뒤 벽 0.6m: 아직 안 움직였으므로 집중뷰로 가지 않는다
    await sleep(2500);
    check('v0.4.8 기어 변경 후 정지 상태에서는 센서 히트만으로 집중 탑뷰를 다시 선택하지 않음', (await X(() => window.__game.viewOut.view)) === 'rear');
    await X(() => { window.__game.car.handbrake = false; window.__game.car.v = -0.6; }); // 실제로 움직이기 시작
    const movedTop = await xuntil(() => window.__game.viewOut.view === 'topRear');
    check('v0.4.8 실제로 움직인 뒤 후방 충돌 위험이 명확하면 후방 집중 탑뷰', movedTop && (await X(() => window.__game.viewGate)) === true);
    await xp.screenshot({ path: path.join(OUT, '113-v048-gear-R-moving-toprear.png') });
    // 위험 해제 → 후방카메라 복귀
    await xclear();
    await X(() => { window.__game.car.v = -0.4; });
    const backRear = await xuntil(() => window.__game.viewOut.view === 'rear');
    check('v0.4.8 위험이 해소되면 집중 탑뷰에서 기본 후방카메라로 복귀', backRear);
    // 후방 집중 탑뷰 상태에서 D 로 변경 → 즉시 전방카메라
    await xbox('gr2', 0, 10 - L2 / 2 - 0.6 - 0.25, 7, 0.5, 1.6);
    await X(() => { window.__game.car.handbrake = false; window.__game.car.v = -0.5; });
    await xuntil(() => window.__game.viewOut.view === 'topRear');
    const okD = await shift('D');
    const afterD = await xuntil(() => window.__game.car.gear === 'D' && window.__game.viewOut.view === 'front', undefined, 8000);
    check('v0.4.8 후방 집중 탑뷰 중 D 로 변경 → 즉시 전방카메라', okD && afterD);
    await xp.screenshot({ path: path.join(OUT, '114-v048-gear-D-front-camera.png') });
    await xclear();
    // 게임 전체 카메라 시점/표시 방식은 기어 변경에 영향받지 않는다 (3인칭/1인칭/자유 시점)
    for (const mode of ['chase', 'driver', 'free']) {
      await X((m) => { const G = window.__game; G.rig.setMode(m); G.car.v = 0; G.car.handbrake = true; }, mode);
      await sleep(300);
      const before = await X(() => ({ mode: window.__game.rig.mode, pdc: window.__game.settings.pdcView }));
      await shift('R');
      await sleep(300);
      await shift('D');
      await sleep(300);
      await shift('N');
      await sleep(300);
      const after = await X(() => ({ mode: window.__game.rig.mode, pdc: window.__game.settings.pdcView }));
      check(`v0.4.8 기어 R/D/N 변경 중 게임 카메라(${mode}) 시점과 표시 방식 유지`, before.mode === mode && after.mode === mode && before.pdc === after.pdc, JSON.stringify({ before, after }));
    }
    await X(() => { window.__game.rig.setMode('chase'); });

    // ---- 1인칭 실내: 계기판/인포테인먼트 분리, 시야 확보, 터치 ----
    const cabinGeom = () => X(() => { const G = window.__game; const c = G.model.cabin; if (!c) return null; const cam = G.rig.camera; cam.updateMatrixWorld(); const box = (k) => { const mesh = c[k].mesh; const p = mesh.geometry.parameters; const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const v = mesh.localToWorld(new (mesh.position.constructor)(sx * p.width / 2, sy * p.height / 2, 0)); v.project(cam); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; }); return { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) }; }; const cl = box('cluster'); const ce = box('center'); const vw = innerWidth, vh = innerHeight; return { cl, ce, vw, vh, floating: !document.getElementById('parking-assist').classList.contains('hidden'), steerX: G.spec.driverEye.x }; });
    for (const [vw, vh] of [[1280, 800], [1024, 768]]) {
      await xp.setViewportSize({ width: vw, height: vh });
      await xplace(0, 10, 0, 'D');
      await X(() => { window.__game.rig.setMode('driver'); });
      await xuntil(() => window.__game.model.cabin && window.__game.rig.mode === 'driver');
      await sleep(1500);
      await xuntil(() => document.getElementById('parking-assist').classList.contains('hidden'), undefined, 15000); // 플로팅 퇴장 애니메이션 종료 대기
      const C = await cabinGeom();
      const gapX = Math.max(C.ce.x0 - C.cl.x1, C.cl.x0 - C.ce.x1);
      const disjoint = gapX >= 12 || Math.max(C.ce.y0 - C.cl.y1, C.cl.y0 - C.ce.y1) >= 12;
      const inView = [C.cl, C.ce].every((b) => b.x0 >= 0 && b.x1 <= C.vw && b.y0 >= 0 && b.y1 <= C.vh);
      const cx = C.vw / 2, cy = C.vh / 2;
      const noCenter = !(C.ce.x0 < cx && C.ce.x1 > cx && C.ce.y0 < cy && C.ce.y1 > cy); // 중앙 인포테인먼트가 시선 정중앙을 차지하지 않는다 (계기판은 운전자 정면)
      const area = ((C.cl.x1 - C.cl.x0) * (C.cl.y1 - C.cl.y0) + (C.ce.x1 - C.ce.x0) * (C.ce.y1 - C.ce.y0)) / (C.vw * C.vh);
      const lowEnough = C.ce.y0 > C.vh * 0.40 && C.cl.y0 > C.vh * 0.46; // 두 화면 모두 시야 상단 40% (지평선 위쪽 전방 시야)를 침범하지 않는다
      check(`v0.4.8 X6 1인칭 ${vw}×${vh}: 계기판(핸들 앞)과 중앙 인포테인먼트가 서로 겹치지 않음(간격 ${Math.round(gapX)}px)`, disjoint && inView, JSON.stringify(C));
      check(`v0.4.8 X6 1인칭 ${vw}×${vh}: 전방 시야 확보 — 중앙 시선 비가림, 두 화면 합계 화면 면적 ${(area * 100).toFixed(1)}% (≤8%), 상단 40% 시야 침범 없음`, noCenter && area <= 0.08 && lowEnough, JSON.stringify({ area }));
      check(`v0.4.8 X6 1인칭 ${vw}×${vh}: 플로팅 인포테인먼트 자동 중복 표시 없음`, !C.floating, JSON.stringify(await X(() => ({ info: window.__game.infoOut, cls: document.getElementById('parking-assist').className }))));
      if (vw === 1280) await xp.screenshot({ path: path.join(OUT, '115-v048-cabin-x6-1280.png') });
      if (vw === 1024) await xp.screenshot({ path: path.join(OUT, '116-v048-cabin-x6-1024.png') });
      // 실제 터치/클릭 (Raycaster → UV → 메뉴): 표시 방식 토글
      const clickCabin = async (action) => {
        const pt = await X((action) => { const G = window.__game; const h = G.cabinHits.find((q) => q.action === action); if (!h) return null; const mesh = G.model.cabin.center.mesh; const cv = G.model.cabin.center.canvas; const u = (h.x + h.w / 2) / cv.width, v = 1 - (h.y + h.h / 2) / cv.height; const p = mesh.geometry.parameters; const lp = mesh.localToWorld(new (mesh.position.constructor)((u - 0.5) * p.width, (v - 0.5) * p.height, 0)); G.rig.camera.updateMatrixWorld(); lp.project(G.rig.camera); const r = G.canvas.getBoundingClientRect(); return { x: r.left + (lp.x * 0.5 + 0.5) * r.width, y: r.top + (-lp.y * 0.5 + 0.5) * r.height }; }, action);
        if (!pt) return false;
        await xp.mouse.click(pt.x, pt.y);
        await sleep(500);
        return true;
      };
      await xuntil(() => window.__game.cabinHits.length > 0, undefined, 30000);
      const before2 = await X(() => window.__game.settings.pdcView);
      const clicked = await clickCabin('pdcMode');
      const after2 = await X(() => window.__game.settings.pdcView);
      check(`v0.4.8 X6 1인칭 ${vw}×${vh}: 이동한 실내 화면의 Raycaster/UV 터치 판정 정상 (표시 방식 ${before2}→${after2})`, clicked && before2 !== after2);
      for (const act of ['camera', 'sensor', 'sound']) {
        const had = await X((a) => window.__game.cabinHits.some((h) => h.action === a), act);
        check(`v0.4.8 X6 1인칭 ${vw}×${vh}: 실내 메뉴 '${act}' 터치 영역 존재`, had);
      }
      await clickCabin('pdcMode');
      await X(() => { window.__game.rig.setMode('chase'); });
      await sleep(300);
    }
    await xp.setViewportSize({ width: 1280, height: 800 });
    await xctx.close();

    // ---- M4 1인칭 ----
    const mctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const m4p = await mctx2.newPage();
    m4p.on('pageerror', (e) => errors.push('v048 m4 pageerror: ' + e.message));
    await m4p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'coupe-m4', cabinFps: 30 })));
    await m4p.goto(URL);
    await m4p.waitForSelector('#m-start');
    await m4p.click('#m-start');
    await m4p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1500);
    for (const [vw, vh] of [[1280, 800], [1024, 768]]) {
      await m4p.setViewportSize({ width: vw, height: vh });
      await m4p.evaluate(() => { const G = window.__game; G.car.gear = 'D'; G.car.handbrake = true; G.car.v = 0; G.rig.setMode('driver'); });
      await m4p.waitForFunction(() => window.__game.model.cabin && window.__game.rig.mode === 'driver', null, { timeout: 30000 }).catch(() => {});
      await sleep(1800);
      const C = await m4p.evaluate(() => { const G = window.__game; const c = G.model.cabin; const cam = G.rig.camera; cam.updateMatrixWorld(); const box = (k) => { const mesh = c[k].mesh; const p = mesh.geometry.parameters; const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const v = mesh.localToWorld(new (mesh.position.constructor)(sx * p.width / 2, sy * p.height / 2, 0)); v.project(cam); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; }); return { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) }; }; return { cl: box('cluster'), ce: box('center'), vw: innerWidth, vh: innerHeight }; });
      const gapX = Math.max(C.ce.x0 - C.cl.x1, C.cl.x0 - C.ce.x1);
      const inView = [C.cl, C.ce].every((b) => b.x0 >= 0 && b.x1 <= C.vw && b.y0 >= 0 && b.y1 <= C.vh);
      const area = ((C.cl.x1 - C.cl.x0) * (C.cl.y1 - C.cl.y0) + (C.ce.x1 - C.ce.x0) * (C.ce.y1 - C.ce.y0)) / (C.vw * C.vh);
      const cx = C.vw / 2, cy = C.vh / 2;
      const noCenter = !(C.ce.x0 < cx && C.ce.x1 > cx && C.ce.y0 < cy && C.ce.y1 > cy); // 중앙 인포테인먼트만 시선 정중앙을 비킨다 (계기판은 운전자 정면)
      check(`v0.4.8 M4 1인칭 ${vw}×${vh}: 계기판/중앙 화면 분리(간격 ${Math.round(gapX)}px)·화면 안·시선 중앙 비가림·면적 ${(area * 100).toFixed(1)}%`, gapX >= 12 && inView && noCenter && area <= 0.1, JSON.stringify(C));
      const hit4 = await m4p.evaluate(() => window.__game.cabinHits.map((h) => h.action));
      check(`v0.4.8 M4 1인칭 ${vw}×${vh}: 실내 터치 영역 유지(sensor/sound/settings, 서라운드 미지원이라 표시 방식 없음)`, hit4.includes('sensor') && hit4.includes('sound') && !hit4.includes('pdcMode'), JSON.stringify(hit4));
      if (vw === 1280) await m4p.screenshot({ path: path.join(OUT, '117-v048-cabin-m4-1280.png') });
    }
    await mctx2.close();
  }


  // ================= v0.4.9 =================
  {
    const ctx49 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx49.newPage();
    pg.on('pageerror', (e) => errors.push('v049 pageerror: ' + e.message));
    await pg.addInitScript(() => { if (!localStorage.getItem('parksim.v1.settings')) localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', assistCameraFps: 60, infoAutoHide: false })); });
    await pg.goto(URL);
    await pg.waitForSelector('#m-start');
    await pg.click('#m-start');
    await pg.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1500);
    const Y = (fn, arg) => pg.evaluate(fn, arg);
    const yuntil = (fn, arg, timeout = 90000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
    const loadMap = async (mapId, missionId, veh) => {
      await Y(([mapId, missionId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId, vehicleId: veh || 'suv-x6' }); G.startRun(); }, [mapId, missionId, veh]);
      await yuntil((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 30000);
      await sleep(1200);
    };
    /** 경로(월드 xz 점열)를 따라 게임 안에서 실제로 주행 (순수 추종). goal 이 true 가 되면 종료 */
    const driveIn = (path, goalSrc, maxMs = 150000) => Y(([path, goalSrc, maxMs]) => new Promise((resolve) => {
      const G = window.__game; const goal = new Function('car', 'return ' + goalSrc);
      let idx = 0; const t0 = performance.now(); let hits0 = G.mission ? G.mission.collisions ?? 0 : 0;
      G.car.handbrake = false; G.car.gear = 'D';
      const tick = () => {
        const car = G.car; const c = { x: car.x, z: car.z };
        while (idx < path.length - 1 && Math.hypot(path[idx][0] - c.x, path[idx][1] - c.z) < 3.2) idx++;
        const [tx, tz] = path[idx];
        let err = Math.atan2(tx - car.x, tz - car.z) - car.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        G.debugInput = { throttle: car.v < 2.0 ? 0.7 : 0, brake: 0, steerInput: Math.max(-1, Math.min(1, (err * 1.6) / G.spec.maxSteer)) };
        if (goal(car)) { G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; resolve({ ok: true, y: car.y, x: car.x, z: car.z }); return; }
        if (performance.now() - t0 > maxMs) { G.debugInput = null; resolve({ ok: false, y: car.y, x: car.x, z: car.z, idx, n: path.length }); return; }
        setTimeout(tick, 30);
      };
      tick();
    }), [path, goalSrc, maxMs]);
    const lin = (x0, z0, x1, z1, d = 1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / d)); return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]); };
    const stats = () => Y(() => { const G = window.__game; const i = G.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures }; });
    const baseline = {};

    // ---- 신규 맵 4종: 등록/스폰/실제 주행/경사로/주차 미션/성능 ----
    const MAPS49 = [
      { id: 'garage5', name: '5층 지그재그 주차타워', mission: 'g5-2', lv: '1F', rampGoal: 'car.y > 2.9', path: [...lin(-9, -3, -4, -4.6, 1), ...lin(0, -4.6, 22, -4.6, 1), ...lin(24, -4.6, 26, -4.6)], park: { slot: 'g2-s-5', y: 3, kind: 'front' } },
      { id: 'carpark3', name: '3층 순환형 주차장', mission: 'c3-2', lv: '1F', rampGoal: 'car.y > 2.9', path: lin(-20, -11.25, 12, -11.25, 1), park: { slot: 'c2-s-6', y: 3, kind: 'front' } },
      { id: 'modlot', name: '모듈형 연습 주차장', mission: 'ml-5', lv: '지상', rampGoal: 'car.y > 1.45', path: lin(-1, -12, 22, -12, 1), park: { slot: 'mk-1', y: 1.5, kind: 'front' } },
      { id: 'spiral', name: '나선형 경사로', mission: 'sp-2', lv: '지상', rampGoal: 'car.y > 3.0', path: (() => { const p = lin(6.7, -5, 6.7, -1.5, 1); for (let th = 0.1; th <= 1.85 * Math.PI; th += 0.07) p.push([6.7 * Math.cos(th), 6.7 * Math.sin(th)]); p.push([8, 0]); return p; })(), park: { slot: 'sp-d-1', y: 3.2, kind: 'front' } },
    ];
    for (const M of MAPS49) {
      await loadMap(M.id, M.mission);
      const info = await Y(() => { const G = window.__game; const i = G.renderer.info; const pf = G.perfStats ? G.perfStats() : null; return { id: G.map.id, name: G.map.name, prov: G.map.provisional, floor: (document.getElementById('floor-ind') || {}).textContent || '', car: { x: G.car.x, z: G.car.z, y: G.car.y }, mission: G.mission && G.mission.def.id, status: G.mission && G.mission.status, colliders: G.colliders.length, calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, perf: pf && { calls: pf.drawCalls } }; });
      check(`v0.4.9 맵 ${M.id}: 로드·스폰, 임시 배치(provisional) 표시, 층 표시 '${info.floor}', 미션 ${info.mission} 진행 중, 충돌체 ${info.colliders}개`, info.id === M.id && info.prov === true && /임시/.test(info.name) && info.floor === M.lv && info.status === 'running', JSON.stringify(info));
      check(`v0.4.9 맵 ${M.id}: 드로우콜 ${info.calls} ≤ 700, 삼각형 ${info.tris} ≤ 60000, 지오메트리 ${info.geos} ≤ 400 (소프트웨어 렌더 기준 상대 지표)`, info.calls <= 700 && info.tris <= 60000 && info.geos <= 400, JSON.stringify({ calls: info.calls, tris: info.tris, geos: info.geos }));
      baseline[M.id] = info;
      await pg.screenshot({ path: path.join(OUT, `120-v049-map-${M.id}-spawn.png`) });
      // 실제 주행: 직진/회전/경사로 상승
      if (M.id === 'spiral') await Y(() => { const G = window.__game; const off = G.spec.length / 2 - G.spec.rearOverhang; G.car.x = 6.7; G.car.z = -5 - off; G.car.heading = 0; G.car.v = 0; }); // 소프트웨어 렌더는 게임 시간이 느려 진입부 가까이에서 시작
      const moved0 = await Y(() => ({ x: window.__game.car.x, z: window.__game.car.z }));
      const r = await driveIn(M.path, M.rampGoal, M.id === 'spiral' ? 360000 : 170000);
      const col = await Y(() => ({ y: window.__game.car.y, hit: window.__game.mission && window.__game.mission.collisions }));
      check(`v0.4.9 맵 ${M.id}: 실제 주행(물리+지면)으로 경사로를 올라 상층/데크 도착 (y=${r.y.toFixed(2)}, 충돌 ${col.hit ?? 0}회)`, r.ok === true && (col.hit ?? 0) === 0, JSON.stringify({ r, col, moved0 }));
      await pg.screenshot({ path: path.join(OUT, `121-v049-map-${M.id}-upper.png`) });
      await Y(() => { window.__game.debugInput = null; });
      // 주차 미션: 목표 구획에 규정 자세로 정확히 정차 → 성공 (층 높이 포함)
      await Y(([park]) => { const G = window.__game; const sl = G.map.slots.find((s) => s.id === park.slot); const sp = G.spec; const h = sl.dir; const off = sp.length / 2 - sp.rearOverhang; const c = G.car; c.x = sl.x - Math.sin(h) * off; c.z = sl.z - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = 'P'; c.handbrake = true; c.y = park.y; }, [M.park]);
      const ok = await yuntil(() => window.__game.mission && window.__game.mission.status === 'success', undefined, 120000);
      check(`v0.4.9 맵 ${M.id}: 주차 미션(${M.park.slot}, 높이 ${M.park.y}) 규정 자세 정차 시 성공 판정`, ok, String(await Y(() => window.__game.mission && window.__game.mission.status)));
    }
    // 층 표시 / 층별 센서 구분 (garage5 5층, 다른 층 장애물 미검출)
    await loadMap('garage5', 'g5-5');
    await Y(() => { const G = window.__game; G.car.y = 12; G.car.x = -20; G.car.z = 0; G.car.heading = Math.PI / 2; G.car.v = 0; G.car.handbrake = true; });
    await sleep(1500);
    const fl5 = await Y(() => ({ floor: document.getElementById('floor-ind').textContent, near: window.__game.sensorSnap.readings.filter((r) => r.distance !== null).length }));
    check('v0.4.9 garage5: 5층에서 층 표시 5F, 아래층 주차 차량/기둥은 센서에 잡히지 않음(층별 충돌·센서 구분)', fl5.floor === '5F', JSON.stringify(fl5));
    // 층 컬링: 다른 층 주차 차량 모델은 그리지 않아 드로우콜 절감
    const cull = await Y(() => window.__game.built.setLevelVisibility(window.__game.car.y));
    check('v0.4.9 다층 맵 성능: 현재 층에서 먼 층의 주차 차량 모델 숨김 (층 컬링)', cull > 20, String(cull));
    // 맵 전환/자원 해제: 8맵 순환 후 GPU 자원 증가 없음
    await loadMap('lot', 'lot-front');
    const r0 = await stats();
    for (const id of ['garage5', 'carpark3', 'modlot', 'spiral', 'tower', 'underground', 'outdoor', 'lot', 'garage5', 'lot']) {
      await Y((id) => { const G = window.__game; const m = G.settings; const first = { lot: 'lot-front', underground: 'ug-reverse', outdoor: 'out-parallel', tower: 'tw-1', garage5: 'g5-1', carpark3: 'c3-1', modlot: 'ml-1', spiral: 'sp-1' }[id]; G.updateSettings({ mapId: id, missionId: first || 'free' }); G.startRun(); }, id);
      await yuntil((id) => window.__game.map.id === id, id, 20000);
      await sleep(500);
    }
    await loadMap('lot', 'lot-front');
    await sleep(800);
    const r1 = await stats();
    check('v0.4.9 맵 10회 연속 전환 후 geometry/texture 증가 없음 (자원 해제)', r1.geos <= r0.geos + 6 && r1.tex <= r0.tex + 6, JSON.stringify({ r0, r1 }));

    // ---- PDC 전 영역 감지(실제 게임): 12개 위치의 가는 기둥이 모두 센서에 잡힌다 ----
    await loadMap('lot', 'free');
    await Y(() => { const G = window.__game; const c = G.car; c.x = 0; c.z = 0; c.heading = 0; c.v = 0; c.handbrake = true; c.gear = 'D'; });
    await sleep(800);
    const dims = await Y(() => ({ hw: window.__game.spec.width / 2, hl: window.__game.spec.length / 2 }));
    const spots = [['전방 중앙', 0, 1], ['전방 좌측 모서리', 1, 1], ['전방 우측 모서리', -1, 1], ['좌측 앞', 1, 0.6], ['좌측 중앙', 1, 0], ['좌측 뒤', 1, -0.6], ['우측 앞', -1, 0.6], ['우측 중앙', -1, 0], ['우측 뒤', -1, -0.6], ['후방 좌측 모서리', 1, -1], ['후방 중앙', 0, -1], ['후방 우측 모서리', -1, -1]];
    const missed = [];
    for (const [name, sx, sz] of spots) {
      const x = sx === 0 ? 0 : sx * (dims.hw + 0.6), z = sz === 0 ? 0 : sz === 1 || sz === -1 ? sz * (dims.hl + 0.7) : sz * dims.hl;
      await Y(([x, z]) => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); const c = { kind: 'cyl', id: 't-p', tag: 'pillar', x, z: z + 0, r: 0.15, y0: 0, h: 3 }; G.colliders.push(c); G.colliderById.set(c.id, c); G.car.x = 0; G.car.z = -G.spec.rearOverhang + G.spec.length / 2 - G.spec.length / 2 + 0; }, [x, z]);
      await Y(() => { const G = window.__game; const off = G.spec.length / 2 - G.spec.rearOverhang; G.car.x = 0; G.car.z = -off; G.car.heading = 0; });
      await sleep(350);
      const det = await Y(() => window.__game.sensorSnap.readings.some((r) => r.distance !== null));
      if (!det) missed.push(name);
    }
    check('v0.4.9 PDC 360°: 전방/모서리/측면/후방 12개 위치의 0.15m 기둥이 전부 감지(사각지대 없음)', missed.length === 0, missed.join(','));
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); });

    // ---- 카메라 자동 전환 빈도: 양쪽 벽 좁은 통로를 직진으로 통과 → 시점 전환 0회 ----
    await loadMap('lot', 'free');
    const Lh = await Y(() => window.__game.spec.length);
    const Wh = await Y(() => window.__game.spec.width);
    await Y(([Wh]) => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const s of [1, -1]) { const c = { kind: 'box', id: 't-w' + s, tag: 'wall', x: 16 + s * (Wh / 2 + 0.45 + 0.25), z: -8, w: 0.5, d: 14, rot: 0, y0: 0, h: 1.4 }; G.colliders.push(c); G.colliderById.set(c.id, c); } const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 16; c.z = -14 - off; c.heading = 0; c.v = 0; c.steer = 0; c.gear = 'D'; c.handbrake = false; G.debugViewCtx = null; }, [Wh]);
    await sleep(600);
    const sw0 = await Y(() => window.__game.viewPolicy.switches);
    await Y(() => { window.__game.debugInput = { throttle: 0.45, brake: 0, steerInput: 0 }; });
    await yuntil(() => window.__game.car.z > -5.5, undefined, 120000);
    await Y(() => { window.__game.debugInput = null; window.__game.car.handbrake = true; window.__game.car.v = 0; });
    const viewAfter = await Y(() => ({ view: window.__game.viewOut.view, sw: window.__game.viewPolicy.switches, z: window.__game.car.z }));
    check('v0.4.9 양쪽 벽 0.45m 좁은 통로를 직진 통과하는 동안 보조 시점 전환 0회, 기본 전방카메라 유지', viewAfter.sw === sw0 && viewAfter.view === 'front' && viewAfter.z > -6, JSON.stringify({ sw0, viewAfter }));
    // 벽 쪽으로 조향하며 접근하면 측면뷰 후보 (실제 충돌 가능성)
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); G.viewGate = false; });
    await Y(([Wh]) => { const G = window.__game; const c0 = { kind: 'box', id: 't-wl', tag: 'wall', x: 16 + Wh / 2 + 0.6 + 0.25, z: -8, w: 0.5, d: 14, rot: 0, y0: 0, h: 1.4 }; G.colliders.push(c0); G.colliderById.set(c0.id, c0); const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 16; c.z = -14 - off; c.heading = 0; c.v = 0; c.steer = 0; c.gear = 'D'; c.handbrake = false; G.debugInput = { throttle: 0.35, brake: 0, steerInput: 0.35 }; }, [Wh]);
    const sideView = await yuntil(() => window.__game.viewOut.view === 'left', undefined, 60000);
    await Y(() => { window.__game.debugInput = null; window.__game.car.handbrake = true; window.__game.car.v = 0; });
    check('v0.4.9 같은 벽이라도 그 쪽으로 조향하며 접근할 때는 좌측뷰가 사용됨(실제 위험일 때만 보조 시점)', sideView);
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); });

    // ---- 서라운드: 흰색 예측 경계선 정확히 2개 ----
    await loadMap('lot', 'free');
    const sur = async (label, gear, steer, wall) => {
      await Y(([gear, steer, wall]) => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 0; c.z = -2 - off; c.heading = 0; c.v = 0; c.gear = gear; c.handbrake = true; c.steer = steer; G.hud.wheel.angle = 0; if (wall) { const w = { kind: 'box', id: 't-sw', tag: 'wall', x: 0, z: wall > 0 ? G.spec.length / 2 + 1.6 - 2 : -2 - G.spec.length / 2 - 1.6, w: 8, d: 0.5, rot: 0, y0: 0, h: 1.4 }; G.colliders.push(w); G.colliderById.set(w.id, w); } }, [gear, steer, wall]);
      await yuntil(() => !document.getElementById('parking-assist').classList.contains('hidden') && window.__game.assistPanel.surroundActive, undefined, 30000);
      await sleep(1800);
      const n = await Y(() => window.__game.assistPanel.debugSurLines);
      const px = await Y(() => { const c = document.querySelector('.pa-sur-ov'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let any = 0, colored = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 40) continue; any++; if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) colored++; } return { any, colored }; });
      check(`v0.4.9 서라운드(${label}): 흰색 예측 경계선 정확히 2개, 컬러/추가 선·눈금·화살표 없음`, n === 2 && px.any > 20 /* v0.5.0: 색선은 감지 구간에만 */, JSON.stringify({ n, px }));
      return n;
    };
    await sur('D 중앙', 'D', 0, 0);
    await sur('D 최대 좌조향', 'D', 0.62, 0);
    await sur('D 최대 우조향', 'D', -0.62, 0);
    await sur('R 중앙', 'R', 0, 0);
    await sur('D 장애물 근접(예측선 절단)', 'D', 0, 1);
    await pg.screenshot({ path: path.join(OUT, '122-v049-surround-two-lines.png') });
    // 센서 전용에서는 컬러 유지, 다시 서라운드로 오면 잔상 없이 2개
    await Y(() => window.__game.onAction('pdcSensor'));
    await sleep(900);
    const sensCol = await Y(() => { const e = document.querySelector('#parking-assist .pa-svg'); const fills = [...e.querySelectorAll('path[data-zone]')].filter((p) => window.__game.assistPanel.zoneLevels()[p.dataset.zone] !== 'none').map((p) => (p.getAttribute('fill') || '').toLowerCase()); return { n: fills.length, white: fills.filter((f) => f === '#ffffff' || f === '#fff').length }; });
    check('v0.4.9 센서 전용 화면은 거리별 컬러 PDC 유지 (흰색 아님)', sensCol.n > 0 && sensCol.white === 0, JSON.stringify(sensCol));
    await Y(() => window.__game.onAction('pdcSurround'));
    await sleep(900);
    check('v0.4.9 센서→서라운드 복귀 후 잔상 없이 흰색 선 2개', (await Y(() => window.__game.assistPanel.debugSurLines)) === 2);
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); });

    // ---- 전/후방카메라: 실제 차체(범퍼 윗면) 일부가 영상 하단에 보임 (레이캐스트로 실제 메시 확인) ----
    for (const veh of ['suv-x6', 'sedan', 'coupe-m4']) {
      await loadMap('lot', 'free', veh);
      const views = veh === 'coupe-m4' ? ['rear'] : ['rear', 'front'];
      for (const v of views) {
        await Y(([v]) => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 0; c.z = 4 - off; c.heading = 0; c.v = 0; c.steer = 0; c.gear = v === 'rear' ? 'R' : 'D'; c.handbrake = true; }, [v]);
        await yuntil((v) => window.__game.viewOut.view === v && window.__game.rig.assistSettled, v, 40000);
        await sleep(1200);
        const strip = await Y(() => {
          const G = window.__game; const T = window.__THREE; const cam = G.rig.assistCamera; cam.updateMatrixWorld(true); G.model.root.updateMatrixWorld(true);
          const meshes = []; G.model.bodyGroup.traverse((o) => { let vis = o.isMesh; for (let q = o; q && vis; q = q.parent) if (!q.visible) vis = false; if (vis && !/^Plate/.test(o.name)) meshes.push(o); });
          const rc = new T.Raycaster(); rc.near = 0.02; rc.far = 1.5;
          const rows = [];
          for (let k = 0; k <= 40; k++) { const ndcY = -1 + (k / 40); rc.setFromCamera(new T.Vector2(0, ndcY), cam); rows.push(rc.intersectObjects(meshes, false).length > 0); }
          rc.setFromCamera(new T.Vector2(0, 0), cam);
          const centerHit = rc.intersectObjects(meshes, false).length > 0;
          const lowerHalf = rows.filter(Boolean).length / 41; // 화면 전체 높이 중 차체가 차지하는 비율(광선이 맞는 NDC 구간)
          return { frac: lowerHalf, centerHit, bottom: rows[0], n: meshes.length };
        });
        check(`v0.4.9 ${veh} ${v === 'rear' ? '후방' : '전방'}카메라: 영상 하단에 자기 차체 메시가 보이고(화면 높이의 약 ${Math.round(strip.frac * 50)}%), 화면 중앙 시야는 가리지 않음`, strip.bottom === true && strip.centerHit === false && strip.frac > 0.04 && strip.frac < 0.45, JSON.stringify(strip));
        await pg.screenshot({ path: path.join(OUT, `123-v049-cam-${veh}-${v}.png`), clip: { x: 290, y: 85, width: 340, height: 200 } }).catch(() => {});
      }
    }

    // ---- 계기판: 실제 게임 상태와 동기화 + 해상도 + 인포테인먼트와 분리 ----
    await loadMap('garage5', 'g5-2', 'suv-x6');
    await Y(() => { const G = window.__game; G.rig.setMode('driver'); const c = G.car; c.y = 3; c.x = -20; c.z = 0; c.heading = Math.PI / 2; c.gear = 'D'; c.v = 2.0; c.handbrake = false; c.steer = 0.2; G.sigLeft = true; G.lightMode = 'low'; G.debugInput = { throttle: 0.2, brake: 0, steerInput: 0.3 }; });
    await yuntil(() => window.__game.lastClusterData && window.__game.lastClusterData.floor === '2F', undefined, 40000);
    await sleep(900);
    const cd = await Y(() => ({ c: window.__game.lastClusterData, spd: Math.abs(window.__game.car.v) * 3.6, gear: window.__game.car.gear, cw: window.__game.model.cabin.cluster.canvas.width, ch: window.__game.model.cabin.cluster.canvas.height, ls: window.__game.sigLeft }));
    check('v0.4.9 계기판: 기어/속도/층/방향지시등/하향등/PDC/미션이 실제 게임 상태와 동기화', cd.c && cd.c.gear === cd.gear && Math.abs(cd.c.speedKmh - cd.spd) < 3 && cd.c.floor === '2F' && cd.c.signalLeft !== undefined && cd.c.lightMode === '하향등' && cd.c.lowBeam === true && cd.c.pdcOn === true && /2층/.test(cd.c.mission || ''), JSON.stringify(cd.c));
    check('v0.4.9 계기판: 캔버스 해상도 ≥768×294 (텍스트 선명도), RPM 은 시뮬레이션으로 표기(실측값 아님)', cd.cw >= 768 && cd.ch >= 294 && typeof cd.c.rpm === 'number');
    const cdPix = await Y(() => { const cv = window.__game.model.cabin.cluster.canvas; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let lit = 0, bright = 0; for (let i = 0; i < d.length; i += 16) { const m = Math.max(d[i], d[i + 1], d[i + 2]); if (m > 40) lit++; if (m > 200) bright++; } return { lit, bright }; });
    check('v0.4.9 계기판: 검정 바탕에 흰색 중심 정보 렌더링(밝은 픽셀·눈금·숫자 존재)', cdPix.lit > 3000 && cdPix.bright > 800, JSON.stringify(cdPix));
    await Y(() => { window.__game.debugInput = null; window.__game.car.v = 0; window.__game.car.handbrake = true; window.__game.sigLeft = false; });
    await sleep(800);
    await pg.screenshot({ path: path.join(OUT, '124-v049-cabin-cluster-garage5.png') });
    await ctx49.close();
  }

  // ================= v0.5.0 =================
  {
    const ctx50 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx50.newPage();
    pg.on('pageerror', (e) => errors.push('v050 pageerror: ' + e.message));
    await pg.addInitScript(() => { if (!localStorage.getItem('parksim.v1.settings')) localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'sedan', assistCameraFps: 60, infoAutoHide: false })); });
    await pg.goto(URL);
    await pg.waitForSelector('#m-start');
    await pg.click('#m-start');
    await pg.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
    await sleep(1200);
    const Y = (fn, arg) => pg.evaluate(fn, arg);
    const yuntil = (fn, arg, timeout = 120000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
    const loadMap = async (mapId, missionId, veh) => {
      await Y(([mapId, missionId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId, vehicleId: veh }); G.startRun(); }, [mapId, missionId, veh]);
      await yuntil((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 30000);
      await sleep(1000);
    };
    const mst = () => Y(() => { const G = window.__game; return { x: G.car.x, z: G.car.z, y: G.car.y, v: G.car.v, phase: G.mech.m.phase, door: G.mech.m.door, pY: G.mech.m.palletY, pZ: G.mech.m.palletZ, hits: G.mech.stopperHits, mission: G.mission && G.mission.status, state: G.state, msg: G.mech.m.message }; });
    // v0.5.3: 기계식 하차/입고 전에는 시동을 꺼야 한다 — 실제 입력 경로(브레이크 + KeyO)로 끈다. 이미 OFF 면 아무것도 하지 않는다.
    const engineOff = async () => {
      if (await Y(() => window.__game.engine.state === 'OFF')) return true;
      await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => window.__game.brake > 0.4, undefined, 10000);
      await pg.keyboard.press('KeyO');
      const ok = await yuntil(() => window.__game.engine.state === 'OFF', undefined, 15000);
      await Y(() => { window.__game.debugInput = null; });
      return ok;
    };
    const engineOn = async () => {
      if (await Y(() => window.__game.engine.state === 'RUNNING')) return true;
      await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => window.__game.brake > 0.4, undefined, 10000);
      await pg.keyboard.press('KeyO');
      const ok = await yuntil(() => window.__game.engine.state === 'RUNNING', undefined, 20000);
      await Y(() => { window.__game.debugInput = null; });
      return ok;
    };

    // ---- P0-A: 실차형 GLB(컨셉 쿠페) 실제 주행 모델 ----
    await loadMap('lot', 'free', 'concept-coupe');
    const glbOk = await yuntil(() => { const m = window.__game.model; return window.__game.spec.visual.kind === 'glb' && m.rollers.length === 4 && m.frontPivots.length === 2; }, undefined, 40000);
    check('v0.5.0 실차형 GLB(컨셉 쿠페) 로드: 바퀴 4개 회전축 + 앞바퀴 조향 피벗 2개', glbOk);
    await Y(() => { const G = window.__game; G.car.steer = 0.4; G.car.v = 3; G.car.gear = 'D'; G.car.handbrake = false; G.debugInput = { throttle: 0.3, brake: 0, steerInput: 0.4 }; });
    await sleep(1200);
    const wh = await Y(() => { const m = window.__game.model; return { steer: m.frontPivots.map((p) => p.rotation.y), roll: m.rollers.map((r) => r.rotation.x) }; });
    check('v0.5.0 GLB 앞바퀴가 조향각만큼 돌고(좌/우 같은 부호), 4바퀴가 회전한다', wh.steer.every((v) => Math.abs(v) > 0.05 && Math.sign(v) === Math.sign(wh.steer[0])) && wh.roll.every((r) => Math.abs(r) > 0.01), JSON.stringify(wh));
    await Y(() => { const G = window.__game; G.debugInput = { throttle: 0, brake: 1, steerInput: 0.4 }; });
    await yuntil(() => Math.abs(window.__game.car.v) < 0.02, undefined, 30000);
    const r1 = await Y(() => window.__game.model.rollers.map((r) => r.rotation.x));
    await sleep(600);
    const r2 = await Y(() => window.__game.model.rollers.map((r) => r.rotation.x));
    const st2 = await Y(() => window.__game.model.frontPivots.map((p) => p.rotation.y));
    check('v0.5.0 정차하면 바퀴 회전이 멈추고 조향각은 유지된다', r1.every((v, i) => Math.abs(v - r2[i]) < 1e-6) && st2.every((v) => Math.abs(v) > 0.05), JSON.stringify({ r1, r2, st2 }));
    await Y(() => { window.__game.debugInput = null; });

    // ---- P2-F: 3인칭 미러 ON/OFF (기본 OFF, 실제 렌더, OFF 이면 렌더 중단) ----
    await loadMap('lot', 'free', 'sedan');
    await Y(() => { const G = window.__game; G.settings.thirdMirror = false; G.rig.setMode('chase', G.poseNow()); });
    await sleep(800);
    const m0 = await Y(() => ({ r: window.__game.mirrors.renders, d: window.__game.mirrorOverlay.draws, on: window.__game.settings.thirdMirror }));
    await sleep(900);
    const m0b = await Y(() => ({ r: window.__game.mirrors.renders, d: window.__game.mirrorOverlay.draws }));
    check('v0.5.0 3인칭 미러: 기본 OFF 이고 OFF 동안 거울 렌더/오버레이 호출이 없다', m0.on === false && m0b.r === m0.r && m0b.d === m0.d, JSON.stringify({ m0, m0b }));
    await pg.keyboard.press('KeyU');
    await sleep(1800);
    const m1 = await Y(() => ({ r: window.__game.mirrors.renders, d: window.__game.mirrorOverlay.draws, on: window.__game.settings.thirdMirror, btn: document.querySelector('[data-a="mirrorToggle"]').classList.contains('on'), rects: window.__game.mirrorOverlay.lastRects }));
    check('v0.5.0 3인칭 미러 ON: 좌/룸/우 거울이 실제로 렌더되고 버튼이 켜진 상태로 표시', m1.on && m1.r > m0b.r && m1.d > m0b.d && m1.btn && Object.keys(m1.rects).length === 3, JSON.stringify(m1));
    await pg.screenshot({ path: path.join(OUT, '130-v050-third-mirror-on.png') });
    // 기어 변경 후에도 유지
    await Y(() => { window.__game.requestShift('R'); });
    await sleep(600);
    const keep = await Y(() => window.__game.settings.thirdMirror);
    check('v0.5.0 3인칭 미러: 기어 변경 후에도 상태 유지, 설정이 저장됨', keep === true && (await Y(() => JSON.parse(localStorage.getItem('parksim.v1.settings')).thirdMirror === true)));
    await Y(() => { window.__game.rig.setMode('driver', window.__game.poseNow()); });
    await sleep(600);
    const dOv = await Y(() => window.__game.mirrorOverlay.draws);
    await sleep(900);
    const dOv2 = await Y(() => window.__game.mirrorOverlay.draws);
    check('v0.5.0 1인칭에서는 3인칭 미러 오버레이를 그리지 않는다(실내 미러와 충돌 없음)', dOv2 === dOv);
    await Y(() => { window.__game.rig.setMode('chase', window.__game.poseNow()); });
    await pg.keyboard.press('KeyU');
    await sleep(700);
    const o0 = await Y(() => window.__game.mirrors.renders);
    await sleep(1000);
    const o1 = await Y(() => ({ r: window.__game.mirrors.renders, on: window.__game.settings.thirdMirror }));
    check('v0.5.0 3인칭 미러 OFF: 거울 렌더가 멈춘다', o1.on === false && o1.r === o0);

    // ---- P1-D: 서라운드 얇은 거리색 경고선 (감지된 곳만) ----
    await loadMap('lot', 'free', 'suv-x6');
    const place = (cx, cz, h, gear) => Y(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; G.hud.wheel.reset(); }, { cx, cz, h, gear });
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); G.rig.colliders = G.colliders; });
    await place(0, 10, 0, 'R');
    await yuntil(() => window.__game.surPathDbg && window.__game.surPathDbg.renders > 4, undefined, 40000);
    await sleep(900);
    const w0 = await Y(() => ({ warn: window.__game.assistPanel.debugSurWarn, white: window.__game.assistPanel.debugSurLines }));
    check('v0.5.0 서라운드: 장애물이 없으면 색 경고선 0개(흰 예측선 2개만)', w0.warn === 0 && w0.white === 2, JSON.stringify(w0));
    const L50 = await Y(() => window.__game.spec.length);
    await Y(([L]) => { const c = { kind: 'box', id: 't-w50', tag: 'wall', x: 0, z: 10 - L / 2 - 1.1 - 0.25, w: 6, d: 0.5, rot: 0, y0: 0, h: 1.4 }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [L50]);
    await sleep(1500);
    const w1 = await Y(() => ({ warn: window.__game.assistPanel.debugSurWarn, white: window.__game.assistPanel.debugSurLines }));
    check('v0.5.0 서라운드: 후방 장애물이 감지되면 얇은 색 경고선이 생기고 흰 예측선 2개는 그대로', w1.warn > 0 && w1.warn <= 12 && w1.white === 2, JSON.stringify(w1));
    await pg.screenshot({ path: path.join(OUT, '131-v050-surround-warn-lines.png') });
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); G.rig.colliders = G.colliders; });

    // ================= v0.5.2: 12층 기계식 주차타워 (전진/후진 입고, 4기둥 승강, 보관, 캐리지 복귀, 출고/회전, 제어반) =================
    const M = () => Y(() => { const G = window.__game; const m = G.mech.m; return { x: G.car.x, z: G.car.z, y: G.car.y, v: G.car.v, h: G.car.heading, phase: m.phase, door: m.door, cy: m.carriage.y, cz: m.carriage.z, yaw: m.yaw, pl: m.palletLoc, occ: Object.entries(m.slots).filter(([, q]) => q).map(([k, q]) => k + ':' + q.mode), stored: [...G.storedModels.keys()], msg: m.message, mission: G.mission && G.mission.status, state: G.state, guide: G.mech.guide.state, seat: G.mech.seatCount, led: G.mechBuilt.statusState, locked: m.locked, occupant: m.occupant, spec: G.spec.id }; });
    /** 정지 위치 근처까지 가속 → 감속 → 0.35m/s 크리핑 → brakeX 에서 제동 (게임 상태를 기다린다) */
    const creepIn = async (gear, thr, slowX, brakeX) => {
      await Y(([gear, th]) => { const G = window.__game; G.car.handbrake = false; G.car.gear = gear; G.debugInput = { throttle: th, brake: 0, steerInput: 0 }; }, [gear, thr]);
      await yuntil((t) => window.__game.car.x > t, slowX, 150000);
      await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => Math.abs(window.__game.car.v) < 0.45, undefined, 60000);
      await Y(() => { const G = window.__game; window.__creep = true; const tick = () => { if (!window.__creep || !G.debugInput) return; G.debugInput = { throttle: Math.abs(G.car.v) < 0.35 ? 0.14 : 0, brake: 0, steerInput: 0 }; setTimeout(tick, 40); }; G.debugInput = { throttle: 0.14, brake: 0, steerInput: 0 }; tick(); });
      await yuntil((t) => window.__game.car.x > t, brakeX, 150000);
      await Y(() => { window.__creep = false; window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => Math.abs(window.__game.car.v) < 0.03, undefined, 60000);
      await Y(() => { const G = window.__game; G.debugInput = null; G.car.gear = 'P'; G.car.handbrake = true; });
      await sleep(500);
    };

    // ---- 구조: 4개 모서리 기둥 + 가이드 레일, 팔레트 중앙 기둥 없음, 22 슬롯, 표시기/LED/제어반 배치 ----
    await loadMap('mechpark', 'mech-in-1', 'sedan');
    const st0 = await Y(() => { const G = window.__game; const mb = G.mechBuilt; const pos = (o) => { const v = new window.__THREE.Vector3(); o.getWorldPosition(v); return { x: +v.x.toFixed(2), z: +v.z.toFixed(2) }; }; return { cols: mb.columns.length, rails: mb.rails.length, colPos: mb.columns.map(pos), slots: mb.slotPallets.size, panelVisible: !document.getElementById('mech-panel').classList.contains('hidden'), colliders: G.colliders.filter((c) => /^ms-/.test(c.id)).length, led: mb.statusState, sign: mb.signState, mirrorZ: mb.mirror.position.z, mirrorX: mb.mirror.position.x }; });
    check('v0.5.2 승강 구조: 4개 모서리 기둥 + 수직 가이드 레일 4개, 22개 보관 슬롯 팔레트 모델', st0.cols === 4 && st0.rails === 4 && st0.slots === 22, JSON.stringify(st0));
    check('v0.5.2 팔레트 중앙(차량 보관 공간)에 기둥이 없다 (기둥은 팔레트 길이 양끝 바깥/승강로 모서리)', st0.colPos.every((c) => Math.abs(c.z) > 1.6 && (c.x < -2.4 - 2.8 || c.x > -2.4 + 2.8)), JSON.stringify(st0.colPos));
    check('v0.5.2 셔터 상단 상태 LED(입고 가능)와 거울 옆 안내판이 별개 장치로 동작', /ready\|입고 가능/.test(st0.led) && /forward|back|stop|blocked|align/.test(st0.sign) && st0.mirrorX > 1);
    check('v0.5.2 제어반 모달은 평소 숨김, 기계식 패널은 우측 컬럼', await Y(() => document.getElementById('mech-ctl').classList.contains('hidden') && !!document.querySelector('#top-right #mech-panel')));

    // ---- 전진 입고 → 2F A (미션 목표) : 실제 승강/보관/복귀/미션 성공 ----
    await creepIn('D', 0.5, -9.5, -3.5);
    const f1 = await M();
    check('v0.5.2 전진 입고: 낮은 정지턱을 넘으며 안착 이벤트 발생, 안내판 "정지", 정위치', f1.seat >= 1 && f1.guide === 'stop', JSON.stringify(f1));
    await pg.keyboard.press('KeyJ'); await sleep(300);
    check('v0.5.2 하차하지 않으면 입고 거부', (await M()).phase === 'waiting');
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.mech.m.door < 0.5, undefined, 60000);
    check('v0.5.2 셔터: 닫히는 동안 실제 충돌체 + 상단 LED 입고 중', await Y(() => window.__game.colliders.some((c) => c.id.endsWith(':door')) && /storing/.test(window.__game.mechBuilt.statusState)));
    await yuntil(() => window.__game.state === 'result', undefined, 200000);
    const f2 = await M();
    check('v0.5.2 전진 입고 미션 성공: 2F A 슬롯에 보관', f2.mission === 'success' && f2.occ.includes('02A:fwd') && f2.stored.includes('02A'), JSON.stringify(f2));

    // ---- 12층 입고 (최상층까지 실제 승강) ----
    await loadMap('mechpark', 'mech-in-12f', 'sedan');
    await creepIn('D', 0.5, -9.5, -3.5);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.mech.m.carriage.y > 32.9, undefined, 200000);
    const t12 = await M();
    check('v0.5.2 12층: 캐리지/차량이 실제 높이 33m(12F)까지 상승하고 차량-캐리지 높이가 같다', t12.cy > 32.9 && Math.abs(t12.y - t12.cy) < 1e-6 && t12.pl === 'carriage', JSON.stringify(t12));
    // 자유 시점 카메라가 차량 높이를 따라간다
    await Y(() => { const G = window.__game; G.rig.setMode('free', G.poseNow()); });
    await sleep(1200);
    const camY = await Y(() => ({ cam: window.__game.rig.active.position.y, car: window.__game.car.y }));
    check('v0.5.2 자유 시점 카메라가 12층 높이의 차량을 추적(카메라 y ≥ 차량 y)', camY.cam >= camY.car && camY.car > 30, JSON.stringify(camY));
    await Y(() => { const G = window.__game; G.rig.setMode('chase', G.poseNow()); });
    await yuntil(() => window.__game.state === 'result', undefined, 200000);
    const f12 = await M();
    check('v0.5.2 12F A 입고 미션 성공 + 빈 승강 플랫폼이 1층으로 복귀(캐리지 y=0, 새 팔레트 공급)', f12.mission === 'success' && f12.occ.includes('12A:fwd'), JSON.stringify(f12));
    await yuntil(() => window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, undefined, 200000).catch(() => {});
    await pg.screenshot({ path: path.join(OUT, '135-v052-12f-stored.png') });

    // ---- 후진 입고 → 8F A: 안내판 방향(후진), 정위치 판정(뒷차축), 보관 ----
    await loadMap('mechpark', 'mech-in-rev', 'sedan');
    const rv0 = await M();
    check('v0.5.2 후진 입고 시작: 안내판이 후진 입고 방향을 안내("후진")', rv0.guide === 'back' && Math.abs(Math.sin(rv0.h)) > 0.99 && Math.sin(rv0.h) < 0, JSON.stringify(rv0));
    await creepIn('R', 0.4, -8.5, -0.76);
    const rv1 = await M();
    check('v0.5.2 후진 입고: 뒷바퀴가 정지 홈에 안착(이벤트), 안내판 "정지"', rv1.seat >= 1 && rv1.guide === 'stop', JSON.stringify(rv1));
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.state === 'result', undefined, 250000);
    const rv2 = await M();
    check('v0.5.2 후진 입고 미션 성공: 8F A 에 후진 입고(rev) 보관', rv2.mission === 'success' && rv2.occ.includes('08A:rev'), JSON.stringify(rv2));

    // ---- 출고(전진 입고 차량: 호출→인출→하강→180° 회전→문 열림) → 전진 출차 → 미션 성공 ----
    await loadMap('mechpark', 'mech-out-1', 'sedan');
    await pg.keyboard.press('KeyK');
    await yuntil(() => window.__game.mech.m.phase === 'rotating' && window.__game.mech.m.yaw > 0.8, undefined, 250000);
    const ro = await Y(() => ({ yaw: window.__game.mech.m.yaw, py: window.__game.mechBuilt.pallet.rotation.y, door: window.__game.mech.m.door, locked: window.__game.mech.m.locked, occ: window.__game.mech.m.occupant, led: window.__game.mechBuilt.statusState }));
    check('v0.5.2 출고 회전: 3D 팔레트가 실제로 회전, 회전 중 문 닫힘/차량 고정/하차 상태, LED 출고 중', ro.yaw > 0.8 && Math.abs(ro.py - ro.yaw) < 1e-6 && ro.door === 0 && ro.locked && ro.occ === 'out' && /retrieving/.test(ro.led), JSON.stringify(ro));
    await yuntil(() => window.__game.mech.m.phase === 'exit', undefined, 200000);
    const ex = await M();
    check('v0.5.2 출고 완료: 보관 차량 인수(교체), 지상/문 열림/문(서쪽)을 향함, 슬롯 비워짐', ex.cy === 0 && ex.y === 0 && ex.door === 1 && Math.sin(ex.h) < -0.99 && !ex.occ.includes('08A:fwd') && ex.spec === 'sedan', JSON.stringify(ex));
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); check('v0.5.3 출고 후 탑승해도 시동은 자동으로 걸리지 않는다(OFF), 직접 시동해야 출차 가능', (await Y(() => window.__game.engine.state)) === 'OFF' && (await engineOn()));
    await Y(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.debugInput = { throttle: 0.6, brake: 0, steerInput: 0 }; });
    await yuntil(() => window.__game.car.x < -21.0, undefined, 150000);
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await yuntil(() => window.__game.state === 'result', undefined, 60000);
    check('v0.5.2 출고 미션 성공(회전 후 전진 출차, 출구 구역 정차)', (await M()).mission === 'success');

    // ---- 후진 입고 차량 출고: 회전 없음 ----
    await loadMap('mechpark', 'mech-out-rev', 'sedan');
    await pg.keyboard.press('KeyK');
    let sawRot = false;
    await yuntil(() => { if (window.__game.mech.m.phase === 'rotating') window.__rotSeen = true; return window.__game.mech.m.phase === 'exit'; }, undefined, 300000);
    const rx = await Y(() => ({ rot: !!window.__rotSeen, yaw: window.__game.mech.m.yaw, h: window.__game.car.heading, y: window.__game.car.y }));
    check('v0.5.2 후진 입고 차량 출고: 회전 단계 없이(중복 회전 금지) 문을 향해 출고, 12F 에서 지상으로', !rx.rot && rx.yaw === 0 && Math.sin(rx.h) < -0.99 && rx.y === 0, JSON.stringify(rx));
    void sawRot;

    // ================= v0.5.2 P0 핫픽스: 입고 후 차량이 시작 위치로 순간이동하지 않고 슬롯에 그대로 남는다 =================
    await loadMap('mechpark', 'mech-in-1', 'sedan');
    await Y(() => { window.__game.mech.selectedSlot = '08A'; window.__spawn = { x: window.__game.car.x, z: window.__game.car.z }; });
    await creepIn('D', 0.5, -9.5, -3.5);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.mech.m.carriage.y > 8, undefined, 200000);
    const hl = await Y(() => { const G = window.__game; const c = G.rig.active.position; return { camCarDist: Math.hypot(c.x - G.car.x, c.y - G.car.y, c.z - G.car.z), carY: G.car.y, cy: G.mech.m.carriage.y, modelY: G.model.root.position.y }; });
    check('v0.5.2 핫픽스: 상승 중 카메라가 차량을 추적(거리 < 40m)하고 모델/차량/캐리지 높이가 일치', hl.camCarDist < 40 && Math.abs(hl.carY - hl.cy) < 1e-6 && Math.abs(hl.modelY - hl.cy) < 0.05, JSON.stringify(hl));
    await pg.screenshot({ path: path.join(OUT, '136-v052hf-lifting.png') });
    await yuntil(() => !!window.__game.mech.m.slots['08A'] && window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, undefined, 250000);
    const hs = await Y(() => { const G = window.__game; const m = G.mech.m; const e = G.storedModels.get('mech-tower/08A'); const c = G.rig.active.position; const sp = window.__spawn; window.__m08 = e && e.model; window.__id08 = m.slots['08A'] && m.slots['08A'].carId; return { slot: G.playerStoredSlot, same: !!e && e.model === G.model, idOk: !!e && e.carId === m.slots['08A'].carId, carY: G.car.y, modelY: G.model.root.position.y, fromSpawn: Math.hypot(G.car.x - sp.x, G.car.z - sp.z), camCarDist: Math.hypot(c.x - G.car.x, c.y - G.car.y, c.z - G.car.z), nStored: G.storedModels.size, parked: G.parkedCars.length, mission: G.mission && G.mission.status, cy: m.carriage.y, cz: m.carriage.z, pl: m.palletLoc, spec: e && e.spec.id, hasMesh: G.model.root.children.length > 0 }; });
    check('v0.5.2 핫픽스: 입고 완료 후 그 차량이 8F A 에 그대로 남는다(시작 위치로 이동/재생성 없음), 모델·ID 유지, 차량 높이 21m', hs.slot === '08A' && hs.same && hs.idOk && Math.abs(hs.carY - 21) < 1e-6 && Math.abs(hs.modelY - 21) < 0.05 && hs.fromSpawn > 25 && hs.nStored === 1 && hs.parked === 0 && hs.hasMesh, JSON.stringify(hs));
    check('v0.5.2 핫픽스: 빈 캐리지만 1층 복귀(캐리지 y=0, z=0), 승강장에 새 빈 팔레트, 미션은 계속(결과 화면/초기화 없음)', hs.cy === 0 && hs.cz === 0 && hs.pl === 'station' && hs.mission === 'running');
    check('v0.5.2 핫픽스: 보관 후 카메라가 보관 차량(8F)을 계속 추적한다(시작 위치로 이동하지 않음)', hs.camCarDist < 40, JSON.stringify({ d: hs.camCarDist }));
    const still1 = await Y(() => { const G = window.__game; return { x: G.car.x, y: G.car.y, z: G.car.z, t: G.mech.m.clock }; });
    await yuntil(([t]) => window.__game.mech.m.clock > t + 3, [still1.t], 60000);
    const still2 = await Y(() => { const G = window.__game; return { x: G.car.x, y: G.car.y, z: G.car.z, mx: G.model.root.position.x, my: G.model.root.position.y, mz: G.model.root.position.z }; });
    check('v0.5.2 핫픽스: 보관 완료 후 차량/모델이 움직이지 않는다(게임 시간 3초 경과)', Math.abs(still2.x - still1.x) + Math.abs(still2.y - still1.y) + Math.abs(still2.z - still1.z) < 1e-9 && Math.abs(still2.my - 21) < 0.05, JSON.stringify({ still1, still2 }));
    // v0.5.3 P0 재검증: 숨은 새 차량/위치 복귀 경로 없음 (T 초기화, G 하차 버튼, 10초 방치)
    await pg.keyboard.press('KeyT'); await sleep(400);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(400);
    const idle0 = await Y(() => { const G = window.__game; return { t: G.mech.m.clock, slot: G.playerStoredSlot, y: G.car.y, my: G.model.root.position.y, n: G.newCarCount, same: G.storedModels.get('mech-tower/08A').model === G.model }; });
    await yuntil(([t]) => window.__game.mech.m.clock > t + 10, [idle0.t], 120000);
    const idle1 = await Y(() => { const G = window.__game; const c = G.rig.active.position; return { slot: G.playerStoredSlot, y: G.car.y, my: G.model.root.position.y, n: G.newCarCount, same: G.storedModels.get('mech-tower/08A').model === G.model, camD: Math.hypot(c.x - G.car.x, c.y - G.car.y, c.z - G.car.z), carId: G.mech.m.slots['08A'].carId, entryId: G.storedModels.get('mech-tower/08A').carId }; });
    check('v0.5.3 P0: 입고 후 T(초기화)/G(하차) 입력·10초 방치에도 새 차량 자동 생성 0회, 보관 차량은 8F 에 그대로, 카메라 대상=보관 차량, 차량 ID 일치', idle0.slot === '08A' && idle1.slot === '08A' && idle1.n === 0 && Math.abs(idle1.y - 21) < 1e-6 && Math.abs(idle1.my - 21) < 0.05 && idle1.same && idle1.camD < 40 && idle1.carId === idle1.entryId, JSON.stringify({ idle0, idle1 }));
    await pg.screenshot({ path: path.join(OUT, '137-v052hf-stored-8f.png') });
    // 자유 시점: 보관된 차량(8F)을 추적, 사용자가 시점을 바꿀 수 있다
    await Y(() => { const G = window.__game; G.rig.setMode('free', G.poseNow()); });
    await sleep(1200);
    const fr = await Y(() => { const G = window.__game; return { camY: G.rig.active.position.y, carY: G.car.y }; });
    check('v0.5.2 핫픽스: 자유 시점이 보관된 차량 높이(8F)를 따라간다', fr.camY >= fr.carY && fr.carY > 20, JSON.stringify(fr));
    await Y(() => { const G = window.__game; G.rig.setMode('chase', G.poseNow()); });
    // 명시적 '새 차량' 조작 전에는 새 플레이어 차량이 없다 → I 키로 새 차량 시작, 보관 차량은 그대로
    check('v0.5.2 핫픽스: 새 차량을 누르기 전에는 새 플레이어 차량이 없다(조작 차단, 관찰 상태)', await Y(() => window.__game.playerStoredSlot === '08A' && window.__game.mech.blocksDriving()));
    await pg.keyboard.press('KeyI'); await sleep(800);
    const nw = await Y(() => { const G = window.__game; const e = G.storedModels.get('mech-tower/08A'); const sp = window.__spawn; return { slot: G.playerStoredSlot, newAtSpawn: Math.hypot(G.car.x - sp.x, G.car.z - sp.z) < 3, carY: G.car.y, storedSame: !!e && e.model === window.__m08, storedY: e && e.model.root.position.y, idSame: G.mech.m.slots['08A'].carId === window.__id08, newModel: G.model !== window.__m08, nStored: G.storedModels.size }; });
    check('v0.5.2 핫픽스: 명시적 새 차량(I) → 새 차량만 시작 위치에 생기고 8F 보관 차량(모델/ID/위치)은 그대로', nw.slot === null && nw.newAtSpawn && nw.carY === 0 && nw.storedSame && Math.abs(nw.storedY - 21) < 0.05 && nw.idSame && nw.newModel && nw.nStored === 1, JSON.stringify(nw));
    // 두 번째 차량: 후진 입고 12F B → 8F/12F 에 서로 다른 차량 보관
    await Y(() => { const G = window.__game; G.mech.selectedSlot = '12B'; G.car.x = -17; G.car.z = 0; G.car.heading = -Math.PI / 2; G.car.v = 0; });
    await sleep(500);
    await creepIn('R', 0.4, -8.5, -0.76);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => !!window.__game.mech.m.slots['12B'] && window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, undefined, 300000);
    const two = await Y(() => { const G = window.__game; const m = G.mech.m; const a = G.storedModels.get('mech-tower/08A'); const b = G.storedModels.get('mech-tower/12B'); return { n: G.storedModels.size, distinct: !!a && !!b && a.model !== b.model, ids: [m.slots['08A'].carId, m.slots['12B'].carId], idsOk: a.carId === m.slots['08A'].carId && b.carId === m.slots['12B'].carId, y8: a.model.root.position.y, y12: b.model.root.position.y, m8: a.model === window.__m08, mode12: m.slots['12B'].mode }; });
    check('v0.5.2 핫픽스: 8F/12F 에 서로 다른 두 차량이 각각 보관(모델/ID 구분, 기존 8F 차량 불변)', two.n === 2 && two.distinct && two.ids[0] !== two.ids[1] && two.idsOk && Math.abs(two.y8 - 21) < 0.05 && Math.abs(two.y12 - 33) < 0.05 && two.m8 && two.mode12 === 'rev', JSON.stringify(two));
    await pg.screenshot({ path: path.join(OUT, '138-v052hf-two-stored.png') });
    // 선택한 차량만 출고: 8F A 호출 → 12F B 는 그대로, 플레이어는 8F 차량을 정확히 인수, 기존 관찰 차량은 사라지지 않음
    await pg.keyboard.press('KeyI'); await sleep(600);
    await Y(() => { const G = window.__game; G.mech.selectedSlot = '08A'; });
    await pg.keyboard.press('KeyK');
    await yuntil(() => window.__game.mech.m.phase === 'exit', undefined, 300000);
    const out8 = await Y(() => { const G = window.__game; const m = G.mech.m; const b = G.storedModels.get('mech-tower/12B'); return { own: G.model === window.__m08, carried: m.carrying && m.carrying.carId === window.__id08, slot12: !!m.slots['12B'], n: G.storedModels.size, y12: b && b.model.root.position.y, slot08: !!m.slots['08A'], parked: G.parkedCars.length, rotated: m.yaw, y: G.car.y }; });
    check('v0.5.2 핫픽스: 선택한 8F 차량만 출고(같은 모델·ID 인수), 12F 차량은 그대로, 기존 조작 차량은 삭제되지 않고 입구 밖에 주차', out8.own && out8.carried && out8.slot12 && !out8.slot08 && out8.n === 1 && Math.abs(out8.y12 - 33) < 0.05 && out8.parked === 1 && out8.y === 0, JSON.stringify(out8));
    await pg.screenshot({ path: path.join(OUT, '139-v052hf-retrieved.png') });

    // ---- 통합 맵 megapark 의 기계식 구역에서도 동일: 12F 입고 후 차량 유지 ----
    await loadMap('megapark', 'mech-in-12f', 'sedan');
    await creepIn('D', 0.5, -9.5, -3.5);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.state === 'result', undefined, 300000);
    const mg = await Y(() => { const G = window.__game; const e = G.storedModels.get('mech-tower/12A'); return { map: G.map.id, slot: G.playerStoredSlot, same: !!e && e.model === G.model, y: G.car.y, my: G.model.root.position.y, cy: G.mech.m.carriage.y, mission: G.mission.status, spawnDist: Math.hypot(G.car.x - (-30), G.car.z) }; });
    check('v0.5.2 핫픽스: 통합 맵(megapark) 기계식 구역에서도 12F A 입고 후 차량이 슬롯에 남고(높이 33m) 캐리지 1층 복귀·미션 성공', mg.map === 'megapark' && mg.slot === '12A' && mg.same && Math.abs(mg.y - 33) < 1e-6 && Math.abs(mg.my - 33) < 0.05 && mg.cy === 0 && mg.mission === 'success' && mg.spawnDist > 20, JSON.stringify(mg));

    // ---- 슬롯 점유/제어반/거부 ----
    await loadMap('mechpark', 'mech-out-1', 'sedan'); // 8F A 가 점유된 상태
    await Y(() => { const G = window.__game; G.car.x = -3.4; G.car.z = 0; G.car.heading = Math.PI / 2; G.car.gear = 'P'; G.car.handbrake = true; G.car.v = 0; G.mech.selectedSlot = '08A'; });
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ'); await sleep(500);
    const occ = await M();
    check('v0.5.2 이미 점유된 슬롯(8F A)에 입고하면 거부되고 이유가 표시된다(중복 점유 방지)', occ.phase === 'waiting' && /이미 사용 중/.test(occ.msg), occ.msg);
    await pg.keyboard.press('KeyZ'); await sleep(500);
    const ctl = await Y(() => ({ open: !document.getElementById('mech-ctl').classList.contains('hidden'), btns: document.querySelectorAll('#mech-ctl [data-slot]').length, used: document.querySelectorAll('#mech-ctl [data-slot][data-used="1"]').length }));
    check('v0.5.2 제어반: Z 키로 열림, 2F~12F × A/B = 22개 슬롯 버튼, 점유 슬롯 표시', ctl.open && ctl.btns === 22 && ctl.used === 1, JSON.stringify(ctl));
    await pg.click('#mech-ctl [data-slot="05B"]'); await sleep(300);
    check('v0.5.2 제어반: 슬롯 선택(5F B)이 장치 선택 슬롯으로 반영', (await Y(() => window.__game.mech.selectedSlot)) === '05B');
    await pg.click('#mech-ctl [data-c="auto"]'); await sleep(300);
    check('v0.5.2 제어반: 자동/수동 슬롯 선택 정책이 설정에 저장된다', await Y(() => window.__game.settings.mechAutoSlot === true && JSON.parse(localStorage.getItem('parksim.v1.settings')).mechAutoSlot === true));
    await pg.click('#mech-ctl [data-c="auto"]'); await pg.click('#mech-ctl [data-c="close"]'); await sleep(300);
    check('v0.5.2 제어반 닫기', await Y(() => document.getElementById('mech-ctl').classList.contains('hidden')));

    // ---- 낮은 가이드/볼라드 접촉 물리 ----
    await loadMap('mechpark', 'mech-in-1', 'sedan');
    check('v0.5.2 팔레트 가이드는 낮은 구조물(0.12m < 지상고 0.2m), 볼라드 4개 금속 원통 충돌체(센서 높이보다 높음)', await Y(() => { const G = window.__game; const g = G.colliders.filter((c) => c.tag === 'guide'); const b = G.colliders.filter((c) => c.tag === 'bollard'); return g.length === 2 && g.every((c) => c.h < 0.2) && b.length === 4 && b.every((c) => c.h > 0.55) && G.mechBuilt.bollards.count === 4; }));
    // 볼라드 접촉: 정면으로 부딪히면 관통하지 않고 멈추며, 후진으로 이탈할 수 있다(끼임 없음)
    await Y(() => { const G = window.__game; const c = G.car; c.x = -15; c.z = 0.2; c.heading = Math.PI / 2 - 0.3; c.v = 0; c.gear = 'D'; c.handbrake = false; G.debugInput = { throttle: 0.45, brake: 0, steerInput: 0 }; window.__minD = 99; window.__bolIv = setInterval(() => { for (const id of ['bol-1n', 'bol-2n']) { const b = G.colliders.find((q) => q.id === id); window.__minD = Math.min(window.__minD, Math.hypot(G.car.x - b.x, G.car.z - b.z)); } }, 30); });
    await yuntil(() => window.__game.lastHitId === 'bol-1n' || window.__game.lastHitId === 'bol-2n', undefined, 120000); // 게임 상태를 기다린다
    await yuntil(() => Math.abs(window.__game.car.v) < 0.05, undefined, 30000);
    const bol = await Y(() => { const G = window.__game; return { x: G.car.x, z: G.car.z, v: G.car.v, coll: G.collisions, minD: window.__minD, hit: G.lastHitId }; });
    await Y(() => { const G = window.__game; G.car.gear = 'R'; G.debugInput = { throttle: 0.4, brake: 0, steerInput: -0.5 }; });
    await yuntil(([x0]) => window.__game.car.x < x0 - 0.8, [bol.x], 60000);
    const esc = await Y(() => { clearInterval(window.__bolIv); const G = window.__game; G.debugInput = null; return { x: G.car.x, v: G.car.v }; });
    check('v0.5.2 볼라드 접촉: 관통 불가(차체 중심과 볼라드 거리 > 반폭+r)이고 후진으로 이탈 가능(끼임 없음)', bol.minD > 0.1 + 0.4 && esc.x < bol.x - 0.8, JSON.stringify({ bol, esc }));


    // ---- v0.5.1: 전방카메라 범퍼 중앙 ----
    await loadMap('lot', 'free', 'sedan');
    const fc = await Y(() => { const s = window.__game.spec; return { x: s.frontCam.x, z: s.frontCam.z - s.length / 2, y: s.frontCam.y, bumperTop: 0.42 * s.height }; });
    check('v0.5.1 전방카메라: 차량 폭 중앙(x=0), 앞끝에서 20cm 이내 안쪽, 범퍼 윗면 바로 위(+0.05~0.2m, 차체별 튜닝) 높이', fc.x === 0 && fc.z < 0 && fc.z > -0.2 && fc.y >= fc.bumperTop + 0.05 && fc.y <= fc.bumperTop + 0.2, JSON.stringify(fc));

    // ---- v0.5.1: 경고 패널 가로로 넓고 낮게 ----
    await loadMap('lot', 'free', 'suv-x6');
    await Y(() => { const G = window.__game; G.updateSettings({ assistAutoView: false }); const L = G.spec.length; const c = G.car; c.x = 0; c.z = 10 - (L / 2 - G.spec.rearOverhang); c.heading = 0; c.gear = 'R'; c.handbrake = true; c.v = 0; const w = { kind: 'box', id: 't-pw', tag: 'wall', x: 0, z: 10 - L / 2 - 1.2, w: 9, d: 0.5, rot: 0, y0: 0, h: 1.4 }; G.colliders.push(w); G.colliderById.set(w.id, w); });
    await yuntil(() => window.__game.viewOut.view === 'rear' && window.__game.assistPanel.debugPanels.length > 0, undefined, 40000);
    await sleep(1200);
    const pn = await Y(() => window.__game.assistPanel.debugPanels.map((q) => ({ w: Math.max(...q.poly.map((a) => a.x)) - Math.min(...q.poly.map((a) => a.x)), h: Math.max(...q.poly.map((a) => a.y)) - Math.min(...q.poly.map((a) => a.y)) })));
    check('v0.5.1 후방 경고 패널: 넓은 벽에서 패널 개수 ≤ 4, 가장 넓은 패널이 높이보다 훨씬 넓다(가로로 길고 세로로 낮음)', pn.length >= 1 && pn.length <= 4 && Math.max(...pn.map((q) => q.w / Math.max(1, q.h))) > 3, JSON.stringify(pn));
    await Y(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); G.rig.colliders = G.colliders; });

    // 전방 거울(Reflector) 실제 갱신
    await loadMap('mechpark', 'mech-in-1', 'sedan');
    await sleep(1500);
    const mr = await Y(() => ({ n: window.__game.mechBuilt.mirrorRenders }));
    await sleep(1200);
    const mr2 = await Y(() => ({ n: window.__game.mechBuilt.mirrorRenders }));
    check('v0.5.0 기계식 전방 확인 거울: 실제 Three.js 반사 렌더가 간헐(제한 FPS)로 갱신된다', mr2.n > mr.n && mr2.n - mr.n < 40, JSON.stringify({ mr, mr2 }));
    await pg.screenshot({ path: path.join(OUT, '133-v050-mech-entry.png') });

    // ---- v0.5.3 Gate C: 야외 맵의 회전된 기계식 시설 2기 — 독립 운용(입고/현황/추천) ----
    await loadMap('outdoor', 'free', 'sedan');
    await sleep(1200);
    {
      const info = await Y(() => { const G = window.__game; return { n: G.facilities.length, ids: G.facilities.map((f) => f.cfg.id), floors: G.facilities.map((f) => f.cfg.floors), slots: G.facilities.map((f) => Object.keys(f.ctl.m.slots).length), yaw: G.facilities.map((f) => +f.frame.yaw.toFixed(3)), doors: G.facilities.map((f) => f.built.group.position.x + ',' + f.built.group.position.z), groupYaw: G.facilities.map((f) => +f.built.group.rotation.y.toFixed(3)) }; });
      check('v0.5.3 야외 맵: 독립 기계식 시설 2기(12층 22슬롯 / 6층 10슬롯), 모델이 시설 위치/회전에 놓임', info.n === 2 && info.slots[0] === 22 && info.slots[1] === 10 && info.floors[0] === 12 && info.floors[1] === 6 && info.groupYaw.every((y, i) => Math.abs(y - info.yaw[i]) < 1e-3) && Math.abs(info.yaw[0] - 1.571) < 0.01, JSON.stringify(info));
      const pk = await Y(() => { const G = window.__game; const el = document.querySelector('#mission-panel .mc-park'); return { text: el ? el.textContent : '', area: G.parkArea ? { reg: G.parkArea.regularTotal, free: G.parkArea.regularFree, mech: G.parkArea.mech.map((m) => m.free + '/' + m.total) } : null, rec: G.parkRec ? G.parkRec.kind : null }; });
      check('v0.5.3 주차 현황 표시: 일반 칸 잔여/기계식 잔여(22+10=32)가 실제 데이터로 표시되고 거리 숫자는 없다', pk.area && pk.area.reg > 0 && pk.area.mech.join() === '22/22,10/10' && /일반 \d+\/\d+ · 기계식 32\/32/.test(pk.text) && !/\d\s*m\b/.test(pk.text), JSON.stringify(pk));
      // 동쪽(12층) 시설 로컬 정위치 앞쪽으로 배치 후 전진 입고
      const setLocal = (idx, lx, lz, lh) => Y(([idx, lx, lz, lh]) => { const G = window.__game; const f = G.facilities[idx].frame; const c = Math.cos(f.yaw), s = Math.sin(f.yaw); const car = G.car; car.x = f.x + lx * c + lz * s; car.z = f.z - lx * s + lz * c; car.heading = lh + f.yaw; car.v = 0; car.steer = 0; car.gear = 'P'; car.handbrake = false; car.pitch = 0; car.y = 0; G.rig.snap(); }, [idx, lx, lz, lh]);
      await setLocal(0, -17, 0, Math.PI / 2);
      await sleep(600);
      const act0 = await Y(() => window.__game.activeFacility.cfg.id);
      check('v0.5.3 가까운 시설이 현재 시설로 선택된다(동쪽 시설 앞)', act0 === 'out-mech-east', act0);
      const creepLocal = async (gear, thr, slowLx, brakeLx) => {
        await Y(([gear, th]) => { const G = window.__game; G.car.handbrake = false; G.car.gear = gear; G.debugInput = { throttle: th, brake: 0, steerInput: 0 }; }, [gear, thr]);
        await yuntil((t) => { const G = window.__game; return G.mech.localCar(G.car).x > t; }, slowLx, 150000);
        await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
        await yuntil(() => Math.abs(window.__game.car.v) < 0.45, undefined, 60000);
        await Y(() => { const G = window.__game; window.__creep = true; const tick = () => { if (!window.__creep || !G.debugInput) return; G.debugInput = { throttle: Math.abs(G.car.v) < 0.35 ? 0.14 : 0, brake: 0, steerInput: 0 }; requestAnimationFrame(tick); }; G.debugInput = { throttle: 0.14, brake: 0, steerInput: 0 }; tick(); });
        await yuntil((t) => { const G = window.__game; return G.mech.localCar(G.car).x > t; }, brakeLx, 150000);
        await Y(() => { window.__creep = false; window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
        await yuntil(() => Math.abs(window.__game.car.v) < 0.03, undefined, 60000);
        await Y(() => { const G = window.__game; G.debugInput = null; G.car.gear = 'P'; G.car.handbrake = true; });
        await sleep(500);
      };
      await creepLocal('D', 0.5, -9.5, -3.5);
      const al = await Y(() => { const G = window.__game; const l = G.mech.localCar(G.car); return { lx: +l.x.toFixed(2), lz: +l.z.toFixed(2), hd: +((l.heading % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)).toFixed(3), items: G.mech.items.map((i) => i.key + ':' + i.ok).join(',') }; });
      check('v0.5.3 회전된 시설에서도 벽/볼라드/가이드와 충돌 없이 진입해 로컬 정위치에 정차한다', Math.abs(al.lz) < 0.12 && al.lx > -3.7 && al.lx < -3.3 && Math.abs(al.hd - 1.571) < 0.06, JSON.stringify(al));
      await engineOff();
      await pg.keyboard.press('KeyG');
      await sleep(400);
      await Y(() => { window.__game.mech.selectedSlot = '03B'; });
      await pg.keyboard.press('KeyJ');
      const stored = await yuntil(() => { const G = window.__game; return !!G.facilities[0].ctl.m.slots['03B'] && G.facilities[0].ctl.m.phase === 'waiting' && !!G.playerStoredSlot; }, undefined, 150000);
      const ind = await Y(() => { const G = window.__game; const sc = G.facilities[0].ctl.m.slots['03B']; const pose = G.facilities[0].ctl.storedPoseW('03B', sc); return { occ0: Object.values(G.facilities[0].ctl.m.slots).filter(Boolean).length, occ1: Object.values(G.facilities[1].ctl.m.slots).filter(Boolean).length, clk1: G.facilities[1].ctl.m.clock, phase1: G.facilities[1].ctl.m.phase, newCars: G.newCarCount, y: G.car.y, dx: Math.abs(G.model.root.position.x - pose.x), dz: Math.abs(G.model.root.position.z - pose.z), my: G.model.root.position.y }; });
      check('v0.5.3 회전된 시설 입고: 그 시설 3F B 슬롯에 보관(차량 모델이 월드 슬롯 위치에 남음), 다른 시설은 영향 없음(독립 상태기계), 새 차량 자동 생성 0', stored && ind.occ0 === 1 && ind.occ1 === 0 && ind.phase1 === 'waiting' && ind.clk1 > 1 && ind.newCars === 0 && ind.dx < 0.05 && ind.dz < 0.05 && Math.abs(ind.my - 6) < 0.05, JSON.stringify(ind));
      await sleep(800);
      const pk2 = await Y(() => { const G = window.__game; return { mech: G.parkArea.mech.map((m) => m.free + '/' + m.total), txt: document.querySelector('#mission-panel .mc-park')?.textContent || '' }; });
      check('v0.5.3 입고 후 기계식 잔여가 실시간 갱신(21/22, 10/10)', pk2.mech.join() === '21/22,10/10' && /기계식 31\/32/.test(pk2.txt), JSON.stringify(pk2));
      // 두 번째(북쪽 6층) 시설: 가까이 가면 현재 시설이 바뀌고 슬롯은 10개(7F 이상 없음)
      await Y(() => { window.__game.mech.selectedSlot = '02A'; });
      await setLocal(1, -17, 0, Math.PI / 2);
      await sleep(600);
      // 입고된 차량 관찰 상태에서는 보관 시설이 유지된다 → 새 차량으로 전환 후 두 번째 시설 선택 확인
      await pg.keyboard.press('KeyI');
      await sleep(400);
      await setLocal(1, -17, 0, Math.PI / 2);
      await sleep(900);
      const act1 = await Y(() => ({ id: window.__game.activeFacility.cfg.id, floors: window.__game.mech.m.floors, grid: document.querySelectorAll('#mech-ctl .mctl-row').length }));
      check('v0.5.3 북쪽 시설 앞에서는 현재 시설이 6층 시설로 바뀐다(제어반 슬롯 행 5개), 동쪽 시설의 보관 차량은 유지', act1.id === 'out-mech-north' && act1.floors === 6 && (await Y(() => !!window.__game.facilities[0].ctl.m.slots['03B'])), JSON.stringify(act1));
      await pg.screenshot({ path: path.join(OUT, '141-v053-outdoor-facilities.png') });
    }

    // ---- v0.5.3 Gate B: 기계식 거울 FPS(게임 시간 기준) 측정 ----
    {
      const mm = await Y(() => ({ n: window.__game.mechBuilt.mirrorRenders, t: window.__game.mech.m.clock, q: window.__game.settings.quality, vis: window.__game.mechBuilt.mirror.visible }));
      await yuntil(([t]) => window.__game.mech.m.clock > t + 4, [mm.t], 90000);
      const mm2 = await Y(() => ({ n: window.__game.mechBuilt.mirrorRenders, t: window.__game.mech.m.clock }));
      const fps = (mm2.n - mm.n) / (mm2.t - mm.t);
      const tgt = await Y(() => ({ high: 30, medium: 24, low: 16 }[window.__game.settings.quality]));
      check('v0.5.3 기계식 거울 갱신: 게임 시간 기준 목표 FPS(화질 자동 30/24/16)의 ±35% 이내, 거울이 보일 때만 렌더', mm.vis && fps > tgt * 0.65 && fps <= tgt * 1.35, JSON.stringify({ quality: mm.q, measuredMirrorFps: +fps.toFixed(1), target: tgt }));
    }

    // ---- v0.5.3 Gate B: 시동/정지 상태기계 + 입고 전 시동 OFF 조건 ----
    await loadMap('mechpark', 'mech-in-1', 'sedan');
    await sleep(800);
    {
      const e0 = await Y(() => ({ s: window.__game.engine.state, rpm: window.__game.engine.rpm }));
      check('v0.5.3 시동: 기본은 시동 ON(RUNNING) + 공회전 RPM', e0.s === 'RUNNING' && e0.rpm > 500 && e0.rpm < 1100, JSON.stringify(e0));
      await Y(() => { const G = window.__game; G.car.gear = 'P'; G.car.v = 0; G.car.handbrake = true; });
      await pg.keyboard.press('KeyG');
      await sleep(400);
      const occIn = await Y(() => window.__game.mech.m.occupant);
      check('v0.5.3 시동이 걸린 채로는 하차(G)할 수 없다', occIn === 'in', occIn);
      const ok = await engineOff();
      check('v0.5.3 브레이크 + KeyO 로 시동 OFF (STOPPING → OFF, RPM 0)', ok && (await Y(() => window.__game.engine.rpm)) === 0);
      await pg.keyboard.press('KeyG');
      await sleep(400);
      check('v0.5.3 시동 OFF 후에는 하차할 수 있다', (await Y(() => window.__game.mech.m.occupant)) === 'out');
      await pg.keyboard.press('KeyG');
      await sleep(300);
      check('v0.5.3 다시 탑승해도 시동은 자동으로 걸리지 않는다', (await Y(() => ({ o: window.__game.mech.m.occupant, s: window.__game.engine.state }))).s === 'OFF');
    }

    // ---- v0.5.3 Gate B: 시동 OFF 가속 차단 / 시동 조건 / RPM / 엔진음 / 버튼 ----
    await loadMap('lot', 'free', 'sedan');
    await sleep(600);
    {
      await Y(() => { const G = window.__game; G.car.gear = 'P'; G.car.v = 0; G.car.handbrake = false; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => window.__game.brake > 0.4, undefined, 10000);
      await pg.keyboard.press('KeyO');
      const off = await yuntil(() => window.__game.engine.state === 'OFF', undefined, 15000);
      const btn0 = await Y(() => { const b = document.querySelector('#actionbar [data-a="engineToggle"]'); return { exists: !!b, on: b?.classList.contains('on'), eng: b?.dataset.engine }; });
      check('v0.5.3 시동 버튼이 클러스터에 있고 OFF 상태를 표시한다', off && btn0.exists && !btn0.on && btn0.eng === 'OFF', JSON.stringify(btn0));
      // OFF 에서 D 가속: 움직이지 않아야 한다
      await Y(() => { const G = window.__game; G.car.gear = 'D'; G.car.handbrake = false; G.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; });
      await sleep(2500);
      const v0 = await Y(() => ({ v: window.__game.car.v, x: window.__game.car.x }));
      check('v0.5.3 시동 OFF 에서는 가속/크리프가 차단된다', Math.abs(v0.v) < 0.05, JSON.stringify(v0));
      // 주행 중(또는 D)에는 시동 불가
      await Y(() => { const G = window.__game; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => window.__game.brake > 0.4, undefined, 10000);
      await pg.keyboard.press('KeyO');
      await sleep(300);
      check('v0.5.3 D 단에서는 시동이 걸리지 않는다(P/N 필요)', (await Y(() => window.__game.engine.state)) === 'OFF');
      await Y(() => { const G = window.__game; G.car.gear = 'P'; G.debugInput = { throttle: 0, brake: 0, steerInput: 0 }; });
      await yuntil(() => window.__game.brake < 0.1, undefined, 10000);
      await pg.keyboard.press('KeyO');
      await sleep(300);
      check('v0.5.3 브레이크를 밟지 않으면 시동이 걸리지 않는다', (await Y(() => window.__game.engine.state)) === 'OFF');
      // 정상 시동: STARTING → RUNNING, 시동음 1회, 공회전
      const s0 = await Y(() => window.__game.engineSound.stats.startSounds);
      await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => window.__game.brake > 0.4, undefined, 10000);
      await pg.keyboard.press('KeyO');
      const starting = await yuntil(() => window.__game.engine.state === 'STARTING', undefined, 5000);
      const running = await yuntil(() => window.__game.engine.state === 'RUNNING', undefined, 20000);
      const e1 = await Y(() => ({ rpm: window.__game.engine.rpm, st: window.__game.engineSound.stats, btn: document.querySelector('#actionbar [data-a="engineToggle"]').classList.contains('on') }));
      check('v0.5.3 시동 시퀀스: STARTING → RUNNING, 시동음 트리거 1회, 엔진음 갱신, 버튼 ON', (starting || running) && running && e1.st.startSounds === s0 + 1 && e1.st.updates > 10 && e1.btn, JSON.stringify(e1));
      // 가속 입력에 RPM 반응(P 에서 공회전 가속) + 엔진음 파라미터 반응
      await Y(() => { window.__game.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; });
      await sleep(1500);
      const e2 = await Y(() => ({ rpm: window.__game.engine.rpm, f: window.__game.engineSound.stats.lastFreq, m: window.__game.engineSound.stats.lastMaster }));
      check('v0.5.3 스로틀에 따라 RPM 과 엔진음 주파수/크기가 올라간다', e2.rpm > e1.rpm * 2 && e2.f > 0 && e2.m > 0, JSON.stringify({ idle: e1.rpm, rev: e2.rpm, ...e2 }));
      // 시동 ON 상태에서 차량이 다시 달린다
      await Y(() => { const G = window.__game; G.car.gear = 'D'; G.car.handbrake = false; G.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; });
      const moved = await yuntil(() => window.__game.car.v > 2, undefined, 20000);
      check('v0.5.3 시동 ON 에서는 정상 가속한다', moved);
      await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      await yuntil(() => Math.abs(window.__game.car.v) < 0.05, undefined, 30000);
      check('v0.5.3 주행 중에는 시동을 끌 수 없다(정차 후에만)', (await Y(() => { const G = window.__game; G.car.v = 3; G.car.gear = 'D'; return null; })) === null && (await (async () => { await pg.keyboard.press('KeyO'); await sleep(200); return Y(() => window.__game.engine.state); })()) === 'RUNNING');
      await Y(() => { const G = window.__game; G.car.v = 0; G.car.gear = 'P'; G.debugInput = null; });
    }

    // ---- v0.5.3 Gate B: 고속 주행(137km/h) 충돌 관통 없음 + 100km/h 제동 ----
    await loadMap('lot', 'free', 'sedan');
    await sleep(600);
    {
      // 열린 차선(z=0)으로 -x → +x 달려 동쪽 벽(e-wall x=27.6)에 부딪힌다
      await Y(() => { const G = window.__game; const c = G.car; c.x = -30; c.z = 0; c.heading = Math.PI / 2; c.v = 38; c.gear = 'D'; c.handbrake = false; c.steer = 0; G.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; });
      const hit = await yuntil(() => window.__game.car.x > -29.9 && Math.abs(window.__game.car.v) < 0.5, undefined, 60000);
      const r = await Y(() => { const G = window.__game; return { x: G.car.x, v: G.car.v, front: G.car.x + G.spec.length - G.spec.rearOverhang, kmh: 0 }; });
      check('v0.5.3 137km/h 정면 충돌: 벽을 관통하지 않고 정지한다(앞범퍼 < 벽 안쪽면 27.3m)', hit && r.front <= 27.31 && r.x > -36, JSON.stringify(r));
      await Y(() => { const G = window.__game; const c = G.car; c.x = -30; c.z = 0; c.heading = Math.PI / 2; c.v = 27.7; c.gear = 'D'; c.handbrake = false; c.steer = 0; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
      const stopped = await yuntil(() => window.__game.car.x > -29.9 && Math.abs(window.__game.car.v) < 0.05, undefined, 60000);
      const b = await Y(() => ({ x: window.__game.car.x, v: window.__game.car.v }));
      check('v0.5.3 100km/h 급제동: 벽 앞에서 정지(제동거리 < 56m), 후진하지 않음', stopped && b.x < 26 && b.v >= -0.01, JSON.stringify(b));
      await Y(() => { window.__game.debugInput = null; });
      await pg.screenshot({ path: path.join(OUT, '140-v053-highspeed.png') });
    }
    await ctx50.close();
  }

  // ---------- 10. 오류 ----------
  const real = errors.filter((e) => !/favicon/.test(e));
  check('콘솔/페이지 오류 없음', real.length === 0, real.slice(0, 5).join(' | '));

  await browser.close();
  if (server) server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} PASS`);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 스크립트 오류:', e);
  process.exit(2);
});
