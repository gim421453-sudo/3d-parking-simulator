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


  // (v0.5.x 블록만 실행하는 추출본: e2e-smoke.cjs 의 v0.5.0~ 블록과 동일 — 빠른 반복용)
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
    const M = () => Y(() => { const G = window.__game; const m = G.mech.m; return { x: G.car.x, z: G.car.z, y: G.car.y, v: G.car.v, h: G.car.heading, phase: m.phase, door: m.door, cy: m.carriage.y, cz: m.carriage.z, yaw: m.yaw, pl: m.palletLoc, occ: Object.entries(m.slots).filter(([, q]) => q).map(([k, q]) => k + ':' + q.mode), stored: [...G.storedModels.keys()].map((k) => k.split('/').pop()), msg: m.message, mission: G.mission && G.mission.status, state: G.state, guide: G.mech.guide.state, seat: G.mech.seatCount, led: G.mechBuilt.statusState, locked: m.locked, occupant: m.occupant, spec: G.spec.id }; });
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
    await yuntil(() => window.__game.state === 'result', undefined, 400000);
    const f2 = await M();
    check('v0.5.2 전진 입고 미션 성공: 2F A 슬롯에 보관', f2.mission === 'success' && f2.occ.includes('02A:fwd') && f2.stored.includes('02A'), JSON.stringify(f2));

    // ---- 12층 입고 (최상층까지 실제 승강) ----
    await loadMap('mechpark', 'mech-in-12f', 'sedan');
    await creepIn('D', 0.5, -9.5, -3.5);
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.mech.m.carriage.y > 32.9, undefined, 400000);
    const t12 = await M();
    check('v0.5.2 12층: 캐리지/차량이 실제 높이 33m(12F)까지 상승하고 차량-캐리지 높이가 같다', t12.cy > 32.9 && Math.abs(t12.y - t12.cy) < 1e-6 && t12.pl === 'carriage', JSON.stringify(t12));
    // 자유 시점 카메라가 차량 높이를 따라간다
    await Y(() => { const G = window.__game; G.rig.setMode('free', G.poseNow()); });
    await sleep(1200);
    const camY = await Y(() => ({ cam: window.__game.rig.active.position.y, car: window.__game.car.y }));
    check('v0.5.2 자유 시점 카메라가 12층 높이의 차량을 추적(카메라 y ≥ 차량 y)', camY.cam >= camY.car && camY.car > 30, JSON.stringify(camY));
    await Y(() => { const G = window.__game; G.rig.setMode('chase', G.poseNow()); });
    await yuntil(() => window.__game.state === 'result', undefined, 400000);
    const f12 = await M();
    check('v0.5.2 12F A 입고 미션 성공 + 빈 승강 플랫폼이 1층으로 복귀(캐리지 y=0, 새 팔레트 공급)', f12.mission === 'success' && f12.occ.includes('12A:fwd'), JSON.stringify(f12));
    await yuntil(() => window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, undefined, 400000).catch(() => {});
    await pg.screenshot({ path: path.join(OUT, '135-v052-12f-stored.png') });

    // ---- 후진 입고 → 8F A: 안내판 방향(후진), 정위치 판정(뒷차축), 보관 ----
    await loadMap('mechpark', 'mech-in-rev', 'sedan');
    const rv0 = await M();
    check('v0.5.2 후진 입고 시작: 안내판이 후진 입고 방향을 안내("후진")', rv0.guide === 'back' && Math.abs(Math.sin(rv0.h)) > 0.99 && Math.sin(rv0.h) < 0, JSON.stringify(rv0));
    await creepIn('R', 0.4, -8.5, -0.76);
    const rv1 = await M();
    check('v0.5.2 후진 입고: 뒷바퀴가 정지 홈에 안착(이벤트), 안내판 "정지"', rv1.seat >= 1 && rv1.guide === 'stop', JSON.stringify(rv1));
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); await pg.keyboard.press('KeyJ');
    await yuntil(() => window.__game.state === 'result', undefined, 500000);
    const rv2 = await M();
    check('v0.5.2 후진 입고 미션 성공: 8F A 에 후진 입고(rev) 보관', rv2.mission === 'success' && rv2.occ.includes('08A:rev'), JSON.stringify(rv2));

    // ---- 출고(전진 입고 차량: 호출→인출→하강→180° 회전→문 열림) → 전진 출차 → 미션 성공 ----
    await loadMap('mechpark', 'mech-out-1', 'sedan');
    await pg.keyboard.press('KeyK');
    await yuntil(() => window.__game.mech.m.phase === 'rotating' && window.__game.mech.m.yaw > 0.8, undefined, 500000);
    const ro = await Y(() => ({ yaw: window.__game.mech.m.yaw, py: window.__game.mechBuilt.pallet.rotation.y, door: window.__game.mech.m.door, locked: window.__game.mech.m.locked, occ: window.__game.mech.m.occupant, led: window.__game.mechBuilt.statusState }));
    check('v0.5.2 출고 회전: 3D 팔레트가 실제로 회전, 회전 중 문 닫힘/차량 고정/하차 상태, LED 출고 중', ro.yaw > 0.8 && Math.abs(ro.py - ro.yaw) < 1e-6 && ro.door === 0 && ro.locked && ro.occ === 'out' && /retrieving/.test(ro.led), JSON.stringify(ro));
    await yuntil(() => window.__game.mech.m.phase === 'exit', undefined, 400000);
    const ex = await M();
    check('v0.5.2 출고 완료: 보관 차량 인수(교체), 지상/문 열림/문(서쪽)을 향함, 슬롯 비워짐', ex.cy === 0 && ex.y === 0 && ex.door === 1 && Math.sin(ex.h) < -0.99 && !ex.occ.includes('08A:fwd') && ex.spec === 'sedan', JSON.stringify(ex));
    await engineOff(); await pg.keyboard.press('KeyG'); await sleep(300); check('v0.5.3 출고 후 탑승해도 시동은 자동으로 걸리지 않는다(OFF), 직접 시동해야 출차 가능', (await Y(() => window.__game.engine.state)) === 'OFF' && (await engineOn()));
    await Y(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.debugInput = { throttle: 0.6, brake: 0, steerInput: 0 }; });
    await yuntil(() => window.__game.car.x < -21.0, undefined, 300000);
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
    await yuntil(() => window.__game.mech.m.carriage.y > 8, undefined, 400000);
    const hl = await Y(() => { const G = window.__game; const c = G.rig.active.position; return { camCarDist: Math.hypot(c.x - G.car.x, c.y - G.car.y, c.z - G.car.z), carY: G.car.y, cy: G.mech.m.carriage.y, modelY: G.model.root.position.y }; });
    check('v0.5.2 핫픽스: 상승 중 카메라가 차량을 추적(거리 < 40m)하고 모델/차량/캐리지 높이가 일치', hl.camCarDist < 40 && Math.abs(hl.carY - hl.cy) < 1e-6 && Math.abs(hl.modelY - hl.cy) < 0.05, JSON.stringify(hl));
    await pg.screenshot({ path: path.join(OUT, '136-v052hf-lifting.png') });
    await yuntil(() => !!window.__game.mech.m.slots['08A'] && window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, undefined, 500000);
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
    await yuntil(([t]) => window.__game.mech.m.clock > t + 10, [idle0.t], 240000);
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
    await yuntil(() => window.__game.lastHitId === 'bol-1n' || window.__game.lastHitId === 'bol-2n', undefined, 240000); // 게임 상태를 기다린다
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
      const stored = await yuntil(() => { const G = window.__game; return !!G.facilities[0].ctl.m.slots['03B'] && G.facilities[0].ctl.m.phase === 'waiting' && !!G.playerStoredSlot; }, undefined, 300000);
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
