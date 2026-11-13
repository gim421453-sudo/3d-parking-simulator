/**
 * v0.5.4 대형 맵 렌더 측정 (소프트웨어 WebGL — 절대 FPS 는 실기기와 다르다. 드로우콜/삼각형/타일 수와 상대 비교용).
 *   node scripts/perf-v054.cjs   (dist 필요)
 * megapark 에서 타일 가시성 ON(기본) vs 전부 표시, 화질별 가시 반경, 맵 로딩 시간, 지하 B1/도시형 구역 수치.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PORT = 4351;
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const out = { note: 'software WebGL(SwiftShader): 절대 FPS 는 실기기와 다름', megapark: {}, maps: {} };
  const fpsOf = (p, ms) => p.evaluate((ms) => new Promise((res) => { let n = 0; let worst = 0; let last = performance.now(); const t0 = last; const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; n++; if (now - t0 >= ms) res({ avg: +(n / ((now - t0) / 1000)).toFixed(1), worstFrameMs: +worst.toFixed(0) }); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }), ms);
  // renderer.info.render 는 render() 호출마다 초기화되고 게임은 한 프레임에 여러 패스(메인/보조 카메라/미러)를 그린다 → 자동 초기화를 끄고 3프레임 합계를 프레임당 평균으로 낸다
  const info = (p) => p.evaluate(() => new Promise((res) => { const G = window.__game; if (window.gc) window.gc(); const i = G.renderer.info; i.autoReset = false; i.reset(); let n = 0; const tick = () => { n++; if (n < 4) { requestAnimationFrame(tick); return; } const r = { calls: Math.round(i.render.calls / 3), tris: Math.round(i.render.triangles / 3), geo: i.memory.geometries, tex: i.memory.textures, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, tiles: G.built.tileStats() }; i.autoReset = true; res(r); }; requestAnimationFrame(tick); }));
  for (const q of ['low', 'medium', 'high']) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    await p.addInitScript((q) => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: q, resolutionScale: q === 'low' ? 0.6 : 0.85, shadows: 'off', vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false })), q);
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForSelector('#m-start');
    await p.click('#m-start');
    await p.waitForSelector('#hud:not(.hidden)');
    const load = async (mapId) => { const t0 = Date.now(); await p.evaluate((mapId) => { const G = window.__game; G.updateSettings({ mapId, missionId: 'free' }); G.startRun(); }, mapId); await p.waitForFunction((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, { timeout: 120000 }); const ms = Date.now() - t0; await p.waitForTimeout(1500); return ms; };
    const loadMs = await load('megapark');
    const on = { loadMs, ...(await info(p)), fps: await fpsOf(p, 4000) };
    // 타일 가시성 OFF 비교: 모든 타일 그룹/차량 모델을 강제로 표시
    await p.evaluate(() => { const G = window.__game; G.built.setViewCenter(G.car.x, G.car.z, 100000); G.__sv = G.built.setViewCenter; G.built.setViewCenter = () => 0; });
    await p.waitForTimeout(1200);
    const off = { ...(await info(p)), fps: await fpsOf(p, 4000) };
    await p.evaluate(() => { const G = window.__game; G.built.setViewCenter = G.__sv; G.zoneAcc = 1; });
    out.megapark[q] = { tilesOn: on, allVisible: off, drawCallReduction: +(1 - on.calls / off.calls).toFixed(2) };
    if (q === 'medium') {
      // 지하 B1 안 + 그래프 첫 생성 멈칫 시간
      await p.evaluate(() => { const G = window.__game; const z = G.map.roads.find((r) => r.id === 'ramp-underground').az; G.car.x = 0; G.car.z = z; G.car.y = -3.2; G.car.heading = -Math.PI / 2; G.rig.snap(); G.zoneAcc = 1; });
      await p.waitForTimeout(2500);
      out.megapark.b1 = { ...(await info(p)), fps: await fpsOf(p, 3000) };
      out.megapark.navFirstRouteMs = await p.evaluate(() => { const G = window.__game; const s = G.map.slots.find((q) => q.id === 'tw:tw3-n-4'); const t0 = performance.now(); G.nav.setDestination(s, { x: G.car.x, z: G.car.z, y: G.car.y }); const a = performance.now() - t0; const t1 = performance.now(); G.nav.setDestination(s, { x: -58, z: 0, y: 0 }); return { first: +a.toFixed(0), second: +(performance.now() - t1).toFixed(1), status: G.nav.state.status }; });
      for (const id of ['lot', 'underground', 'tower', 'spiral', 'mechpark', 'garage', 'alley', 'citytest']) {
        const ms = await load(id);
        out.maps[id] = { loadMs: ms, ...(await info(p)), fps: await fpsOf(p, 2500) };
      }
      // 긴 주행 후 자원: megapark ↔ citytest 를 3번 오간 뒤 megapark 로 돌아와 비교
      await load('megapark');
      const base = await info(p);
      for (let i = 0; i < 3; i++) { await load('citytest'); await load('megapark'); }
      const end = await info(p);
      out.megapark.reloadLeak = { base: { geo: base.geo, tex: base.tex, heapMB: base.heapMB }, end: { geo: end.geo, tex: end.tex, heapMB: end.heapMB } };
    }
    await ctx.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
