/**
 * v0.5.5 브라우저 통합 테스트: 방향지시등 자동 해제 · 시동 OFF 화면 꺼짐 · 제동등 · 시동 끄기 완화 · 4주식 리프트 · 모든 맵 기계식 부속 구역 · 계기판 데이터.
 *   node scripts/e2e-v055.cjs          (dist 필요)
 * 시간이 아니라 게임 상태를 기다린다. 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 4351;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v055');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: true, engineVolume: 0.4 })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 240000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const loadMap = async (mapId, missionId, veh) => {
    await Y(([mapId, missionId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId, vehicleId: veh }); G.startRun(); }, [mapId, missionId, veh]);
    await until((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 60000);
    await sleep(800);
  };
  const put = (x, z, h) => Y(([x, z, h]) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = x - Math.sin(h) * off; c.z = z - Math.cos(h) * off; c.heading = h; c.y = 0; c.v = 0; c.steer = 0; c.pitch = 0; c.gear = 'D'; c.handbrake = false; G.collisions = 0; G.rig.snap(); }, [x, z, h]);
  const input = (o) => Y((o) => { window.__game.debugInput = o; }, o);

  // ================= 1. 방향지시등 자동 해제 =================
  await put(0, -6, 0);
  await Y(() => { const G = window.__game; G.car.gear = 'P'; G.car.handbrake = true; });
  await pg.keyboard.press('KeyQ').catch(() => {});
  let sig = await Y(() => ({ l: window.__game.sigLeft, r: window.__game.sigRight }));
  if (!sig.l && !sig.r) { await Y(() => window.__game.onAction('signalLeft')); sig = await Y(() => ({ l: window.__game.sigLeft, r: window.__game.sigRight })); }
  const leftOn = sig.l;
  const deg = () => Y(() => { const G = window.__game; return (G.car.steer / G.spec.maxSteer) * 540; });
  // 실제 조향 입력으로 핸들을 돌린다(정차 중에는 놓아도 각도가 유지되므로 반대로 돌려서 푼다)
  const turnTo = async (target) => {
    const cur = await deg();
    const dir = target > cur ? 1 : -1;
    await input({ throttle: 0, brake: 1, steerInput: dir });
    const ok = await until(([t, d]) => { const G = window.__game; const w = (G.car.steer / G.spec.maxSteer) * 540; return d > 0 ? w >= t : w <= t; }, [target, dir], 30000);
    const reached = await deg(); // 입력을 놓기 전 실제 도달 각도
    await input({ throttle: 0, brake: 1, steerInput: 0 });
    await sleep(250);
    return ok ? reached : NaN;
  };
  // 왼쪽 깜빡이: 100° 만 돌렸다 풀면 유지
  await turnTo(100);
  await turnTo(5);
  await sleep(400);
  const keep = await Y(() => window.__game.sigLeft);
  // 220° 까지 돌린 동안은 유지, 풀리면 해제
  const c0 = await Y(() => window.__game.sigAutoCancels);
  const dmax = await turnTo(220);
  const armed = await Y(() => window.__game.sigLeft);
  await turnTo(5);
  const cancelled = await until(() => !window.__game.sigLeft, undefined, 10000);
  const c1 = await Y(() => window.__game.sigAutoCancels);
  check('방향지시등: 왼쪽 켜짐 → 핸들 100° 만 돌렸다 풀면 유지', leftOn && keep, JSON.stringify({ leftOn, keep }));
  check('방향지시등: 같은 방향으로 180° 이상(220°) 돌린 동안은 유지, 풀리면 자동 해제(해제 횟수 +1)', armed && dmax > 180 && cancelled && c1 === c0 + 1, JSON.stringify({ armed, dmax: Math.round(dmax), cancelled, c0, c1 }));
  // 반대 방향으로 돌렸다 풀면 해제되지 않는다
  await Y(() => { const G = window.__game; if (!G.sigLeft) G.onAction('signalLeft'); });
  await turnTo(-300);
  await turnTo(-5);
  await sleep(500);
  const st3 = await Y(() => ({ l: window.__game.sigLeft, n: window.__game.sigAutoCancels }));
  check('방향지시등: 반대 방향(오른쪽 300°)으로 돌렸다 풀어도 왼쪽 깜빡이는 유지', st3.l && st3.n === c1, JSON.stringify(st3));
  await Y(() => { if (window.__game.sigLeft) window.__game.onAction('signalLeft'); });
  await input(null);

  // ================= 2. 제동등 =================
  await Y(() => { window.__game.car.handbrake = false; }); // 주차 브레이크가 걸려 있으면 제동등이 계속 켜진다(기존 동작)
  await input({ throttle: 0, brake: 1, steerInput: 0 });
  await until(() => window.__game.brake > 0.4, undefined, 10000);
  await sleep(300);
  const bOn = await Y(() => { const m = window.__game.model; return { glow: m.brakeGlow ? m.brakeGlow.intensity : -1 }; });
  await input({ throttle: 0, brake: 0, steerInput: 0 });
  await until(() => window.__game.brake < 0.05, undefined, 10000);
  await sleep(300);
  const bOff = await Y(() => { const m = window.__game.model; return { glow: m.brakeGlow ? m.brakeGlow.intensity : -1 }; });
  check('제동등: 브레이크를 밟으면 뒤쪽 붉은 조명(세기 7)이 켜지고 떼면 꺼진다', bOn.glow >= 6 && bOff.glow === 0, JSON.stringify({ bOn, bOff }));
  await input(null);

  // ================= 3. 계기판 데이터 + 시동 끄기 완화 + 화면 꺼짐 =================
  for (let i = 0; i < 6 && (await Y(() => window.__game.rig.mode !== 'driver')); i++) { await pg.keyboard.press('KeyC'); await sleep(250); }
  await Y(() => { window.__game.car.gear = 'D'; window.__game.car.handbrake = false; });
  await input({ throttle: 0, brake: 1, steerInput: 0 });
  await until(() => { const d = window.__game.lastClusterData; return d && d.brake > 0.4; }, undefined, 15000);
  const cd = await Y(() => { const G = window.__game; const d = G.lastClusterData; return { brake: d.brake, thr: d.throttle, max: d.speedMax, red: d.redline, prof: G.engine.profile.redline, label: d.engineLabel, clock: d.clock, zones: d.zones, pitch: d.pitchDeg, locked: d.locked, door: d.doorOpen, es: d.engineState }; });
  check('계기판: 페달 입력·속도 눈금(60)·엔진 적색 구간·엔진 이름·시계·방향별 PDC·경사·고정 상태가 실제 게임 상태와 일치', cd.brake > 0.4 && cd.thr === 0 && cd.max === 60 && cd.red === cd.prof && /합성/.test(cd.label) && /^\d\d:\d\d$/.test(cd.clock) && cd.zones && 'front' in cd.zones && Math.abs(cd.pitch) < 0.5 && cd.locked === null && cd.door === false && cd.es === 'RUNNING', JSON.stringify(cd));
  await pg.screenshot({ path: path.join(OUT, 'e2e-01-cluster-driver.png') });
  // D 단 정차 상태에서 시동 끄기 → 허용 + P 자동 변속
  await pg.keyboard.press('KeyO');
  const offOk = await until(() => window.__game.engine.state === 'OFF', undefined, 20000);
  await until(() => window.__game.lastClusterData === null, undefined, 10000);
  const g1 = await Y(() => ({ gear: window.__game.car.gear, screens: window.__game.screensOn, cd: window.__game.lastClusterData }));
  check('시동 끄기(조건 완화): D 단 정차 상태에서도 꺼지고 P 단으로 자동 변속', offOk && g1.gear === 'P', JSON.stringify({ offOk, gear: g1.gear }));
  await sleep(600);
  const px = await Y(() => { const cab = window.__game.model.cabin; const sample = (cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let mx = 0; for (let i = 0; i < d.length; i += 4 * 97) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]); return mx; }; return { cluster: sample(cab.cluster.canvas), center: sample(cab.center.canvas), hits: window.__game.cabinHits ? window.__game.cabinHits.length : 0, float: !document.getElementById('parking-assist') || document.getElementById('parking-assist').classList.contains('hidden') }; });
  check('시동 OFF: 계기판·중앙(내비) 화면이 모두 꺼진다(캔버스 최대 밝기 < 10, 터치 영역 없음, 계기판 데이터 없음)', g1.screens === false && g1.cd === null && px.cluster < 10 && px.center < 10 && px.hits === 0, JSON.stringify(px));
  await pg.screenshot({ path: path.join(OUT, 'e2e-02-screens-off.png') });
  // 다시 시동 → 화면 켜짐
  await pg.keyboard.press('KeyO');
  const onOk = await until(() => window.__game.engine.state === 'RUNNING' && !!window.__game.lastClusterData, undefined, 30000);
  check('다시 시동을 걸면 화면이 켜진다', onOk && (await Y(() => window.__game.screensOn)));
  const es = await Y(() => window.__game.engineSound.stats);
  check('엔진음(재제작): 오디오 그래프가 만들어지고 갱신된다(재생 속도 = rpm/1200)', es.ctx && es.rebuilds >= 1 && es.updates > 10 && es.lastRate > 0.3, JSON.stringify(es));
  await input(null);
  for (let i = 0; i < 6 && (await Y(() => window.__game.rig.mode !== 'chase')); i++) { await pg.keyboard.press('KeyC'); await sleep(250); }

  // ================= 4. 정비소 4주식 리프트 =================
  await loadMap('garage', 'free', 'sedan');
  const L4 = await Y(() => { const G = window.__game; const i = G.lifts.findIndex((l) => l.cfg.kind === '4post'); return { i, n: G.lifts.length, ...G.lifts[i].cfg }; });
  await put(L4.x, L4.z, 0);
  await input({ throttle: 0, brake: 1, steerInput: 0 });
  await sleep(600);
  await Y(() => { const G = window.__game; G.car.gear = 'P'; });
  await sleep(500);
  const l4 = await Y((i) => { const G = window.__game; return { active: G.activeLift === G.lifts[i], title: document.querySelector('#lift-panel') ? document.querySelector('#lift-panel').textContent : '', checks: G.liftChecks.filter((c) => !c.ok).map((c) => c.key), col: G.collisions }; }, L4.i);
  check('정비소: 리프트 2기(2주식+4주식), 4주식 주행판 위 정위치에서 패널에 "4주식 리프트" 표시·조건 충족', L4.n === 2 && l4.active && /4주식/.test(l4.title) && l4.checks.length === 0, JSON.stringify(l4));
  await pg.keyboard.press('PageUp');
  const up4 = await until((i) => window.__game.lifts[i].st.phase === 'holding', L4.i, 180000);
  const s4 = await Y((i) => { const G = window.__game; return { h: G.lifts[i].st.h, carY: G.car.y, hb: G.car.handbrake, locked: G.lastClusterData ? G.lastClusterData.locked : 'n/a' }; }, L4.i);
  check('4주식 리프트: 최고 높이 1.9m 까지 차량이 주행판과 함께 올라가고 주차 브레이크 자동 체결', up4 && Math.abs(s4.h - 1.9) < 1e-6 && Math.abs(s4.carY - 1.9) < 0.02 && s4.hb === true, JSON.stringify(s4));
  await pg.screenshot({ path: path.join(OUT, 'e2e-03-lift4-up.png') });
  await pg.keyboard.press('PageDown');
  const dn4 = await until((i) => { const s = window.__game.lifts[i].st; return s.phase === 'idle' && !s.locked; }, L4.i, 180000);
  check('4주식 리프트: 하강 후 고정 해제, 차량이 바닥(y=0)으로 돌아온다', dn4 && Math.abs(await Y(() => window.__game.car.y)) < 0.02);
  await input(null);

  // ================= 5. 모든 맵에 기계식 시설 =================
  const all = await Y(async () => { const M = window.__maps || null; return M; });
  void all;
  const ids = ['lot', 'underground', 'tower', 'garage5', 'carpark3', 'modlot', 'spiral', 'garage', 'alley'];
  for (const id of ids) {
    await loadMap(id, `${id}-mech-in`, 'sedan');
    const st = await Y(() => { const G = window.__game; const a = G.map.annex[0]; return { mission: G.missionDef && G.missionDef.id, fac: G.facilities.length, facId: G.activeFac && G.activeFac.cfg.id, pallet: G.mechBuilt && G.mechBuilt.pallet.visible, a, f: G.map.mechFacilities[0], panel: !!document.querySelector('#top-right') }; });
    // 접근 자세(미션 시작 위치)에서 문을 지나 팔레트 앞까지 실제 주행
    const ox = Math.sin(st.a.approach.heading); const oz = Math.cos(st.a.approach.heading);
    const stop = [st.f.x + ox * -2.4, st.f.z + oz * -2.4];
    await Y(([a, stop, ox, oz]) => {
      const G = window.__game; G.car.gear = 'D'; G.car.handbrake = false;
      const path = [[a.approach.x + ox * 12, a.approach.z + oz * 12], stop];
      let idx = 0; G.__ri = G.readInput.bind(G);
      G.readInput = (dt) => { const c = G.car; const sp = G.spec; const off = sp.length / 2 - sp.rearOverhang; const cx = c.x + Math.sin(c.heading) * off; const cz = c.z + Math.cos(c.heading) * off; while (idx < path.length - 1 && Math.hypot(path[idx][0] - cx, path[idx][1] - cz) < 2.5) idx++; const [tx, tz] = path[idx]; let err = Math.atan2(tx - c.x, tz - c.z) - c.heading; err = Math.atan2(Math.sin(err), Math.cos(err)); const d = Math.hypot(tx - cx, tz - cz); const done = idx === path.length - 1 && d < 0.8; G.debugInput = done ? { throttle: 0, brake: 1, steerInput: 0 } : { throttle: Math.abs(c.v) < 1.6 ? 1 : 0, brake: Math.abs(c.v) > 2.1 ? 0.5 : 0, steerInput: Math.max(-1, Math.min(1, (err * 1.6) / sp.maxSteer)) }; window.__done = done; return G.__ri(dt); };
    }, [st.a, stop, ox, oz]);
    const arrived = await until(() => window.__done === true && Math.abs(window.__game.car.v) < 0.05, undefined, 300000);
    const en = await Y(() => { const G = window.__game; const r = { col: G.collisions, x: G.car.x, z: G.car.z, state: G.state, guide: G.mech.m.guidance ? JSON.stringify(G.mech.m.guidance).slice(0, 60) : '' }; G.readInput = G.__ri; G.__ri = null; G.debugInput = null; window.__done = false; return r; });
    check(`${id}: 옆 기계식 구역 — 입고 미션 로드, 시설 1기·팔레트 표시, 문을 지나 승강장 팔레트까지 실제 주행(충돌 0)`, st.mission === `${id}-mech-in` && st.fac === 1 && st.pallet === true && arrived && en.col === 0, JSON.stringify({ mission: st.mission, fac: st.fac, facId: st.facId, pallet: st.pallet, arrived, col: en.col }));
    if (id === 'underground' || id === 'tower') await pg.screenshot({ path: path.join(OUT, `e2e-04-annex-${id}.png`) });
  }

  check('콘솔/페이지 오류 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  srv.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E 스크립트 오류:', e); process.exit(2); });
