/** v0.5.1 전/후방 카메라 패널·전방카메라 위치·서라운드·타이어: node scripts/shot-v051-cam.cjs → docs/screenshots/v051/cam-*.png + JSON */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v051'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4223', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.9, shadows: 'off', vehicleId: 'suv-x6', mapId: 'lot', missionId: 'free', infoAutoHide: false, assistAutoView: false, assistCameraFps: 30 })));
  await p.goto('http://127.0.0.1:4223/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
  await p.waitForSelector('#hud:not(.hidden)', { timeout: 30000 }); await p.waitForTimeout(1500);
  const X = (f, a) => p.evaluate(f, a);
  const clear = () => X(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); G.rig.colliders = G.colliders; });
  const box = (id, x, z, w, d, h = 1.4, kind = 'box', r = 0.2) => X(([id, x, z, w, d, h, kind, r]) => { const c = kind === 'cyl' ? { kind: 'cyl', id: 't-' + id, tag: 'pillar', x, z, r, y0: 0, h } : { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h, kind, r]);
  const place = (cx, cz, h, gear) => X(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; G.hud.wheel.reset(); }, { cx, cz, h, gear });
  const dims = await X(() => ({ L: window.__game.spec.length, W: window.__game.spec.width }));
  const panelClip = async () => { const r = await X(() => { const e = document.querySelector('#parking-assist'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(1280 - r.x, r.w), height: Math.min(800 - r.y, r.h) }; };
  const out = { dims, cases: [] };
  const scen = [
    ['front-center-wall', 'D', 0, [['w', 0, 10 + dims.L / 2 + 1.0 + 0.25, 8, 0.5]]],
    ['front-left-pillar', 'D', 0, [['p', dims.W / 2 + 0.9, 10 + dims.L / 2 + 1.2 + 0.2]]],
    ['front-right-pillar', 'D', 0, [['p', -(dims.W / 2 + 0.9), 10 + dims.L / 2 + 1.2 + 0.2]]],
    ['front-oblique-wall', 'D', 0, [['o', 0, 10 + dims.L / 2 + 1.6, 9, 0.5, 0.55]]],
    ['rear-center-wall', 'R', 0, [['w', 0, 10 - dims.L / 2 - 1.0 - 0.25, 8, 0.5]]],
    ['rear-left-pillar', 'R', 0, [['p', dims.W / 2 + 0.9, 10 - dims.L / 2 - 1.2 - 0.2]]],
    ['rear-right-pillar', 'R', 0, [['p', -(dims.W / 2 + 0.9), 10 - dims.L / 2 - 1.2 - 0.2]]],
    ['rear-oblique-wall', 'R', 0, [['o', 0, 10 - dims.L / 2 - 1.6, 9, 0.5, -0.55]]],
  ];
  for (const [name, gear, h, objs] of scen) {
    await clear(); await place(0, 10, h, gear);
    for (const o of objs) {
      if (o[0] === 'p') await box('p' + o[1], o[1], o[2], 0, 0, 1.5, 'cyl', 0.2);
      else if (o[0] === 'o') await X(([x, z, w, d, rot]) => { const c = { kind: 'box', id: 't-obl', tag: 'wall', x, z, w, d, rot, y0: 0, h: 1.4 }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [o[1], o[2], o[3], o[4], o[5]]);
      else await box('w', o[1], o[2], o[3], o[4], 1.4);
    }
    await X((gear) => { const G = window.__game; G.risk.reset(); G.viewPolicy.reset(); G.assistPanel.resetOverlay(); G.viewGate = false; G.requestShift && 0; }, gear);
    await p.waitForFunction((g) => !document.getElementById('parking-assist').classList.contains('hidden') && window.__game.viewOut.view === (g === 'R' ? 'rear' : 'front'), gear, { timeout: 40000 }).catch(() => {});
    await p.waitForFunction(() => window.__game.assistPanel.debugPanels.length > 0, null, { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(1500);
    const info = await X(() => { const G = window.__game; return { view: G.viewOut.view, panels: G.assistPanel.debugPanels.map((q) => ({ level: q.level, w: Math.round(Math.max(...q.poly.map((a) => a.x)) - Math.min(...q.poly.map((a) => a.x))), h: Math.round(Math.max(...q.poly.map((a) => a.y)) - Math.min(...q.poly.map((a) => a.y))), cx: Math.round(q.poly.reduce((s, a) => s + a.x, 0) / q.poly.length) })), hits: G.sensorSnap.readings.reduce((a, r) => a + r.hits.length, 0), cam: { x: +G.spec.frontCam.z.toFixed(2), y: +G.spec.frontCam.y.toFixed(2) } }; });
    out.cases.push({ name, ...info });
    await p.screenshot({ path: path.join(OUT, `cam-${name}.png`), clip: await panelClip() });
  }
  console.log(JSON.stringify(out, null, 1));
  console.log('errors', JSON.stringify(errs.slice(0, 4)));
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
