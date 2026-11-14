/** v0.6.0 괴정동 실제 지도 화면/성능 확인: node scripts/shot-goejeong.cjs (dist 필요) */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v060');
require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4372', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.85, shadows: 'off', vehicleId: 'sedan', mapId: 'goejeong', missionId: 'gj-library', sensorSound: false, engineSound: false })));
  const t0 = Date.now();
  await p.goto('http://127.0.0.1:4372/');
  await p.waitForSelector('#m-start');
  await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)');
  await p.waitForFunction(() => window.__game && window.__game.state === 'playing' && window.__game.map.id === 'goejeong', null, { timeout: 60000 });
  const loadMs = Date.now() - t0;
  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => { const G = window.__game; return { nav: G.navState && { status: G.navState.status, text: G.navState.text, pts: G.navState.route ? G.navState.route.points.length : 0 }, tiles: G.built.tileStats(), colliders: G.colliders.length, mech: G.facilities.length }; });
  console.log('load', loadMs, 'ms', JSON.stringify(st));
  await p.screenshot({ path: path.join(OUT, 'goejeong-1-start.png') });
  // 프레임 시간 (소프트웨어 WebGL — 실기기와 무관, 상대 비교용)
  const fps = await p.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 3000) requestAnimationFrame(f); else res(n / 3); }; requestAnimationFrame(f); }));
  console.log('fps(swiftshader)', fps.toFixed(1));
  // 높은 곳에서 내려다보기
  await p.evaluate(() => { const G = window.__game; for (let i = 0; i < 8 && G.rig.mode !== 'top'; i++) G.onAction('camera'); });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, 'goejeong-2-top.png') });
  await p.evaluate(() => { const G = window.__game; for (let i = 0; i < 8 && G.rig.mode !== 'chase'; i++) G.onAction('camera'); const c = G.car; c.x = 60; c.z = 60; c.heading = -2.4; G.rig.snap(); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(OUT, 'goejeong-3-street.png') });
  console.log('errors', errs.slice(0, 4));
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
