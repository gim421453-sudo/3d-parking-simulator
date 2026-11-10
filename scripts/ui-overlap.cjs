/** 화면 크기별 실제 렌더 UI 겹침 검사 (+스크린샷): node scripts/ui-overlap.cjs [tag]  → docs/screenshots/v051/ui-<tag>-<WxH>-<ctx>.png */
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v051'); fs.mkdirSync(OUT, { recursive: true });
const SIZES = [[780, 360], [800, 360], [960, 540], [1024, 768], [1280, 800], [1920, 1080]];
const CTX = [['mech', 'mechpark', 'mech-in-1', 'sedan', 'chase'], ['lot3', 'lot', 'free', 'suv-x6', 'chase'], ['lot1', 'lot', 'free', 'suv-x6', 'driver']];
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4221', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const bad = [];
  for (const [w, h] of SIZES) {
    for (const [cn, map, mission, veh, mode] of CTX) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: false });
      const p = await ctx.newPage();
      await p.addInitScript(([map, mission, veh]) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.5, shadows: 'off', vehicleId: veh, mapId: map, missionId: mission, touchControls: 'on' })), [map, mission, veh]);
      await p.goto('http://127.0.0.1:4221/'); await p.waitForSelector('#m-start'); await p.click('#m-start');
      await p.waitForSelector('#hud:not(.hidden)', { timeout: 40000 }); await p.waitForTimeout(1200);
      await p.evaluate((mode) => { const G = window.__game; G.rig.setMode(mode, G.poseNow()); G.car.gear = 'D'; }, mode);
      await p.waitForTimeout(1500);
      const res = await p.evaluate(() => {
        const sel = { gear: '#gear-panel', mech: '#mech-panel', mission: '#mission-panel', wheel: '#t-wheel', brake: '#touch .tbtn.brk', gas: '#touch .tbtn.gas', cluster: '#cluster', minimap: '#minimap-wrap', icons: '#top-right .iconbar', assist: '#parking-assist:not(.hidden)', hint: '#hint:not(.fade)' };
        const r = {}; for (const [k, s] of Object.entries(sel)) { const e = document.querySelector(s); if (!e) continue; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue; const b = e.getBoundingClientRect(); if (b.width < 2 || b.height < 2) continue; r[k] = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; }
        const keys = Object.keys(r); const over = [];
        for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { const a = r[keys[i]], c = r[keys[j]]; const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x); const oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y); if (ox > 2 && oy > 2) over.push([keys[i], keys[j], ox, oy]); }
        return { r, over, vw: innerWidth, vh: innerHeight };
      });
      await p.screenshot({ path: path.join(OUT, `ui-${tag}-${w}x${h}-${cn}.png`) });
      const ignore = (o) => (o[0] === 'hint' || o[1] === 'hint');
      const real = res.over.filter((o) => !ignore(o));
      console.log(`${w}x${h} ${cn}: ${real.length ? 'OVERLAP ' + JSON.stringify(real) : 'ok'} ${res.r.mech ? 'mech@' + JSON.stringify(res.r.mech) : ''}`);
      if (real.length) bad.push(`${w}x${h} ${cn} ${JSON.stringify(real)}`);
      await ctx.close();
    }
  }
  console.log(bad.length ? 'BAD ' + bad.length : 'ALL OK');
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
