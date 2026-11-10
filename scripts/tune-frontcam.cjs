const { chromium } = require('playwright'); const { spawn } = require('child_process');
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4225', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.5, shadows: 'off', vehicleId: 'sedan', mapId: 'lot', missionId: 'free', assistCameraFps: 60 })));
  await p.goto('http://127.0.0.1:4225/'); await p.waitForSelector('#m-start'); await p.click('#m-start'); await p.waitForSelector('#hud:not(.hidden)'); await p.waitForTimeout(1500);
  const grid = [[-0.16, 0.10, 24], [-0.06, 0.10, 20], [-0.03, 0.10, 20], [-0.03, 0.14, 18], [-0.02, 0.12, 22]];
  for (const veh of ['sedan', 'suv-x6', 'concept-coupe']) {
    await p.evaluate((v) => { const G = window.__game; G.updateSettings({ vehicleId: v }); G.startRun(); }, veh); await p.waitForTimeout(2500);
    await p.evaluate(() => { const G = window.__game; const off = G.spec.length / 2 - G.spec.rearOverhang; const c = G.car; c.x = 0; c.z = 4 - off; c.heading = 0; c.v = 0; c.gear = 'D'; c.handbrake = true; });
    await p.waitForFunction(() => window.__game.viewOut.view === 'front', null, { timeout: 30000 }).catch(() => {});
    for (const [dz, dy, pitch] of grid) {
      await p.evaluate(([dz, dy, pitch]) => { const s = window.__game.spec; const bt = 0.42 * s.height; s.frontCam.z = s.length / 2 + dz; s.frontCam.y = bt + dy; s.frontCam.pitch = pitch * Math.PI / 180; }, [dz, dy, pitch]);
      await p.waitForTimeout(1500);
      const r = await p.evaluate(() => { const G = window.__game; const T = window.__THREE; const cam = G.rig.assistCamera; cam.updateMatrixWorld(true); G.model.root.updateMatrixWorld(true); const meshes = []; G.model.bodyGroup.traverse((o) => { let vis = o.isMesh; for (let q = o; q && vis; q = q.parent) if (!q.visible) vis = false; if (vis && !/^Plate/.test(o.name)) meshes.push(o); }); const rc = new T.Raycaster(); rc.near = 0.02; rc.far = 1.5; const rows = []; for (let k = 0; k <= 40; k++) { rc.setFromCamera(new T.Vector2(0, -1 + k / 40), cam); rows.push(rc.intersectObjects(meshes, false).length > 0); } rc.setFromCamera(new T.Vector2(0, 0), cam); return { frac: +(rows.filter(Boolean).length / 41).toFixed(2), center: rc.intersectObjects(meshes, false).length > 0, bottom: rows[0] }; });
      console.log(veh, dz, dy, pitch, JSON.stringify(r));
    }
  }
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
