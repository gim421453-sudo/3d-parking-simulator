/** 실차형 GLB 스크린샷: node scripts/shot-car.cjs <tag> [vehicleId] → docs/screenshots/v050/<tag>-car-*.png */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after'; const veh = process.argv[3] || 'concept-coupe';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v050'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4210', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 200)); });
  await p.addInitScript((v) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.85, shadows: 'off', vehicleId: v, mapId: 'lot', missionId: 'free' })), veh);
  await p.goto('http://127.0.0.1:4210/'); await p.waitForSelector('#m-start');
  await p.click('#m-car'); await p.waitForTimeout(2500); await p.screenshot({ path: path.join(OUT, `${tag}-car-select.png`) });
  await p.click('#back'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(4000);
  await p.screenshot({ path: path.join(OUT, `${tag}-car-chase.png`) });
  const info = await p.evaluate(() => { const G = window.__game; const m = G.model; let tris = 0, meshes = 0; m.root.traverse((o) => { if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return { name: G.spec.name, kind: G.spec.visual.kind, rollers: m.rollers.length, pivots: m.frontPivots.length, lampKeys: m.lights ? Object.keys(m.lights) : [], meshes, tris: Math.round(tris), perf: G.perfStats() }; });
  console.log(JSON.stringify(info));
  await p.evaluate(() => { const r = window.__game.rig; r.setMode('free'); r.freeDist = 7; r.freePitch = 0.25; r.freeYaw = 1.2; });
  await p.waitForTimeout(1500); await p.screenshot({ path: path.join(OUT, `${tag}-car-side.png`) });
  await p.evaluate(() => { const r = window.__game.rig; r.freeYaw = 3.3; r.freePitch = 0.3; r.freeDist = 7; }); await p.waitForTimeout(1200); await p.screenshot({ path: path.join(OUT, `${tag}-car-rear.png`) });
  console.log('errors', JSON.stringify(errs.slice(0, 6)));
  await b.close(); srv.kill();
})();
