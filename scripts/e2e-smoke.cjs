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
  const placeHold = async (cx, cz, h, gear) => { await place(cx, cz, h, gear); await g(() => { window.__game.car.handbrake = true; }); };

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
  check('차량 선택 화면 (기본 3종 + M4/X6 프로필 + GLB 시험)', (await page.locator('#cars .option').count()) === 6);
  await shot('03-vehicles');
  await page.click('#back');
  await page.click('#m-map');
  check('맵 선택 화면 (평면 3종 + 다층 주차타워)', (await page.locator('#maps .option').count()) === 4);
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
  check('R: 주차 보조 패널 표시 + 후방카메라 + 사이드 버튼 4개', aR.visible && aR.camera === 'rear' && aR.side.length === 4, JSON.stringify({ v: aR.visible, c: aR.camera, n: aR.side.length }));
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
  await page.click('#parking-assist [data-pa="camera"]');
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
  const entries = (z) => Object.entries(z.lit);
  const frontOnly = entries(zF).length > 0 && entries(zF).every(([, v]) => v.dy < 0) && nonLit(zF, REAR_IDS);
  check('앞쪽 벽 → 앞 구역만 점등(뒤 구역 소등), 화면에서도 모두 차량 위쪽', frontOnly, JSON.stringify(Object.keys(zF.lit)));
  // 북향, 서쪽 벽이 오른쪽 옆 (앞뒤 모서리 센서는 옆벽을 비스듬히 감지하는 것이 정상 — 모두 오른쪽에 표시되어야 함)
  await placeHold(-36 + 0.9 + W / 2, 10, 0, 'D');
  await sleep(700);
  const zR = await zoneProbe();
  const rightOnly = entries(zR).length > 0 && entries(zR).every(([, v]) => v.dx > 0) && nonLit(zR, LEFT_IDS);
  check('오른쪽 벽 → 점등 구역이 모두 화면 오른쪽, 왼쪽 구역 전부 소등', rightOnly, JSON.stringify(Object.keys(zR.lit)));
  // 남향: 같은 벽이 왼쪽 옆
  await placeHold(-36 + 0.9 + W / 2, 10, Math.PI, 'D');
  await sleep(700);
  const zL = await zoneProbe();
  const leftOnly = entries(zL).length > 0 && entries(zL).every(([, v]) => v.dx < 0) && nonLit(zL, RIGHT_IDS);
  check('왼쪽 벽 → 점등 구역이 모두 화면 왼쪽, 오른쪽 구역 전부 소등 (좌우 반전 없음)', leftOnly, JSON.stringify(Object.keys(zL.lit)));
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
  const surround = await g(() => ({ btn: !!document.querySelector('[data-pa="surround"]'), txt: /360|서라운드|3D ?뷰/.test(document.getElementById('parking-assist').innerText) }));
  check('서라운드뷰 미지원 상태: 가짜 360도 버튼/영상 없음', !surround.btn && !surround.txt, JSON.stringify(surround));

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
    check(`화면 ${w}×${h}: 사이드 버튼 4개 높이 ≥ 36px`, lay.side.length === 4 && lay.side.every((v) => v >= 36), JSON.stringify(lay.side.map(Math.round)));
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
  for (let i = 0; i < 5; i++) { await page.click('#parking-assist [data-pa="camera"]'); await sleep(120); }
  await sleep(500);
  const man = await g(() => ({ view: window.__game.viewOut.view, auto: window.__game.viewOut.auto, mode: window.__game.assist.cameraMode }));
  check('수동 카메라(탑뷰) 선택이 자동 측면 전환보다 우선', man.view === 'top' && man.auto === false && man.mode === 'top', JSON.stringify(man));
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
  await shot('116-x6-rear-overlay');
  check('카메라 영상 위 장애물 구역: 감지가 없으면 그리지 않고, 후방 벽 감지 시 구역이 추가로 그려짐', freeZones === 0 && wallPix > freePix + 300, JSON.stringify({ freeZones, freePix, wallPix }));
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
  check('시나리오3 양쪽에 주차 차량 근접 → 전체 탑뷰', await viewIs('top'));
  await sleep(1800);
  await shot('121-s3-top');
  const topCam = await g(() => window.__game.rig.assistCamera.position.y);
  const topFit = (await g(() => { const G = window.__game; const c = G.rig.assistCamera; const pts = G.colliders.filter((q) => String(q.id).startsWith('t-')).map((q) => [q.x, q.z - 0, q.w / 2, q.d / 2]); return pts.every(([x, z, hw, hd]) => [[x - hw, z - hd], [x + hw, z + hd]].every(([px, pz]) => { const v = new c.position.constructor(px, 0.5, pz).project(c); return Math.abs(v.x) <= 1.15 && Math.abs(v.y) <= 1.15; })); })) && topCam !== 12.5;
  check('시나리오3: 전체 탑뷰는 차량과 양쪽 장애물이 모두 보이고 높이가 고정값(12.5)이 아님', topFit, String(topCam));
  // 카메라 안정화: 전환 완료 후에는 센서 히트가 바뀌어도 구도(차량 기준 위치/높이/FOV)가 변하지 않고 차량만 따라간다
  const camLocal = () => g(() => { const G = window.__game; const c = G.rig.assistCamera; const p = G.poseNow(); const dx = c.position.x - p.x; const dz = c.position.z - p.z; const cs = Math.cos(p.heading); const sn = Math.sin(p.heading); return { lx: dx * cs - dz * sn, lz: dx * sn + dz * cs, y: c.position.y, fov: c.fov, settled: G.rig.assistSettled }; });
  await until(() => window.__game.rig.assistSettled, undefined, 20000);
  const cl0 = await camLocal();
  await addBox('extra', SX, SZ - Ls / 2 - 1.2, 3, 0.5); // 후방 장애물(진행 방향이 아니므로 시점을 바꾸지 않음)
  await g(() => { const c = window.__game.car; c.z += 0.6; });
  await sleep(2500);
  const cl1 = await camLocal();
  const stable = cl0.settled && Math.abs(cl0.lx - cl1.lx) < 0.05 && Math.abs(cl0.lz - cl1.lz) < 0.05 && Math.abs(cl0.y - cl1.y) < 0.02 && Math.abs(cl0.fov - cl1.fov) < 0.01;
  check('카메라 안정화: 전환 후 새 장애물/차량 이동에도 구도(차량 기준 위치·높이·FOV)가 고정되고 차량만 추적', stable, JSON.stringify({ cl0, cl1 }));
  await clearTest();
  await viewIs('front');
  // 4. 좁은 주차칸 후진 진입 (R, 양쪽 + 뒤 벽)
  await startAt('R');
  await addBox('n1', SX + sideX(0.5), SZ, 0.5, 9);
  await addBox('n2', SX - sideX(0.5), SZ, 0.5, 9);
  check('시나리오4 좁은 주차칸 후진 진입(양측 근접, 후방은 아직 여유) → 전체 탑뷰', await viewIs('top'));
  await shot('122-s4-narrow-reverse');
  await clearTest();
  await viewIs('rear');
  // 5. 기둥 옆 통과
  await startAt('D');
  await addCyl('pil', SX + Ws / 2 + 0.6, SZ + Ls * 0.2, 0.3);
  check('시나리오5 기둥 옆을 근접 통과 → 확대 탑뷰', await viewIs('topZoom'));
  await sleep(1800);
  await shot('123-s5-pillar-zoom');
  const zoomY = await g(() => window.__game.rig.assistCamera.position.y);
  check('시나리오5: 확대 탑뷰는 전체 탑뷰보다 낮지만 5m 이상(상대 위치 판단 가능)', zoomY >= 4.8 && zoomY < 14, String(zoomY));
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
  const v9 = await until(() => ['topZoom', 'top'].includes(window.__game.viewOut.view), undefined, 45000);
  check('시나리오9 매우 가까운 측면 장애물(0.3m) → 탑뷰 계열로 전환(측면뷰 금지)', v9 && (await g(() => window.__game.viewOut.view)) !== 'left');
  await clearTest();
  await viewIs('front');

  // 11. N 기어: 자동 시점 전환 없음
  await startAt('N');
  await addBox('n1', SX + sideX(0.6), SZ, 0.5, 9);
  await addBox('n2', SX - sideX(0.6), SZ, 0.5, 9);
  await sleep(4000);
  const vN = await g(() => ({ v: window.__game.viewOut.view, auto: window.__game.viewOut.auto }));
  check('N 기어: 양측 장애물이 있어도 자동 시점 전환을 하지 않음', vN.auto === false && !['top', 'left', 'right', 'topZoom'].includes(vN.v), JSON.stringify(vN));
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
    check('핸들: 손을 떼면 중앙으로 복귀', Math.abs(afterRel) < 540, String(afterRel));
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
    check('멀티터치: 핸들 + 브레이크 동시 (서로 입력을 가로채지 않음)', wb.brake === true && wb.a > 80, JSON.stringify(wb));
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
    check('모바일: 사이드 버튼 높이 ≥ 40px', rects.side.length === 4 && rects.side.every((b) => b.h >= 40), JSON.stringify(rects.side.map((b) => Math.round(b.h))));
    const fpsTxt = await mp.evaluate(() => document.getElementById('fps').textContent);
    check('모바일: FPS 표시', /FPS/.test(fpsTxt), fpsTxt);
    await mp.screenshot({ path: path.join(OUT, '92-mobile-steer.png') });
    await mctx.close();
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
