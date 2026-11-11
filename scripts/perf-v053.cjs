/**
 * v0.5.3 성능/메모리 측정 (소프트웨어 WebGL 이라 절대 FPS 는 실기기보다 훨씬 낮다 — 상대 비교/누수 확인용).
 *  1) 맵 전환 반복(lot→outdoor→mechpark→megapark ×2) 후 geometry/texture/JS 힙이 기준선 대비 늘어나지 않는가
 *  2) 기계식 거울 갱신율(게임 시간 기준) — 화질별(high/medium/low)
 *  3) 게임 프레임 FPS (거울이 보이는 곳 / 안 보이는 곳)
 * 사용: dist 빌드 후  node scripts/perf-v053.cjs   (출력은 JSON)
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PORT = 4311;
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--enable-precise-memory-info'] });
  const out = { note: 'software WebGL (SwiftShader): 절대 FPS 는 실기기와 다름', mem: {}, mirror: {}, fps: {} };
  const open = async (quality) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.addInitScript((q) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: q, resolutionScale: q === 'low' ? 0.6 : 0.85, shadows: 'off', vehicleId: 'sedan', mapId: 'lot', missionId: 'free', showFps: true })), quality);
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForSelector('#m-start');
    await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)');
    await p.waitForTimeout(1200);
    return { p, ctx };
  };
  const stats = (p) => p.evaluate(() => { const G = window.__game; const i = G.renderer.info; return { geo: i.memory.geometries, tex: i.memory.textures, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; });
  const load = (p, mapId, mission) => p.evaluate(([mapId, mission]) => { const G = window.__game; G.updateSettings({ mapId, missionId: mission }); G.startRun(); }, [mapId, mission]).then(() => p.waitForFunction((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, { timeout: 60000 })).then(() => p.waitForTimeout(800));
  const { p, ctx } = await open('medium');
  // 1) 맵 전환 반복
  await load(p, 'mechpark', 'free');
  const base = await stats(p);
  const seq = [['lot', 'free'], ['outdoor', 'free'], ['mechpark', 'free'], ['megapark', 'free']];
  const samples = [];
  for (let round = 0; round < 2; round++) for (const [m, ms] of seq) { await load(p, m, ms); samples.push({ map: m, ...(await stats(p)) }); }
  await load(p, 'mechpark', 'free');
  const end = await stats(p);
  out.mem = { base, end, growthGeo: end.geo - base.geo, growthTex: end.tex - base.tex, growthHeapMB: end.heap != null ? end.heap - base.heap : null, samples };
  // 3) 거울이 보이는 곳 / 안 보이는 곳 FPS
  const fpsOf = (p, ms) => p.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 >= ms) res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }), ms);
  await load(p, 'mechpark', 'free');
  out.fps.mechpark_mirrorVisible = await fpsOf(p, 4000);
  await p.evaluate(() => { const G = window.__game; G.car.x = -30; });
  await load(p, 'lot', 'free');
  out.fps.lot_noMirror = await fpsOf(p, 4000);
  await ctx.close();
  // 2) 거울 갱신율 (화질별)
  for (const q of ['high', 'medium', 'low']) {
    const { p: pq, ctx: cq } = await open(q);
    await load(pq, 'mechpark', 'free');
    const a = await pq.evaluate(() => ({ n: window.__game.mechBuilt.mirrorRenders, t: window.__game.mech.m.clock, vis: window.__game.mechBuilt.mirror.visible }));
    await pq.waitForFunction((t) => window.__game.mech.m.clock > t + 5, a.t, { timeout: 120000, polling: 200 });
    const c = await pq.evaluate(() => ({ n: window.__game.mechBuilt.mirrorRenders, t: window.__game.mech.m.clock }));
    out.mirror[q] = { visible: a.vis, perGameSecond: +((c.n - a.n) / (c.t - a.t)).toFixed(1), wallFps: await fpsOf(pq, 3000) };
    await cq.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
