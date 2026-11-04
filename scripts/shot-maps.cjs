/** 신규 맵 스크린샷/성능: node scripts/shot-maps.cjs → docs/screenshots/v049/map-<id>.png + 드로우콜/삼각형 */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v049'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4196', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', infoAutoHide: false })));
  await p.goto('http://127.0.0.1:4196/'); await p.waitForSelector('#m-start');
  const res = {};
  for (const [id, mission] of [['garage5', 'g5-2'], ['carpark3', 'c3-2'], ['modlot', 'ml-5'], ['spiral', 'sp-2']]) {
    await p.evaluate(([id, mission]) => { const G = window.__game; G.updateSettings({ mapId: id, missionId: mission }); G.startRun(); }, [id, mission]);
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(2500);
    res[id] = await p.evaluate(() => { const G = window.__game; const i = G.renderer.info; return { map: G.map.id, calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, car: [G.car.x, G.car.y, G.car.z].map((v) => +v.toFixed(2)), floor: (document.getElementById('floor-ind') || {}).textContent || '', obstacles: G.colliders.length }; });
    await p.screenshot({ path: path.join(OUT, `map-${id}.png`) });
    // 맵 전체 조감 (top 카메라)
    await p.evaluate(() => { const r = window.__game.rig; r.setMode('free'); r.freeDist = 62; r.freePitch = 0.95; r.freeYaw = 2.4; }); await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUT, `map-${id}-overview.png`) });
    await p.evaluate(() => { window.__game.rig.setMode('chase'); });
  }
  console.log(JSON.stringify(res, null, 1)); console.log('errors', JSON.stringify(errs.slice(0, 5)));
  await b.close(); srv.kill();
})();
