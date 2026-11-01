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

  // ---------- 1. 시작 화면 ----------
  await page.goto(URL);
  await page.waitForSelector('.screen .card', { timeout: 15000 });
  await shot('01-main-menu');
  check('시작 화면 표시', (await page.locator('text=게임 시작').count()) > 0);
  check('메뉴 항목(맵/차량/설정/조작법)', (await page.locator('#m-map, #m-car, #m-set, #m-keys').count()) === 4);
  await page.click('#m-keys');
  check('조작법 화면', (await page.locator('kbd').count()) > 10);
  await shot('02-controls');
  await page.click('#back');
  await page.click('#m-car');
  check('차량 선택 화면 (3종)', (await page.locator('#cars .option').count()) === 3);
  await shot('03-vehicles');
  await page.click('#back');
  await page.click('#m-map');
  check('맵 선택 화면 (3종)', (await page.locator('#maps .option').count()) === 3);
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

  await page.keyboard.press('KeyF');
  await page.keyboard.down('KeyW');
  const okFwd = await until(() => window.__game.car.v > 3);
  await shot('11-driving-forward');
  const fwd = await g(() => ({ v: window.__game.car.v, gear: window.__game.car.gear }));
  check('D 기어 가속 전진', okFwd && fwd.gear === 'D', JSON.stringify(fwd));
  await page.keyboard.press('KeyR');
  check('주행 중 R 기어 전환 거부', await g(() => window.__game.car.gear === 'D'));
  await page.keyboard.press('KeyP');
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
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyC');
    await sleep(600);
    modes.push(await g(() => window.__game.rig.mode));
    await shot(`20-camera-${i}-${modes[i]}`);
  }
  check('카메라 5종 순환(추적→1인칭→탑뷰→후방→자유→추적)', new Set(modes).size === 5 && modes[4] === 'chase', modes.join(','));

  // ---------- 4. 후진 + 후방 카메라 ----------
  await place(0, -6, 0, 'P');
  await sleep(200);
  await page.keyboard.press('KeyR');
  check('정차 후 R 기어 선택', await g(() => window.__game.car.gear === 'R'));
  await page.keyboard.down('KeyW');
  const okRev = await until(() => window.__game.car.v < -1.5);
  const pipOn = await g(() => !document.getElementById('rear-pip').classList.contains('hidden'));
  await shot('30-reverse-pip');
  await page.keyboard.up('KeyW');
  check('R 기어 후진 이동', okRev);
  check('R 기어에서 후방 카메라 보조 화면 자동 표시', pipOn);
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
  // 후방 카메라 전체화면
  await g(() => window.__game.rig.setMode('rear'));
  await sleep(600);
  await shot('31-rear-camera-full');

  // ---------- 5. 센서 ----------
  await g(() => window.__game.rig.setMode('chase'));
  const L = await g(() => window.__game.spec.length);
  const W = await g(() => window.__game.spec.width);
  // 서쪽 벽 안쪽 면 x=-36. 서쪽을 보고(heading=-π/2) 앞 범퍼-벽 간격 1.00m
  await place(-36 + 1.0 + L / 2, 10, -Math.PI / 2, 'D');
  await sleep(500);
  const s1 = await g(() => ({ front: window.__game.sensorSnap.groupMin.front, rear: window.__game.sensorSnap.groupMin.rear }));
  check('센서 전방 거리 = 실제 벽까지 1.00m', s1.front !== null && Math.abs(s1.front - 1.0) < 0.03, JSON.stringify(s1));
  await place(-36 + 0.9 + W / 2, 10, 0, 'D'); // 북쪽을 봄: 벽은 오른쪽 옆
  await sleep(400);
  let s3 = await g(() => ({ f: window.__game.sensorSnap.groupMin.front, l: window.__game.sensorSnap.groupMin.left, r: window.__game.sensorSnap.groupMin.right, b: window.__game.sensorSnap.groupMin.rear }));
  check('차량 회전(북향): 서쪽 벽은 오른쪽 센서가 0.90m로 감지, 왼쪽은 미검출 (앞 모서리 센서는 비스듬히 더 먼 거리)', s3.r !== null && Math.abs(s3.r - 0.9) < 0.03 && s3.l === null && (s3.f === null || s3.f >= 0.9), JSON.stringify(s3));
  await place(-36 + 0.9 + W / 2, 10, Math.PI, 'D'); // 남향: 벽은 왼쪽 옆
  await sleep(400);
  s3 = await g(() => ({ f: window.__game.sensorSnap.groupMin.front, l: window.__game.sensorSnap.groupMin.left, r: window.__game.sensorSnap.groupMin.right }));
  check('차량 회전(남향): 서쪽 벽은 왼쪽 센서가 감지', s3.l !== null && Math.abs(s3.l - 0.9) < 0.03 && s3.r === null, JSON.stringify(s3));
  const gaps = [2.2, 1.5, 0.8, 0.4, 0.2];
  const meas = [];
  const levels = [];
  for (const gap of gaps) {
    await place(-36 + gap + L / 2, 10, -Math.PI / 2, 'D');
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
  await place(-36 + 0.8 + L / 2, 10, -Math.PI / 2, 'D');
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
  await page.keyboard.press('KeyR');
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

  // ---------- 9. 설정 저장 ----------
  await g(() => window.__game.updateSettings({ sensorRange: 3.2, showFps: true, sensorSound: false }));
  await page.reload();
  await page.waitForSelector('.screen .card');
  const saved = await g(() => ({ r: window.__game.settings.sensorRange, f: window.__game.settings.showFps, s: window.__game.settings.sensorSound }));
  check('설정이 새로고침 후에도 유지', saved.r === 3.2 && saved.f === true && saved.s === false, JSON.stringify(saved));
  await g(() => window.__game.updateSettings({ sensorSound: true, showFps: false, sensorRange: 2.5 }));

  // ---------- 10. 맵 3종 + 전체 미션 판정 ----------
  for (const [mapId, vehicle, mission] of [['lot', 'compact', 'lot-front'], ['underground', 'sedan', 'ug-reverse'], ['outdoor', 'suv', 'out-parallel']]) {
    await g(({ mapId, vehicle, mission }) => { const G = window.__game; G.updateSettings({ mapId, missionId: mission, vehicleId: vehicle }); G.startRun(); }, { mapId, vehicle, mission });
    await sleep(1500);
    await shot(`80-map-${mapId}`);
    const info = await g(() => ({ id: window.__game.map.id, n: window.__game.map.obstacles.length, state: window.__game.state }));
    check(`맵 로딩: ${mapId}`, info.id === mapId && info.state === 'playing' && info.n > 10, JSON.stringify(info));
    await page.keyboard.press('KeyF');
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
    const sizes = await mp.evaluate(() => [...document.querySelectorAll('#touch .tbtn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    check('모바일: 터치 버튼 크기 ≥ 48px', sizes.length === 4 && sizes.every(([w, h]) => w >= 48 && h >= 48), JSON.stringify(sizes));
    const gearBox = await mp.evaluate(() => { const r = document.querySelector('#gears button[data-g="D"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    check('모바일: 기어 버튼 터치 크기 ≥ 40×40px', gearBox[0] >= 40 && gearBox[1] >= 40, JSON.stringify(gearBox));
    const barBtn = await mp.evaluate(() => [...document.querySelectorAll('#actionbar button, .iconbar button')].map((b) => Math.round(b.getBoundingClientRect().height)));
    check('모바일: HUD 버튼 높이 ≥ 40px', barBtn.length > 8 && barBtn.every((h) => h >= 40), JSON.stringify(barBtn));
    await mp.tap('#gears button[data-g="D"]');
    check('모바일: 화면 D 버튼으로 기어 변경', await mp.evaluate(() => window.__game.car.gear === 'D'));
    // 가속 버튼 누르고 있기 (CDP 터치)
    const cdp = await mctx.newCDPSession(mp);
    const gas = await mp.evaluate(() => { const r = document.querySelector('#touch .gas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gas.x, y: gas.y, id: 1 }] });
    const okGas = await mp.waitForFunction(() => window.__game.car.v > 2, null, { timeout: 25000, polling: 100 }).then(() => true).catch(() => false);
    await mp.screenshot({ path: path.join(OUT, '91-mobile-driving.png') });
    // 가속 + 왼쪽 조향 동시 터치 (멀티터치)
    const left = await mp.evaluate(() => { const r = document.querySelector('#t-steer .tbtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const hh0 = await mp.evaluate(() => window.__game.car.heading);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gas.x, y: gas.y, id: 1 }, { x: left.x, y: left.y, id: 2 }] });
    const okSteer = await mp.waitForFunction((h) => window.__game.car.heading > h + 0.1, hh0, { timeout: 25000, polling: 100 }).then(() => true).catch(() => false);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    check('모바일: 가속 버튼 홀드로 전진', okGas);
    check('모바일: 멀티터치(가속+왼쪽 조향)로 좌회전', okSteer);
    const released = await mp.evaluate(() => !window.__game.input.held.throttle && !window.__game.input.held.left);
    check('모바일: 손을 떼면 입력 해제', released);
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
