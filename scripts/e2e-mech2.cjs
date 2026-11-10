/** 기계식 출고 + 허용치 초과 거부 브라우저 검증: node scripts/e2e-mech2.cjs (dist 필요) */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v050'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4213', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const res = (globalThis.__res = {});
  const open = async (veh, mission) => {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') p.errs.push(m.text().slice(0, 200)); });
    await p.addInitScript(([v, m]) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.8, shadows: 'off', vehicleId: v, mapId: 'mechpark', missionId: m })), [veh, mission]);
    await p.goto('http://127.0.0.1:4213/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(2000);
    return p;
  };
  const st = (p) => p.evaluate(() => { const G = window.__game; return { x: +G.car.x.toFixed(2), z: +G.car.z.toFixed(2), y: +G.car.y.toFixed(2), phase: G.mech.m.phase, locked: G.mech.m.locked, door: +G.mech.m.door.toFixed(2), pY: +G.mech.m.palletY.toFixed(2), pZ: +G.mech.m.palletZ.toFixed(2), mission: G.mission && G.mission.status, state: G.state }; });
  // A. 출고 미션
  let p = await open('sedan', 'mech-out-1');
  res.outStart = await st(p); await p.screenshot({ path: path.join(OUT, 'mech-out-01-stored.png') });
  await p.keyboard.press('KeyK');
  await p.waitForFunction(() => window.__game.mech.m.palletY > 1 && window.__game.mech.m.palletZ === 0, null, { timeout: 120000 }); res.outLifting = await st(p); await p.screenshot({ path: path.join(OUT, 'mech-out-02-lowering.png') });
  await p.waitForFunction(() => window.__game.mech.m.phase === 'rotating' && window.__game.mech.m.yaw > 1, null, { timeout: 120000 }); res.rot = await st(p);
  await p.waitForFunction(() => window.__game.mech.m.phase === 'exit', null, { timeout: 120000 }); res.outExit = await st(p);
  await p.keyboard.press('KeyG'); await p.waitForTimeout(300); res.afterBoard = await st(p);
  await p.evaluate(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.debugInput = { throttle: 0.6, brake: 0, steerInput: 0 }; });
  await p.waitForFunction(() => window.__game.car.x < -8.5, null, { timeout: 120000 }); res.outDoor = await st(p); await p.screenshot({ path: path.join(OUT, 'mech-out-03-reversing-out.png') });
  await p.waitForFunction(() => window.__game.car.x < -22.5, null, { timeout: 120000 });
  await p.evaluate(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await p.waitForFunction(() => window.__game.state === 'result', null, { timeout: 60000 }).catch(() => {}); res.outEnd = await st(p); res.endCar = await p.evaluate(() => { const G = window.__game; return { x: G.car.x, z: G.car.z, h: G.car.heading, v: G.car.v, check: G.mission.check && { allInside: G.mission.check.allInside, headingOk: G.mission.check.headingOk, err: G.mission.check.headingErrorRad, corners: G.mission.check.corners, lat: G.mission.check.lateralOffset, lon: G.mission.check.longOffset }, status: G.mission.status, reason: G.mission.failReason, el: G.mission.elapsed, lim: G.mission.def.timeLimitSec }; }); res.outErrors = p.errs.slice(0, 5);
  await p.context().close();
  // B. 폭 초과 차량 거부 (컨셉 쿠페 2.34m)
  p = await open('concept-coupe', 'mech-in-1');
  await p.evaluate(() => { const G = window.__game; G.car.x = -3.4 - 0.05; G.car.z = 0; G.car.heading = Math.PI / 2; G.car.gear = 'P'; G.car.handbrake = true; G.car.v = 0; });
  await p.keyboard.press('KeyG'); await p.waitForTimeout(300); await p.keyboard.press('KeyJ'); await p.waitForTimeout(500);
  res.oversize = await p.evaluate(() => ({ phase: window.__game.mech.m.phase, msg: window.__game.mech.m.message }));
  await p.screenshot({ path: path.join(OUT, 'mech-oversize-reject.png') });
  await p.context().close();
  // C. SUV 허용치 판정 (높이 1.72m > 1.55m)
  p = await open('suv', 'mech-in-1');
  await p.evaluate(() => { const G = window.__game; G.car.x = -3.5; G.car.z = 0; G.car.heading = Math.PI / 2; G.car.gear = 'P'; G.car.handbrake = true; G.car.v = 0; });
  await p.keyboard.press('KeyG'); await p.waitForTimeout(300); await p.keyboard.press('KeyJ'); await p.waitForTimeout(500);
  res.suv = await p.evaluate(() => ({ phase: window.__game.mech.m.phase, msg: window.__game.mech.m.message }));
  await p.context().close();
  console.log(JSON.stringify(res, null, 1));
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); console.error(JSON.stringify(globalThis.__res || {})); process.exit(1); });
