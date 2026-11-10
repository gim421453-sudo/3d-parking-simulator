/** v0.5.2 기계식 12층 전체 동선 + 스크린샷: node scripts/shot-v052-mech.cjs → docs/screenshots/v052/mech-*.png + JSON */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v052'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4231', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  globalThis.__p = p; const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.9, shadows: 'off', vehicleId: 'sedan', mapId: 'mechpark', missionId: 'mech-in-1', infoAutoShow: false })));
  await p.goto('http://127.0.0.1:4231/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(2000);
  const shot = (n) => p.screenshot({ path: path.join(OUT, `mech-${n}.png`) });
  const st = () => p.evaluate(() => { const G = window.__game; const m = G.mech.m; return { carX: +G.car.x.toFixed(2), carY: +G.car.y.toFixed(2), phase: m.phase, cy: +m.carriage.y.toFixed(2), cz: +m.carriage.z.toFixed(2), yaw: +m.yaw.toFixed(2), door: +m.door.toFixed(2), occ: Object.entries(m.slots).filter(([, v]) => v).map(([k, v]) => k + ':' + v.mode), pl: m.palletLoc, led: G.mechBuilt.statusState, sign: G.mechBuilt.signState, stored: [...G.storedModels.keys()], mission: G.mission && G.mission.status }; });
  const out = (globalThis.__out = {});
  const driveIn = async (gear, throttle, slowX, brakeX) => {
    await p.evaluate(([gear, th]) => { const G = window.__game; G.car.handbrake = false; G.car.gear = gear; G.debugInput = { throttle: th, brake: 0, steerInput: 0 }; }, [gear, throttle]);
    await p.waitForFunction((t) => window.__game.car.x > t, slowX, { timeout: 150000 });
    await p.evaluate(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await p.waitForFunction(() => Math.abs(window.__game.car.v) < 0.45, null, { timeout: 60000 });
    // 정지 위치 직전까지 0.35m/s 로 크리핑 (낮은 정지턱을 타고 넘음), 기준 위치(brakeX)에서 제동
    await p.evaluate(() => { const G = window.__game; window.__creep = true; const tick = () => { if (!window.__creep || !G.debugInput) return; G.debugInput = { throttle: Math.abs(G.car.v) < 0.35 ? 0.14 : 0, brake: 0, steerInput: 0 }; setTimeout(tick, 40); }; G.debugInput = { throttle: 0.14, brake: 0, steerInput: 0 }; tick(); });
    await p.waitForFunction((t) => window.__game.car.x > t, brakeX, { timeout: 150000 });
    await p.evaluate(() => { window.__creep = false; window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await p.waitForFunction(() => Math.abs(window.__game.car.v) < 0.03, null, { timeout: 60000 });
    await p.evaluate(() => { const G = window.__game; G.debugInput = null; G.car.gear = 'P'; G.car.handbrake = true; });
    await p.waitForTimeout(500);
  };
  // ---- 1. 전진 입고 → 8F A ----
  await p.evaluate(() => { window.__S = []; setInterval(() => { const G = window.__game; if (G.car.x > -12 && window.__S.length < 400) window.__S.push([+G.car.x.toFixed(2), +G.car.v.toFixed(2), G.mech.guide.state, G.mech.guide.text, +G.car.pitch.toFixed(3), G.lastHitId]); }, 120); });
  await shot('01-entrance');
  await p.evaluate(() => { window.__game.mech.selectedSlot = '08A'; });
  await driveIn('D', 0.5, -9.5, -3.5);
  out.fwdStop = await st(); await shot('02-fwd-stopped');
  await p.keyboard.press('KeyG'); await p.waitForTimeout(300); await p.keyboard.press('KeyJ'); await p.waitForTimeout(600);
  out.afterJ = await st(); out.msg = await p.evaluate(() => ({ m: window.__game.mech.m.message, fail: window.__game.mech.items.filter((c) => !c.ok).map((c) => c.key) }));
  await p.waitForFunction(() => window.__game.mech.m.carriage.y > 8, null, { timeout: 120000 });
  out.lifting = await st(); await shot('03-lifting-8m');
  await p.waitForFunction(() => window.__game.mech.m.carriage.y > 20.5, null, { timeout: 120000 });
  out.near8F = await st(); await shot('04-near-8F');
  await p.waitForFunction(() => !!window.__game.mech.m.slots['08A'], null, { timeout: 120000 });
  out.storedFwd = await st(); await shot('05-stored-8F-carriage-returning');
  await p.waitForFunction(() => window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, null, { timeout: 120000 });
  out.carriageHome = await st(); await shot('06-carriage-back-1F');
  // ---- 2. 후진 입고 → 12F B (새 차량이 공급됨) ----
  await p.evaluate(() => { const G = window.__game; G.mech.selectedSlot = '12B'; G.car.x = -17; G.car.z = 0; G.car.heading = -Math.PI / 2; G.car.v = 0; });
  await p.waitForTimeout(800);
  out.revSign = await st();
  await driveIn('R', 0.4, -8.5, -0.85);
  out.revStop = await st(); await shot('07-rev-stopped');
  await p.keyboard.press('KeyG'); await p.waitForTimeout(300); await p.keyboard.press('KeyJ');
  await p.waitForFunction(() => window.__game.mech.m.carriage.y > 30, null, { timeout: 150000 });
  out.near12F = await st(); await shot('08-near-12F');
  await p.waitForFunction(() => !!window.__game.mech.m.slots['12B'], null, { timeout: 120000 });
  await p.waitForFunction(() => window.__game.mech.m.phase === 'waiting' && window.__game.mech.m.carriage.y === 0, null, { timeout: 120000 });
  out.two = await st(); await shot('09-two-cars-stored');
  // 전체 타워 외관 (자유 시점)
  await p.evaluate(() => { const G = window.__game; G.rig.setMode('free', G.poseNow()); const r = G.rig; r.freeDist = 60; r.freePitch = 0.35; r.freeYaw = 2.2; });
  await p.waitForTimeout(1500); await shot('10-tower-overview');
  // ---- 3. 출고: 8F A (전진 입고 → 회전) ----
  await p.evaluate(() => { const G = window.__game; G.rig.setMode('chase', G.poseNow()); G.mech.selectedSlot = '08A'; G.car.x = -30; G.car.z = 0; G.car.heading = Math.PI / 2; });
  await p.keyboard.press('KeyK');
  await p.waitForFunction(() => window.__game.mech.m.phase === 'rotating' && window.__game.mech.m.yaw > 1, null, { timeout: 200000 });
  out.rotating = await st(); await shot('11-rotating');
  await p.waitForFunction(() => window.__game.mech.m.phase === 'exit', null, { timeout: 120000 });
  out.exit = await st(); await shot('12-exit-ready');
  console.log(JSON.stringify(out, null, 1));
  console.log('errors', JSON.stringify(errs.slice(0, 5)));
  await b.close(); srv.kill();
})().catch(async (e) => { console.error('FAIL', e.message); console.error(JSON.stringify(globalThis.__out || {})); try { console.error('SAMPLES ' + JSON.stringify(await globalThis.__p.evaluate(() => window.__S.filter((q) => q[0] > -4.6)))); } catch (_) {} process.exit(1); });
