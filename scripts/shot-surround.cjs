/** 서라운드 얇은 거리색 경고선 스크린샷: node scripts/shot-surround.cjs → docs/screenshots/v050/surround-*.png */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v050'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4214', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.9, shadows: 'off', vehicleId: 'suv-x6', mapId: 'lot', missionId: 'free', pdcView: 'surround' })));
  await p.goto('http://127.0.0.1:4214/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(1500);
  const X = (f, a) => p.evaluate(f, a);
  const place = (cx, cz, h, gear) => X(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; }, { cx, cz, h, gear });
  const box = (id, x, z, w, d, h = 1.4) => X(([id, x, z, w, d, h]) => { const c = { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h]);
  const L = await X(() => window.__game.spec.length);
  await place(0, 0, 0, 'R');
  const none = await (async () => { await p.waitForTimeout(2500); return X(() => ({ warn: window.__game.assistPanel.debugSurWarn, lines: window.__game.assistPanel.debugSurLines })); })();
  await p.screenshot({ path: path.join(OUT, 'surround-none.png') });
  // 뒤쪽 벽 1.0m + 왼쪽 옆 벽 0.7m
  await box('rear', 0, -(L / 2 + 1.0 + 0.25), 6, 0.5);
  await box('left', 1.0 + 0.9 + 0.25, 0, 0.5, 3);
  await p.waitForTimeout(3000);
  const hit = await X(() => ({ warn: window.__game.assistPanel.debugSurWarn, lines: window.__game.assistPanel.debugSurLines, sensor: window.__game.sensorSnap.readings.reduce((a, r) => a + r.hits.length, 0) }));
  await p.screenshot({ path: path.join(OUT, 'surround-warn-lines.png') });
  console.log(JSON.stringify({ none, hit, errors: errs.slice(0, 4) }));
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
