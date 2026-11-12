/** v0.5.4 화면 확인용 스크린샷: megapark 도로망/지하 B1 경사로 등. 사용: node scripts/shot-v054.cjs [이름필터] */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v054');
const PORT = 4331;
const only = process.argv[2] || '';
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.85, shadows: 'off', vehicleId: 'sedan', mapId: 'megapark', missionId: 'free' })));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.waitForSelector('#m-start');
  await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)');
  await p.waitForTimeout(2500);
  const put = (x, z, h, y) => p.evaluate(([x, z, h, y]) => { const G = window.__game; const c = G.car; c.x = x; c.z = z; c.heading = h; c.y = y; c.v = 0; c.gear = 'P'; c.pitch = 0; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; G.rig.snap(); }, [x, z, h, y]);
  const shots = [
    ['01-mega-east-avenue', 80, 96, 0, 0],
    ['02-mega-ug-access', 62, 106.8, -Math.PI / 2, 0],
    ['03-mega-ug-ramp-top', 46, 106.8, -Math.PI / 2, 0],
    ['04-mega-ug-ramp-mid', 30, 106.8, -Math.PI / 2, -1.5],
    ['05-mega-ug-ramp-bottom', 15, 106.8, -Math.PI / 2, -3.2],
    ['06-mega-b1-aisle', 2, 106.8, -Math.PI / 2, -3.2],
    ['07-mega-intersection', -58, 21, 0, 0],
    ['08-mega-tower-spiral', -8, -40, Math.PI / 2, 3.2],
  ];
  for (const [name, x, z, h, y] of shots) {
    if (only && !name.includes(only)) continue;
    await put(x, z, h, y);
    await p.waitForTimeout(1800);
    const st = await p.evaluate(() => ({ y: +window.__game.car.y.toFixed(2), pitch: +window.__game.car.pitch.toFixed(3), indoor: +window.__game.indoorK.toFixed(2), floor: document.getElementById('floor-ind')?.textContent }));
    console.log(name, JSON.stringify(st));
    await p.screenshot({ path: path.join(OUT, name + '.png') });
  }
  console.log('errors', JSON.stringify(errs.slice(0, 3)));
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
