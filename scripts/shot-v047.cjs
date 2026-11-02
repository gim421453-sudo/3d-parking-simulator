/** v0.4.7 시각 검증용 스크린샷: node scripts/shot-v047.cjs <tag> [scene...]  (dist 필요)  — docs/screenshots/v047/<tag>-<scene>.png */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const only = process.argv.slice(3);
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v047'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4192', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', assistCameraFps: 60 })));
  await p.goto('http://127.0.0.1:4192/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
  const g = (f, a) => p.evaluate(f, a);
  const place = (cx, cz, h, gear) => g(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; }, { cx, cz, h, gear });
  const box = (id, x, z, w, d, h = 1.4) => g(([id, x, z, w, d, h]) => { const c = { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h]);
  const clear = () => g(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const k of [...G.colliderById.keys()]) if (String(k).startsWith('t-')) G.colliderById.delete(k); G.rig.colliders = G.colliders; });
  const cam = (m) => g((m) => { const G = window.__game; G.assist.setManualCamera(m); G.viewPolicy.reset(); }, m);
  const shot = async (name) => { if (only.length && !only.includes(name)) return; await p.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) }); const el = await p.$('#parking-assist'); if (el) await el.screenshot({ path: path.join(OUT, `${tag}-${name}-panel.png`) }); };
  const SX = 0, SZ = 10; // 임의 위치(맵 중앙 근처 주차장)
  const state = () => g(() => { const G = window.__game; return { view: G.viewOut.view, mode: G.assist.cameraMode, vis: !document.getElementById('parking-assist').classList.contains('hidden'), surround: document.getElementById('parking-assist').dataset.surround }; });
  // 장면 1: 전방 집중 탑뷰 + 앞 벽
  await clear(); await place(SX, SZ, 0, 'D'); await box('f1', SX, SZ + 2.3 + 1.2, 6, 0.5);
  await p.waitForTimeout(800); await cam('topFront'); await p.waitForTimeout(3500); await shot('topFront'); console.log('topFront', JSON.stringify(await state()));
  await clear(); await place(SX, SZ, 0, 'R'); await box('r1', SX, SZ - 2.3 - 1.2, 6, 0.5); await p.waitForTimeout(800); await cam('topRear');
  await p.waitForTimeout(3500); await shot('topRear'); console.log('topRear', JSON.stringify(await state()));
  // 장면 3: 서라운드 + 예측선 (D, 조향)
  await clear(); await place(SX, SZ, 0, 'D'); await g(() => { window.__game.car.steer = 0.3; window.__game.hud.wheel.angle = 150; });
  await p.waitForTimeout(3500); await shot('surround-fwd'); console.log('surround-fwd', JSON.stringify(await state()));
  await place(SX, SZ, 0, 'R'); await p.waitForTimeout(3500); await shot('surround-rev');
  await g(() => window.__game.onAction('pdcSensor')); await p.waitForTimeout(1500); await shot('sensor-mode'); console.log('sensor', JSON.stringify(await state()));
  await b.close(); srv.kill();
})();
