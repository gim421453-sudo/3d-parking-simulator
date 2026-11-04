/** 계기판 캔버스 원본(768×294) 덤프: node scripts/shot-cluster.cjs → docs/screenshots/v049/cluster-<veh>-<scene>.png */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v049'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4198', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  for (const veh of ['suv-x6', 'coupe-m4']) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.addInitScript((v) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: v, cabinFps: 30, mapId: 'garage5', missionId: 'g5-2' })), veh);
    await p.goto('http://127.0.0.1:4198/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
    const dump = async (name) => { await p.waitForTimeout(1500); const url = await p.evaluate(() => window.__game.model.cabin.cluster.canvas.toDataURL('image/png')); fs.writeFileSync(path.join(OUT, `cluster-${veh}-${name}.png`), Buffer.from(url.split(',')[1], 'base64')); };
    await p.evaluate(() => { const G = window.__game; G.rig.setMode('driver'); const c = G.car; c.gear = 'D'; c.handbrake = true; c.v = 0; });
    await dump('parked');
    await p.evaluate(() => { const G = window.__game; const c = G.car; c.handbrake = false; c.gear = 'D'; c.v = 4.0; c.steer = 0.25; G.sigLeft = true; G.lightMode = 'auto'; G.debugInput = { throttle: 0.4, brake: 0, steerInput: 0.4 }; });
    await dump('driving-left');
    await p.evaluate(() => { const G = window.__game; const c = G.car; G.debugInput = null; c.v = -1.2; c.gear = 'R'; c.steer = -0.3; G.sigLeft = false; G.hazard = true; G.lightMode = 'high'; });
    await dump('reverse-hazard');
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
