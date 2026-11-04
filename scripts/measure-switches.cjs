/** 자동 시점 전환 빈도 측정: 좁은 통로(양쪽 벽 0.45m)를 직진 통과. old = v0.4.8 이전 동작(장애물 존재만으로 후보) 재현, new = v0.4.9 */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4200', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', mapId: 'lot', missionId: 'free' })));
  await p.goto('http://127.0.0.1:4200/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)'); await p.waitForTimeout(1500);
  const out = {};
  for (const mode of ['new', 'old']) {
    await p.evaluate((mode) => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); const Wh = G.spec.width; for (const s of [1, -1]) { const c = { kind: 'box', id: 't-w' + s, tag: 'wall', x: 16 + s * (Wh / 2 + 0.45 + 0.25), z: -8, w: 0.5, d: 14, rot: 0, y0: 0, h: 1.4 }; G.colliders.push(c); G.colliderById.set(c.id, c); } const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 16; c.z = -14 - off; c.heading = 0; c.v = 0; c.steer = 0; c.gear = 'D'; c.handbrake = false; G.viewPolicy.reset(); G.viewGate = false; G.debugViewCtx = mode === 'old' ? { v: 1, steer: 'closest', pathCut: 1.0 } : null; }, mode);
    await p.waitForTimeout(800);
    const r = await p.evaluate(() => new Promise((res) => { const G = window.__game; const sw0 = G.viewPolicy.switches; const seen = new Set(); G.debugInput = { throttle: 0.45, brake: 0, steerInput: 0 }; const t0 = performance.now(); const tick = () => { seen.add(G.viewOut.view); if (G.car.z > -5.5 || performance.now() - t0 > 120000) { G.debugInput = null; G.car.handbrake = true; res({ switches: G.viewPolicy.switches - sw0, views: [...seen], z: G.car.z }); } else setTimeout(tick, 40); }; tick(); }));
    out[mode] = r;
  }
  console.log(JSON.stringify(out)); await b.close(); srv.kill();
})();
