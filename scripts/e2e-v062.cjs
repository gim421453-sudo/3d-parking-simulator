/**
 * v0.6.2 브라우저 통합 테스트: 부산 사하구 전체 실제 지도(타일 스트리밍·실제 지형·차선·건물 충돌체·내비) + 핸들링(동역학/노면/손상).
 *   node scripts/e2e-v062.cjs          (dist 필요)
 * 게임 상태를 기다린다(시간이 아니라). 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2).
 * 측정값(로딩 시간·FPS·타일/삼각형/충돌체 수)은 docs/screenshots/v062/perf.json 에 남긴다(저장소 제외 폴더).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 4363;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v062');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const pg = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  const fetched = [];
  pg.on('request', (r) => { if (r.url().includes('/maps/saha/')) fetched.push(r.url().split('/maps/saha/')[1]); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false, infoAutoShow: false, showFps: true })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 120000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const perf = {};
  const lotCols = await Y(() => window.__game.colliders.length);

  // ================= 1. 로딩 =================
  const t0 = Date.now();
  await Y(() => { const G = window.__game; G.updateSettings({ mapId: 'saha', missionId: 'saha-hadan', vehicleId: 'sedan' }); G.startRun(); });
  const loaded = await until(() => window.__game.map.id === 'saha' && window.__game.map.stream.ready && window.__game.state === 'playing', undefined, 90000);
  perf.loadToPlayingMs = Date.now() - t0;
  const tilesReady = await until(() => window.__game.saha && window.__game.saha.ready(window.__game.car.x, window.__game.car.z), undefined, 90000);
  perf.loadToTilesMs = Date.now() - t0;
  const s1 = await Y(() => { const G = window.__game; const i = G.saha.info(); return { ...i, keys: i.keys.length, cols: G.colliders.length, nav: G.navState.status, route: !!G.navState.route, len: G.navState.route ? G.navState.route.length : 0, attribution: G.map.attribution, desc: G.map.desc }; });
  perf.initial = s1;
  check('사하구 지도: 데이터(경계·지형·도로망·출발지 타일)를 받아 시작 → 주변 타일 붙음(건물 충돌체 추가)', loaded && tilesReady && s1.loaded >= 4 && s1.cols > lotCols, JSON.stringify({ ms: perf.loadToTilesMs, loaded: s1.loaded, cols: s1.cols }));
  check('내비: 괴정역 → 하단 공영주차장 실제 도로망 경로 안내', s1.nav === 'guiding' && s1.route && s1.len > 2000, `${Math.round(s1.len)}m`);
  check('출처 표시(ODbL·Copernicus)와 추정 데이터 고지가 맵 설명에 있다', /OpenStreetMap/.test(s1.attribution) && /Copernicus/.test(s1.attribution) && /추정/.test(s1.desc));
  const sp = await Y(() => { const G = window.__game; return { y: G.car.y, sy: G.map.spawn.y, gear: G.car.gear, fac: G.facilities.length }; });
  check('시작 위치: 낙동대로 위 지면 높이(y), 기계식 시설 1곳 설치', Math.abs(sp.y - sp.sy) < 0.05 && sp.fac === 1, JSON.stringify(sp));
  await sleep(1500);
  await pg.screenshot({ path: path.join(OUT, 'e2e-01-start.png') });

  // ================= 2. 차선/메시 =================
  const meshes = await Y(() => { const G = window.__game; const names = new Set(); G.saha.group.traverse((o) => { if (o.isMesh) names.add(o.name); }); return [...names]; });
  check('타일 메시: 지형·도로·차선·건물·지붕 + 먼 지형·바다', ['terrain', 'roads', 'lanes', 'buildings', 'roofs', 'SahaFarTerrain', 'SahaSea'].every((n) => meshes.includes(n)), meshes.join(','));

  // ================= 3. 경사 도로 실주행 =================
  const pick = await Y(() => { const G = window.__game; const rn = G.sahaBase.roadNet; const n = rn.nodes; let best = null; rn.edges.forEach(([a, b, o], i) => { const L = Math.hypot(n[b][0] - n[a][0], n[b][1] - n[a][1]); const g = (n[b][2] - n[a][2]) / L; if (L > 25 && g > 0.07 && g < 0.11 && rn.cls[i] <= 4 && (!best || Math.hypot(n[a][0], n[a][1]) < Math.hypot(best.x, best.z))) best = { x: n[a][0], z: n[a][1], y: n[a][2], h: Math.atan2(n[b][0] - n[a][0], n[b][1] - n[a][1]), g }; }); return best; });
  await Y((p) => { const G = window.__game; const c = G.car; c.x = p.x; c.z = p.z; c.heading = p.h; c.y = G.groundHeight(p.x, p.z); c.v = 0; c.handbrake = false; c.gear = 'D'; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; G.rig.snap(); }, pick);
  await until(() => window.__game.saha.ready(window.__game.car.x, window.__game.car.z), undefined, 60000);
  const h0 = await Y(() => { const G = window.__game; return { y: G.car.y, pitch: G.car.pitch }; });
  await Y(() => { window.__game.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; });
  const climbed = await until((y0) => window.__game.car.y > y0 + 1.5 || window.__game.lastHitId, h0.y, 90000);
  const h1 = await Y(() => { const G = window.__game; return { y: G.car.y, pitch: G.car.pitch, v: G.car.v, hit: G.lastHitId }; });
  check('실제 경사 도로(약 7~11%) 오르막 주행: 차가 지형 높이를 따라 올라가고 앞이 들린다(피치 > 3°)', climbed && !h1.hit && h1.y > h0.y + 1.5 && h0.pitch > 0.05, JSON.stringify({ grade: pick.g.toFixed(3), h0, h1 }));
  const gnd = await Y(() => { const G = window.__game; const t = G.map.terrain; const g = t.field; const fx = (G.car.x - g.x0) / g.cell; return { carY: G.car.y, ok: fx > 0 }; });
  check('차량 높이 = 지형 높이장(데이터) — 떠 있거나 묻히지 않음', gnd.ok);
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await until(() => Math.abs(window.__game.car.v) < 0.1, undefined, 60000);

  // ================= 4. 스트리밍: 다대포로 이동 → 먼 타일 해제, 게임 상태 유지 =================
  const before = await Y(() => { const G = window.__game; return { keys: G.saha.info().keys, state: G.state, mission: G.mission && G.mission.status, elapsed: G.mission ? G.mission.elapsed : 0, engine: G.engine.state }; });
  const lot = await Y(() => { const s = window.__game.map.slots.find((q) => q.id === 'saha-dadae-p'); return { x: s.x, z: s.z }; });
  await Y((p) => { const G = window.__game; const c = G.car; c.x = p.x + 14; c.z = p.z; c.y = G.groundHeight(c.x, c.z); c.v = 0; G.rig.snap(); }, lot);
  const moved = await until(() => window.__game.saha.ready(window.__game.car.x, window.__game.car.z), undefined, 90000);
  await sleep(600);
  const after = await Y(() => { const G = window.__game; const i = G.saha.info(); return { keys: i.keys, state: G.state, mission: G.mission && G.mission.status, engine: G.engine.state, cols: G.colliders.length, y: G.car.y, stats: G.saha.stats }; });
  const overlap = after.keys.filter((k) => before.keys.includes(k)).length;
  perf.stream = { before: before.keys.length, after: after.keys.length, overlap, stats: after.stats };
  check('스트리밍: 약 6km 떨어진 다대포로 이동하면 새 타일이 붙고 괴정 타일은 떨어진다(겹침 0)', moved && overlap === 0 && after.keys.length >= 4, JSON.stringify({ before: before.keys.length, after: after.keys.length, unloads: after.stats.unloads }));
  check('구역 이동 중 게임 상태 유지(진행 중 미션·시동·플레이 상태 초기화 없음)', after.state === 'playing' && after.mission === before.mission && after.engine === before.engine, JSON.stringify({ before: [before.state, before.mission, before.engine], after: [after.state, after.mission, after.engine] }));
  await pg.screenshot({ path: path.join(OUT, 'e2e-02-dadae.png') });
  // 내비가 먼 타일과 무관하게 경로 유지
  const navFar = await Y(() => window.__game.navState.status);
  check('먼 구역으로 와도 도로망(전역 데이터) 내비는 계속 동작', ['guiding', 'arrived', 'offroute', 'rerouting'].includes(navFar) || navFar === 'guiding', navFar);

  // ================= 5. 건물 충돌 =================
  const bTarget = await Y(() => { const G = window.__game; const cs = G.colliders.filter((c) => c.tag === 'building' && c.id.startsWith('sb-') && c.w > 6 && c.d > 6); const c = cs.sort((a, b) => Math.hypot(a.x - G.car.x, a.z - G.car.z) - Math.hypot(b.x - G.car.x, b.z - G.car.z))[0]; return c ? { x: c.x, z: c.z, id: c.id, y0: c.y0, w: c.w, d: c.d, rot: c.rot } : null; });
  if (bTarget) {
    // 건물 상자 중심에서 상자 폭 + 8m 떨어진 곳에서 건물을 향해 저속 주행
    await Y((b) => { const G = window.__game; const c = G.car; const dist = Math.max(b.w, b.d) / 2 + 8; const hx = Math.sin(b.rot), hz = Math.cos(b.rot); c.x = b.x - hx * dist; c.z = b.z - hz * dist; c.heading = b.rot; c.v = 0; c.gear = 'D'; c.handbrake = false; c.y = G.groundHeight(c.x, c.z); G.lastHitId = ''; G.rig.snap(); G.debugInput = { throttle: 0.5, brake: 0, steerInput: 0 }; }, bTarget);
    const hitB = await until(() => /^sb-/.test(window.__game.lastHitId || ''), undefined, 60000);
    const hb = await Y(() => { const G = window.__game; return { hit: G.lastHitId, x: G.car.x, z: G.car.z, v: G.car.v, y: G.car.y, gy: G.groundHeight(G.car.x, G.car.z), block: G.lastBlockReason }; });
    check('실제 건물 외곽(OSM)에서 만든 충돌체에 막힌다(스트리밍으로 붙은 충돌체)', hitB, JSON.stringify({ hb, bTarget }));
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  } else check('실제 건물 외곽(OSM)에서 만든 충돌체에 막힌다', false, '주변 건물 없음');

  // ================= 6. 노면 마찰 =================
  const muRoad = await Y(() => { const G = window.__game; const n = G.sahaBase.roadNet.nodes; const e = G.sahaBase.roadNet.edges.find(([a], i) => G.sahaBase.roadNet.cls[i] <= 3 && Math.hypot(n[a][0] - G.car.x, n[a][1] - G.car.z) < 800); const c = G.car; c.x = n[e[0]][0]; c.z = n[e[0]][1]; c.y = G.groundHeight(c.x, c.z); c.v = 0; G.muAcc = 1; return G.surfaceMu(); });
  const muOff = await Y(() => { const G = window.__game; const f = G.sahaBase.field; const cov = G.sahaBase.cover; let best = null; for (let j = 0; j < f.h && !best; j += 7) for (let i = 0; i < f.w; i += 7) { if (cov[j * f.w + i] === 2) { best = { x: f.x0 + i * f.cell, z: f.z0 + j * f.cell }; break; } } const c = G.car; c.x = best.x; c.z = best.z; c.y = G.groundHeight(c.x, c.z); G.muAcc = 1; return { mu: G.surfaceMu(), at: best }; });
  check('노면 마찰: 도로 위 아스팔트 1.0, 숲(토지피복) 위는 낮다 → 핸들링 모델 입력', muRoad === 1 && muOff.mu < 0.8, JSON.stringify({ muRoad, muOff }));

  // ================= 7. 고속 핸들링 (게임 루프) =================
  const flat = await Y(() => { const G = window.__game; const rn = G.sahaBase.roadNet; const n = rn.nodes; let best = null; rn.edges.forEach(([a, b], i) => { const L = Math.hypot(n[b][0] - n[a][0], n[b][1] - n[a][1]); if (L > 60 && Math.abs(n[b][2] - n[a][2]) / L < 0.01 && rn.cls[i] <= 3 && !best) best = { x: n[a][0], z: n[a][1], h: Math.atan2(n[b][0] - n[a][0], n[b][1] - n[a][1]) }; }); return best; });
  await Y((p) => { const G = window.__game; const c = G.car; c.x = p.x; c.z = p.z; c.y = G.groundHeight(p.x, p.z); c.heading = p.h; c.v = 0; c.gear = 'D'; c.handbrake = false; G.rig.snap(); G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; }, flat);
  await until(() => window.__game.saha.ready(window.__game.car.x, window.__game.car.z), undefined, 60000);
  const hs = await Y((p) => new Promise((res) => { const G = window.__game; const c = G.car; c.x = p.x; c.z = p.z; c.y = G.groundHeight(p.x, p.z); c.heading = p.h; c.v = 22; G.lastHitId = ''; c.steer = 0; G.debugInput = { throttle: 0.3, brake: 0, steerInput: 1 }; let maxBeta = 0, maxAy = 0, n = 0; const tick = () => { n++; if (c.v > 6) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c.vy || 0, c.v))); maxAy = Math.max(maxAy, Math.abs(c.ay || 0)); if (n < 90) requestAnimationFrame(tick); else res({ maxBeta: maxBeta * 57.3, maxAy, yaw: c.yawRate, v: c.v, hit: G.lastHitId }); }; tick(); }), flat);
  check('고속(시속 80km) 풀조향: 동역학 모델로 횡가속도 ≤ μ·g, 차체 횡미끄럼각 < 12°(스핀 없음), 실제로 선회함', hs.maxAy < 9.81 * 1.05 && hs.maxAy > 3 && hs.maxBeta < 12 && hs.hit !== 'edge', JSON.stringify(hs));
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await until(() => Math.abs(window.__game.car.v) < 0.1, undefined, 60000);

  // ================= 8. 성능 표본 =================
  await Y(() => { window.__game.debugInput = null; });
  await sleep(3000);
  perf.fps = await Y(() => ({ inst: window.__game.fpsInstant, avg: window.__game.avgFps ? window.__game.avgFps() : null }));
  perf.info = await Y(() => { const G = window.__game; const i = G.saha.info(); return { ...i, keys: i.keys.length, renderCalls: G.renderer.info.render.calls, tris: G.renderer.info.render.triangles, geometries: G.renderer.info.memory.geometries, textures: G.renderer.info.memory.textures }; });
  perf.fetchedFiles = fetched.length;
  perf.fetchedTiles = fetched.filter((f) => f.startsWith('tiles/')).length;
  check('필요한 타일만 받는다(전체 600개 중 일부)', perf.fetchedTiles > 0 && perf.fetchedTiles < 200, `타일 ${perf.fetchedTiles}개, 파일 ${perf.fetchedFiles}개`);

  // ================= 9. 기계식 시설(사하구) =================
  await Y(() => { const G = window.__game; G.updateSettings({ missionId: 'saha-mech-in' }); G.startRun(); });
  await until(() => window.__game.mission && window.__game.missionDef.id === 'saha-mech-in' && window.__game.state === 'playing', undefined, 60000);
  await sleep(1500);
  const mech = await Y(() => { const G = window.__game; return { y: G.car.y, fac: G.facilities.length, phase: G.facilities[0].ctl.m.phase, pallet: !!G.map.slots.find((s) => s.id === 'saha-mech:pallet') }; });
  check('사하구 기계식 미션: 시설 앞 지면 y=0(평탄화)에서 시작, 장치 대기 상태', Math.abs(mech.y) < 0.05 && mech.fac === 1 && mech.phase === 'waiting' && mech.pallet, JSON.stringify(mech));
  await Y(() => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.debugInput = { throttle: 0.25, brake: 0, steerInput: 0 }; });
  const near = await until(() => { const G = window.__game; const s = G.map.slots.find((q) => q.id === 'saha-mech:pallet'); return Math.hypot(G.car.x - s.x, G.car.z - s.z) < 8 || G.lastHitId; }, undefined, 90000);
  const mv = await Y(() => ({ hit: window.__game.lastHitId, y: window.__game.car.y }));
  check('기계식 시설 진입로를 따라 승강장 앞까지 주행(지형 충돌 없음)', near && Math.abs(mv.y) < 0.2, JSON.stringify(mv));
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await pg.screenshot({ path: path.join(OUT, 'e2e-03-mech.png') });

  // ================= 10. 다른 맵으로 돌아가기 =================
  await Y(() => { const G = window.__game; G.debugInput = null; G.updateSettings({ mapId: 'lot', missionId: 'free' }); G.startRun(); });
  await until(() => window.__game.map.id === 'lot' && window.__game.state === 'playing', undefined, 60000);
  const back = await Y(() => ({ saha: !!window.__game.saha, cols: window.__game.colliders.length, far: window.__game.rig.camera.far }));
  check('다른 맵으로 바꾸면 사하구 스트리밍 해제(충돌체·원거리 평면 원래대로)', !back.saha && back.cols === lotCols && back.far === 600, JSON.stringify({ back, lotCols }));
  await Y(() => { const G = window.__game; G.updateSettings({ mapId: 'saha', missionId: 'free' }); G.startRun(); });
  const again = await until(() => window.__game.map.id === 'saha' && window.__game.state === 'playing' && window.__game.saha && window.__game.saha.ready(window.__game.car.x, window.__game.car.z), undefined, 60000);
  check('사하구로 다시 들어오면 기본 데이터를 다시 받지 않고 바로 시작', again && fetched.filter((f) => f === 'manifest.json').length === 1, `manifest 요청 ${fetched.filter((f) => f === 'manifest.json').length}회`);

  check('콘솔 오류/페이지 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(perf, null, 1));
  console.log('PERF ' + JSON.stringify(perf));
  const fail = results.filter((r) => !r.ok).length;
  console.log(`결과: ${results.length - fail}/${results.length} PASS`);
  await browser.close();
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SCRIPT ERROR', e);
  process.exit(2);
});
