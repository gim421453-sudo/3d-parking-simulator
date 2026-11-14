/**
 * v0.6.0 브라우저 통합 테스트: 자동 주차 브레이크 · 추적 카메라 가림(LED 안내판) · 충돌 파손(속도별) · 재시작 복원 · 괴정동 실제 지도.
 *   node scripts/e2e-v060.cjs          (dist 필요)
 * 시간이 아니라 게임 상태를 기다린다. 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 4361;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v060');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 240000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const loadMap = async (mapId, missionId, veh = 'sedan') => {
    await Y(([mapId, missionId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId, vehicleId: veh }); G.startRun(); }, [mapId, missionId, veh]);
    await until((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 90000);
    await sleep(800);
  };
  const input = (o) => Y((o) => { window.__game.debugInput = o; }, o);
  /** 차체 중심을 (x,z)에, 진행 방향 h, 속도 kmh 로 놓고 충돌이 날 때까지 그 속도를 유지 */
  const crash = async (x, z, h, kmh, maxMs = 8000) => {
    await Y(([x, z, h, kmh]) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = x - Math.sin(h) * off; c.z = z - Math.cos(h) * off; c.heading = h; c.v = kmh / 3.6; c.steer = 0; c.gear = 'D'; c.handbrake = false; G.__cruise = kmh / 3.6; G.__imp0 = G.damage.stats.impacts; G.debugInput = { throttle: 0.6, brake: 0, steerInput: 0 }; G.rig.snap(); }, [x, z, h, kmh]);
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const hit = await Y(() => { const G = window.__game; if (G.damage.stats.impacts > G.__imp0) return true; if (G.car.v < G.__cruise) G.car.v = G.__cruise; return false; });
      if (hit) break;
      await sleep(40);
    }
    await input({ throttle: 0, brake: 1, steerInput: 0 });
    await until(() => Math.abs(window.__game.car.v) < 0.05, undefined, 20000);
    await sleep(400);
    return Y(() => { const G = window.__game; const d = G.damage; return { stats: { ...d.stats }, last: d.log[d.log.length - 1] && d.log.filter((l) => l.kmh > 1).slice(-1)[0], car: { ...d.carDamage }, level: d.effects.level, colliders: G.colliders.length, dyn: d.dynamicColliders.length, collisions: G.collisions }; });
  };

  // ================= 1. 자동 주차 브레이크 =================
  await Y(() => { const G = window.__game; G.car.v = 0; G.car.handbrake = false; G.car.gear = 'D'; });
  await input({ throttle: 0, brake: 1, steerInput: 0 });
  await until(() => window.__game.brake > 0.4, undefined, 10000);
  await pg.keyboard.press('KeyP').catch(() => {});
  let gearP = await until(() => window.__game.car.gear === 'P', undefined, 3000);
  if (!gearP) { await Y(() => window.__game.requestShift('P')); gearP = await until(() => window.__game.car.gear === 'P', undefined, 3000); }
  const hb1 = await Y(() => window.__game.car.handbrake);
  check('자동 주차 브레이크: P 로 변속하면 체결된다', gearP && hb1 === true, JSON.stringify({ gearP, hb1 }));
  // 실제 조작처럼 브레이크(S)를 밟은 채 D 로 변속(브레이크 인터록) → 브레이크를 떼도 주차 브레이크는 체결 상태
  await input(null);
  await pg.keyboard.down('KeyS');
  await until(() => window.__game.brake > 0.4, undefined, 10000);
  await Y(() => window.__game.requestShift('D'));
  await until(() => window.__game.car.gear === 'D', undefined, 3000);
  await pg.keyboard.up('KeyS');
  const hb2 = await Y(() => ({ hb: window.__game.car.handbrake, n: window.__game.epbAutoReleases }));
  await input({ throttle: 0.6, brake: 0, steerInput: 0 });
  const released = await until(() => !window.__game.car.handbrake && Math.abs(window.__game.car.v) > 0.3, undefined, 15000);
  const hb3 = await Y(() => ({ hb: window.__game.car.handbrake, n: window.__game.epbAutoReleases }));
  check('자동 주차 브레이크: D 로 바꾼 뒤(아직 체결) 가속 페달을 밟으면 자동 해제되고 출발한다', hb2.hb === true && released && hb3.n === hb2.n + 1, JSON.stringify({ hb2, hb3 }));
  await input({ throttle: 0, brake: 1, steerInput: 0 });
  await until(() => Math.abs(window.__game.car.v) < 0.05, undefined, 15000);

  // ================= 2. 충돌 파손 (lot 맵) =================
  const cone = await crash(-26, -22, 0, 30);
  check('라바콘(시속 30km): 밀려나고(동적 물체) 차량 손상 없음, 충돌 1회 기록', cone.stats.pushed === 1 && cone.dyn === 1 && cone.level === 'none' && cone.collisions >= 1, JSON.stringify(cone));
  await Y(() => window.__game.startRun());
  await until(() => window.__game.state === 'playing' && window.__game.damage && window.__game.damage.stats.impacts === 0, undefined, 30000);
  const restored = await Y(() => ({ n: window.__game.colliders.length, dyn: window.__game.damage.dynamicColliders.length, changed: window.__game.damage.worldChanged }));
  check('재시작(T)하면 맵이 원래대로 복원된다(밀린 콘 원위치, 동적 물체 0)', restored.dyn === 0 && !restored.changed && restored.n === cone.colliders + 1, JSON.stringify({ restored, before: cone.colliders }));
  const car = await crash(-9.1, 12, 0, 20);
  check('주차 차량(시속 20km): 밀려나고 내 차는 경미한 손상(앞)', car.stats.pushed === 1 && car.last && car.last.tag === 'car' && car.car.front > 0.01 && car.car.front < 0.3, JSON.stringify(car));
  await Y(() => window.__game.startRun());
  await until(() => window.__game.state === 'playing' && window.__game.damage.stats.impacts === 0, undefined, 30000);
  const wall30 = await crash(18, 0, Math.PI / 2, 30);
  check('벽(시속 30km): 부서지지 않고 막힘 + 균열 자국, 내 차 앞부분 손상(30% 안팎)', wall30.stats.broken === 0 && wall30.stats.scars >= 1 && wall30.car.front > 0.15 && wall30.car.front < 0.45, JSON.stringify(wall30));
  await pg.screenshot({ path: path.join(OUT, 'e2e-01-wall30.png') });
  await Y(() => window.__game.startRun());
  await until(() => window.__game.state === 'playing' && window.__game.damage.stats.impacts === 0, undefined, 30000);
  const n0 = await Y(() => window.__game.colliders.length);
  const wall100 = await crash(8, 0, Math.PI / 2, 100);
  const hole = await Y(() => window.__game.colliders.filter((c) => /^e-wall~/.test(c.id)).map((c) => c.id));
  check('벽(시속 100km): 벽에 구멍이 뚫리고(양쪽 조각 2개로 분할) 통과, 내 차는 운행 불가', wall100.stats.holes === 1 && hole.length === 2 && wall100.colliders === n0 + 1 && wall100.level === 'wrecked', JSON.stringify({ wall100, hole }));
  const eng = await Y(() => ({ st: window.__game.engine.state, level: window.__game.damage.effects.level, screens: window.__game.screensOn }));
  await pg.keyboard.press('KeyO');
  await sleep(500);
  const eng2 = await Y(() => window.__game.engine.state);
  check('운행 불가: 엔진이 멈추고(계기판도 꺼짐) 시동 버튼을 눌러도 걸리지 않는다', eng.st === 'OFF' && eng2 === 'OFF' && eng.level === 'wrecked' && eng.screens === false, JSON.stringify({ eng, eng2 }));
  await pg.screenshot({ path: path.join(OUT, 'e2e-02-wall100.png') });
  await Y(() => window.__game.startRun());
  await until(() => window.__game.state === 'playing' && window.__game.damage.stats.impacts === 0, undefined, 30000);
  const reset = await Y(() => ({ level: window.__game.damage.effects.level, eng: window.__game.engine.state, holes: window.__game.colliders.filter((c) => /^e-wall~/.test(c.id)).length }));
  check('재시작하면 벽과 내 차 손상이 모두 원래대로', reset.level === 'none' && reset.holes === 0, JSON.stringify(reset));
  const bar = await crash(-16, -2, 0, 50);
  check('방호벽(시속 50km): 부서져 사라지고 파편이 생긴다', bar.stats.broken >= 1 && bar.last && bar.last.tag === 'barrier', JSON.stringify(bar));

  // ================= 3. 추적 카메라: 팔레트 위 차량이 LED 안내판에 가리지 않음 =================
  await loadMap('mechpark', 'free');
  await Y(() => { const G = window.__game; for (let i = 0; i < 8 && G.rig.mode !== 'chase'; i++) G.onAction('camera'); const c = G.car; c.x = -0.65 - G.spec.wheelbase; c.z = 0; c.heading = Math.PI / 2; c.v = 0; c.gear = 'P'; c.handbrake = true; G.rig.snap(); });
  await sleep(2500);
  const cam = await Y(() => ({ occ: window.__game.rig.cameraOccluders.length, cand: window.__game.rig.chaseCand, free: window.__game.rig.chaseFree, y: window.__game.rig.camera.position.y }));
  check('추적 카메라: 셔터 위 LED 안내판(카메라 전용 가림)을 피해 높은 위치로 — 차량이 가리지 않는다', cam.occ === 1 && cam.cand !== 0 && cam.free > 0.99 && cam.y > 4.5, JSON.stringify(cam));
  await pg.screenshot({ path: path.join(OUT, 'e2e-03-chase-pallet.png') });

  // ================= 4. 괴정동 실제 지도 =================
  const t0 = Date.now();
  await loadMap('goejeong', 'gj-library');
  const loadMs = Date.now() - t0;
  const gj = await Y(() => { const G = window.__game; return { geo: G.map.geo && G.map.geo.buildings.length, attr: G.map.geo && G.map.geo.attribution, stats: G.built.tileStats(), nav: G.navState && { status: G.navState.status, n: G.navState.route ? G.navState.route.points.length : 0, len: G.navState.route ? Math.round(G.navState.route.length) : 0 }, fac: G.facilities.length }; });
  check('괴정동 지도: OSM 건물/도로가 그려지고(타일 스트리밍) 출처가 표시된다', gj.geo > 500 && /OpenStreetMap/.test(gj.attr) && gj.stats.geo.buildings === gj.geo && gj.stats.visible < gj.stats.tiles, JSON.stringify({ ...gj, loadMs }));
  check('괴정동 내비: 실제 도로망으로 사하도서관 주차장까지 경로 안내', gj.nav && gj.nav.status === 'guiding' && gj.nav.n > 5 && gj.nav.len > 300, JSON.stringify(gj.nav));
  await pg.screenshot({ path: path.join(OUT, 'e2e-04-goejeong.png') });
  // 경로를 따라 실제 주행(오토파일럿, 게임 입력 경로) → 주차장 근처 도착, 충돌 0
  await Y(() => {
    const G = window.__game; const pts = G.navState.route.points.slice(1, -1).map((p) => [p.x, p.z]);
    let idx = 0; G.__ri = G.readInput.bind(G); G.car.gear = 'D'; G.car.handbrake = false;
    G.readInput = (dt) => { const c = G.car; const sp = G.spec; const off = sp.length / 2 - sp.rearOverhang; const cx = c.x + Math.sin(c.heading) * off; const cz = c.z + Math.cos(c.heading) * off; while (idx < pts.length - 1 && Math.hypot(pts[idx][0] - cx, pts[idx][1] - cz) < 7) idx++; const [tx, tz] = pts[idx]; let err = Math.atan2(tx - c.x, tz - c.z) - c.heading; err = Math.atan2(Math.sin(err), Math.cos(err)); const done = idx === pts.length - 1 && Math.hypot(tx - cx, tz - cz) < 6; G.debugInput = done ? { throttle: 0, brake: 1, steerInput: 0 } : { throttle: Math.abs(c.v) < 6 ? 0.7 : 0, brake: Math.abs(c.v) > 7.5 ? 0.4 : 0, steerInput: Math.max(-1, Math.min(1, (err * 1.4) / sp.maxSteer)) }; window.__done = done; return G.__ri(dt); };
  });
  const arrived = await until(() => window.__done === true && Math.abs(window.__game.car.v) < 0.1, undefined, 600000);
  const fin = await Y(() => { const G = window.__game; const s = G.navState.destination; const r = { col: G.collisions, d: Math.round(Math.hypot(G.car.x - s.x, G.car.z - s.z)), nav: G.navState.status }; G.readInput = G.__ri; G.__ri = null; G.debugInput = null; return r; });
  check('괴정동: 안내 경로(실제 도로)를 따라 실주행해 주차장 앞까지 도착, 충돌 0', arrived && fin.col === 0 && fin.d < 40, JSON.stringify(fin));
  await pg.screenshot({ path: path.join(OUT, 'e2e-05-goejeong-arrive.png') });
  await loadMap('goejeong', 'gj-mech-in');
  const gm = await Y(() => ({ fac: window.__game.facilities.length, act: window.__game.activeFac && window.__game.activeFac.cfg.id, pal: window.__game.mechBuilt && window.__game.mechBuilt.pallet.visible }));
  check('괴정동 기계식 주차타워 입고 미션: 시설 로드·팔레트 표시', gm.fac === 1 && gm.act === 'gj-mech' && gm.pal === true, JSON.stringify(gm));

  check('콘솔/페이지 오류 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  srv.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E 스크립트 오류:', e); process.exit(2); });
