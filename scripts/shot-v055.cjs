/** v0.5.5 화면 확인: 기계식 주차장 팔레트 표시(3인칭/1인칭), 입고 중 1인칭. node scripts/shot-v055.cjs */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v055');
const PORT = 4361;
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.85, shadows: 'off', vehicleId: 'sedan', mapId: 'mechpark', missionId: 'free', sensorSound: false, engineSound: false })));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.waitForSelector('#m-start');
  await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)');
  await p.waitForTimeout(2000);
  const st = () => p.evaluate(() => { const G = window.__game; const mb = G.mechBuilt; const v = new window.__THREE.Vector3(); mb.pallet.getWorldPosition(v); return { phase: G.mech.m.phase, palletLoc: G.mech.m.palletLoc, palletVisible: mb.pallet.visible, palletPos: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)], carY: +G.car.y.toFixed(2), cam: G.rig.mode, slotPalletsVisible: [...mb.slotPallets.entries()].filter(([, g]) => g.visible).map(([k]) => k) }; });
  const shot = async (n) => { await p.waitForTimeout(900); console.log(n, JSON.stringify(await st())); await p.screenshot({ path: path.join(OUT, n + '.png') }); };
  // 1) 승강장 앞 3인칭
  await p.evaluate(() => { const G = window.__game; G.car.x = -12; G.car.z = 0; G.car.heading = Math.PI / 2; G.rig.snap(); });
  await shot('01-mech-front-chase');
  // 2) 팔레트 위 정위치 → 입고 (1인칭)
  await p.evaluate(() => { const G = window.__game; const c = G.car; c.x = -0.65 - G.spec.wheelbase; c.z = 0; c.heading = Math.PI / 2; c.v = 0; c.gear = 'P'; c.handbrake = true; G.engine.state = 'OFF'; G.engine.rpm = 0; G.rig.snap(); });
  await shot('02-mech-on-pallet-chase');
  for (let i = 0; i < 6 && (await p.evaluate(() => window.__game.rig.mode !== 'driver')); i++) { await p.keyboard.press('KeyC'); await p.waitForTimeout(200); }
  await shot('03-mech-on-pallet-driver');
  await p.keyboard.press('KeyG');
  await p.waitForTimeout(400);
  await p.evaluate(() => { window.__game.mech.selectedSlot = '03A'; });
  await p.keyboard.press('KeyJ');
  await p.waitForFunction(() => window.__game.car.y > 1.5, null, { timeout: 240000 });
  await shot('04-mech-lifting-driver');
  await p.waitForFunction(() => window.__game.car.y > 5.5, null, { timeout: 240000 });
  await shot('05-mech-lifting-high-driver');
  await p.waitForFunction(() => !!window.__game.playerStoredSlot && window.__game.mech.m.phase === 'waiting', null, { timeout: 400000 });
  await shot('06-mech-stored-driver');
  for (let i = 0; i < 6 && (await p.evaluate(() => window.__game.rig.mode !== 'chase')); i++) { await p.keyboard.press('KeyC'); await p.waitForTimeout(200); }
  await shot('07-mech-stored-chase');
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
