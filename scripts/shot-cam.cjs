/** 전/후방 카메라 영상 스크린샷: node scripts/shot-cam.cjs <tag> → docs/screenshots/v049/<tag>-cam-<veh>-<front|rear>.png (패널 크롭) */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v049'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4197', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  for (const veh of ['suv-x6', 'sedan', 'coupe-m4']) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.addInitScript((v) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.7, shadows: 'off', vehicleId: v, assistCameraFps: 60 })), veh);
    await p.goto('http://127.0.0.1:4197/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
    for (const gear of ['D', 'R']) {
      await p.evaluate((gear) => { const G = window.__game; const c = G.car; const h = 0; const L = G.spec.length; c.x = 0; c.z = 10; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; }, gear);
      await p.waitForTimeout(3500);
      const el = await p.$('#parking-assist .pa-cam');
      if (el) await el.screenshot({ path: path.join(OUT, `${tag}-cam-${veh}-${gear === 'D' ? 'front' : 'rear'}.png`) });
    }
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
