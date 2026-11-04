/** 1인칭 실내 스크린샷: node scripts/shot-cabin.cjs <tag> — X6/M4 × 태블릿 가로 해상도 → docs/screenshots/v048/<tag>-cabin-<vehicle>-<WxH>.png */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v048'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4193', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  for (const veh of ['suv-x6', 'coupe-m4']) for (const [w, h] of [[1280, 800], [1024, 768]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    await p.addInitScript((v) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.7, shadows: 'off', vehicleId: v, cabinFps: 30, assistCameraFps: 60 })), veh);
    await p.goto('http://127.0.0.1:4193/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
    await p.evaluate(() => { const G = window.__game; const c = G.car; c.gear = 'D'; c.handbrake = true; c.v = 0; G.rig.setMode('driver'); });
    await p.waitForTimeout(3500);
    await p.screenshot({ path: path.join(OUT, `${tag}-cabin-${veh}-${w}x${h}.png`) });
    const m = await p.evaluate(() => { const G = window.__game; const c = G.model.cabin; if (!c) return null; const cam = G.rig.camera; cam.updateMatrixWorld(); const out = {}; for (const k of ['center', 'cluster']) { const mesh = c[k].mesh; const geo = mesh.geometry.parameters; const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const v = mesh.localToWorld(new (mesh.position.constructor)(sx * geo.width / 2, sy * geo.height / 2, 0)); v.project(cam); return [Math.round((v.x * 0.5 + 0.5) * innerWidth), Math.round((-v.y * 0.5 + 0.5) * innerHeight)]; }); out[k] = pts; } return out; });
    console.log(veh, w, h, JSON.stringify(m));
    if (m) { const xs = m.cluster.map((q) => q[0]), ys = m.cluster.map((q) => q[1]); const x0 = Math.max(0, Math.min(...xs) - 10), y0 = Math.max(0, Math.min(...ys) - 10); await p.screenshot({ path: path.join(OUT, `${tag}-cluster-${veh}-${w}x${h}.png`), clip: { x: x0, y: y0, width: Math.min(w - x0, Math.max(...xs) - x0 + 10), height: Math.min(h - y0, Math.max(...ys) - y0 + 10) } }); }
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
