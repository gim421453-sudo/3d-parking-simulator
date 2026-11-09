/** 기계식 주차장 구조 스크린샷(차량 모델 숨김, 자유 카메라): node scripts/shot-mech.cjs */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v050'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4212', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.9, shadows: 'off', vehicleId: 'sedan', mapId: 'mechpark', missionId: 'mech-in-1' })));
  await p.goto('http://127.0.0.1:4212/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(2000);
  await p.evaluate(() => { const G = window.__game; G.hud.root.style.visibility = 'hidden'; G.model.root.visible = false; G.built.setTarget(null); G.car.x = -2.4; G.car.z = 0; G.car.heading = Math.PI / 2; G.rig.setMode('free'); });
  const view = async (n, dist, pitch, yaw) => { await p.evaluate(([d, pi, y]) => { const r = window.__game.rig; r.freeDist = d; r.freePitch = pi; r.freeYaw = y; }, [dist, pitch, yaw]); await p.waitForTimeout(1500); await p.screenshot({ path: path.join(OUT, `mech-struct-${n}.png`) }); };
  await view('top-ribs', 4.5, 1.25, 0);
  await view('rear-entry', 5.5, 0.35, 4.7124);
  await view('side', 11, 0.4, 0);
  await view('mirror-wall', 5, 0.15, 1.5708);
  console.log('errors', JSON.stringify(errs.slice(0, 5)));
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
