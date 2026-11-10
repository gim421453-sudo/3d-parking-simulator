/** v0.5.1 타이어 조향/회전이 각 카메라 화면에 실제로 나타나는지: node scripts/shot-v051-tires.cjs [vehicleId] */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const veh = process.argv[2] || 'suv-x6';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v051'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4224', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((v) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.9, shadows: 'off', vehicleId: v, mapId: 'lot', missionId: 'free', infoAutoHide: false, assistAutoView: false, assistCameraFps: 30 })), veh);
  await p.goto('http://127.0.0.1:4224/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(2500);
  const X = (f, a) => p.evaluate(f, a);
  await X(() => { const G = window.__game; const c = G.car; c.x = 0; c.z = -8; c.heading = 0; c.handbrake = false; c.gear = 'D'; G.debugInput = { throttle: 0.35, brake: 0, steerInput: 0.6 }; });
  await p.waitForFunction(() => window.__game.car.v > 1.2 && Math.abs(window.__game.car.steer) > 0.3, null, { timeout: 60000 });
  const rd = () => X(() => { const m = window.__game.model; return { steer: m.frontPivots.map((q) => +q.rotation.y.toFixed(3)), roll: m.rollers.map((r) => +r.rotation.x.toFixed(2)), v: +window.__game.car.v.toFixed(2), gear: window.__game.car.gear }; });
  const out = { veh, fwd: [] };
  const cams = [['chase', null], ['left', 'left'], ['right', 'right'], ['topFront', 'topFront']];
  // 서라운드(오른쪽 패널) + 3인칭
  await X(() => { window.__game.rig.setMode('chase', window.__game.poseNow()); });
  out.fwd.push(await rd()); await p.waitForTimeout(600); out.fwd.push(await rd());
  await p.screenshot({ path: path.join(OUT, `tires-${veh}-chase-surround.png`) });
  // 측면 3D 뷰/집중 탑뷰: 게임의 '카메라 변경' 액션(assistCamera)으로 순환해 실제 수동 시점으로 전환
  for (const v of ['left', 'right', 'topFront']) {
    for (let i = 0; i < 8; i++) {
      if ((await X(() => window.__game.viewOut.view)) === v) break;
      await X(() => window.__game.onAction('assistCamera')); await p.waitForTimeout(400);
    }
    await p.waitForTimeout(1000);
    out['view_' + v] = await X(() => window.__game.viewOut.view);
    const r = await X(() => { const e = document.querySelector('#parking-assist'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await p.screenshot({ path: path.join(OUT, `tires-${veh}-${v}.png`), clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(1280 - r.x, r.w), height: Math.min(800 - r.y, r.h) } });
  }
  // 후진: 역회전
  await X(() => { const G = window.__game; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await p.waitForFunction(() => Math.abs(window.__game.car.v) < 0.05, null, { timeout: 60000 });
  const stop1 = await rd(); await p.waitForTimeout(700); const stop2 = await rd();
  out.stopped = { stop1, stop2 };
  await X(() => { const G = window.__game; G.car.gear = 'R'; G.debugInput = { throttle: 0.35, brake: 0, steerInput: -0.6 }; });
  await p.waitForFunction(() => window.__game.car.v < -1.0, null, { timeout: 60000 });
  out.rev = [await rd()]; await p.waitForTimeout(500); out.rev.push(await rd());
  console.log(JSON.stringify(out));
  console.log('errors', JSON.stringify(errs.slice(0, 4)));
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
