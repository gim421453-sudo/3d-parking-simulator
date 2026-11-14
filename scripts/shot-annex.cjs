/** v0.5.5 화면 확인: 9개 맵의 기계식 부속 구역(문 안쪽 접근 자세에서 본 화면 + 승강장 앞). node scripts/shot-annex.cjs */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v055');
const PORT = 4362;
const IDS = ['lot', 'underground', 'tower', 'garage5', 'carpark3', 'modlot', 'spiral', 'garage', 'alley'];
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  let bad = 0;
  for (const id of IDS) {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.addInitScript((mapId) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'medium', resolutionScale: 0.85, shadows: 'off', vehicleId: 'sedan', mapId, missionId: `${mapId}-mech-in` })), id);
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForSelector('#m-start');
    await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)');
    await p.waitForTimeout(1500);
    const s1 = await p.evaluate(() => { const G = window.__game; return { map: G.map.id, mission: G.missionDef && G.missionDef.id, fac: G.facilities.length, active: G.activeFac && G.activeFac.cfg.id, x: +G.car.x.toFixed(1), z: +G.car.z.toFixed(1), pallet: G.mechBuilt && G.mechBuilt.pallet.visible }; });
    await p.screenshot({ path: path.join(OUT, `annex-${id}-1-gate.png`) });
    // 승강장 문 앞 8m 로 옮겨서 한 장 더
    await p.evaluate(() => { const G = window.__game; const a = G.map.annex[0]; const f = G.map.mechFacilities[0]; const ox = Math.sin(a.approach.heading), oz = Math.cos(a.approach.heading); G.car.x = f.x - ox * 16; G.car.z = f.z - oz * 16; G.car.heading = a.approach.heading; G.car.v = 0; G.rig.snap(); });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: path.join(OUT, `annex-${id}-2-door.png`) });
    const ok = s1.map === id && s1.mission === `${id}-mech-in` && s1.fac === 1 && s1.pallet === true && errs.length === 0;
    if (!ok) bad++;
    console.log(ok ? 'OK ' : 'BAD', id, JSON.stringify(s1), errs.slice(0, 2).join(' | '));
    await p.close();
  }
  await b.close();
  srv.kill();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
