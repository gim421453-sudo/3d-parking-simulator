/**
 * v0.6.1 브라우저 통합 테스트: 표면 부착 PDC 경고(사용자 스크린샷 S1~S7 장면) · 장애물별 위험 순위/정지 중 조향 자동 시점 ·
 * 서라운드 4륜 예상 이동선 · 기계식 비상 수동복구(제어반 Action 경로) · 파손 연계(밀린 차량 새 위치 감지).
 *   node scripts/e2e-v061.cjs          (dist 필요)
 * 게임 상태를 기다린다. 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2). 화면은 docs/screenshots/v061/.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 4362;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v061');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'mechpark', missionId: 'free', sensorSound: false, engineSound: false, infoAutoShow: true })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 120000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const loadMap = async (mapId, veh = 'sedan') => {
    await Y(([mapId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId: 'free', vehicleId: veh }); G.startRun(); }, [mapId, veh]);
    await until((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 90000);
    await sleep(800);
  };
  /** 차체 중심을 (x,z)·heading h 에 정지 상태로 놓고 기어를 지정 (브레이크 밟고 변속 = 인터록 통과) */
  const place = async (x, z, h, gear) => {
    await Y(([x, z, h]) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = x - Math.sin(h) * off; c.z = z - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; G.rig.snap(); }, [x, z, h]);
    // 변속 인터록은 실제 브레이크 입력(키/페달)만 인정한다 → S 키를 누른 채 변속
    await Y(() => { window.__game.debugInput = null; });
    await pg.keyboard.down('KeyS');
    await until(() => window.__game.brake > 0.4, undefined, 10000);
    await Y((g) => window.__game.requestShift(g), gear);
    await until((g) => window.__game.car.gear === g, gear, 5000);
    await pg.keyboard.up('KeyS');
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await sleep(1200);
  };
  /** 판 밑변(corners[3]→[2])이 그 판의 충돌체 표면 위(면/원기둥 +2.5cm)에 있는가 */
  const zonesOnSurface = () => Y(() => {
    const G = window.__game;
    const res = [];
    for (const z of G.dbgZones) {
      const c = G.colliderById.get(z.colliderIds[0]) || (G.damage && G.damage.dynamicColliders.find((q) => q.id === z.colliderIds[0]));
      if (!c) { res.push({ id: z.sensorId, ok: false, why: 'no collider' }); continue; }
      let ok = true;
      for (const p of [z.corners[3], z.corners[2]]) {
        if (c.kind === 'cyl') { const d = Math.hypot(p.x - c.x, p.z - c.z); if (Math.abs(d - (c.r + 0.025)) > 0.02) ok = false; }
        else {
          const dx = p.x - c.x; const dz = p.z - c.z; const co = Math.cos(c.rot); const si = Math.sin(c.rot);
          const lx = dx * co - dz * si; const lz = dx * si + dz * co;
          const onX = Math.abs(Math.abs(lx) - (c.w / 2 + 0.025)) < 0.02 && Math.abs(lz) <= c.d / 2 + 0.03;
          const onZ = Math.abs(Math.abs(lz) - (c.d / 2 + 0.025)) < 0.02 && Math.abs(lx) <= c.w / 2 + 0.03;
          if (!onX && !onZ) ok = false;
        }
      }
      res.push({ id: z.sensorId, col: z.colliderIds[0], ok });
    }
    return res;
  });

  // ================= 1. S1/S5/S6: 기계식 승강장 안 정면 벽(D)·뒤쪽(R) — 판이 표면 위, 물체(면)마다 1장 =================
  await Y(() => { const G = window.__game; G.assistPanel && G.updateSettings({ pdcView: 'surround' }); });
  await place(-1.9, 0, Math.PI / 2, 'D'); // 팔레트 위, 정면 뒷벽 가까이
  await until(() => window.__game.assistOut && window.__game.assistOut.active && window.__game.dbgZones.length > 0, undefined, 20000);
  const s1 = await zonesOnSurface();
  const s1ids = s1.map((q) => q.id);
  check('S1 기계식 승강장 정면 벽(D): 경고 판이 모두 실제 충돌체 표면 위, 같은 면 중복 없음', s1.length > 0 && s1.every((q) => q.ok) && new Set(s1ids).size === s1ids.length, JSON.stringify(s1).slice(0, 300));
  await pg.screenshot({ path: path.join(OUT, 'S1-after-front-wall.png') });
  await place(-3.2, 0, -Math.PI / 2, 'R'); // 후진으로 들어온 자세: 뒤쪽이 승강장 안쪽 벽
  await until(() => window.__game.dbgZones.length > 0, undefined, 20000);
  const s5 = await zonesOnSurface();
  check('S5/S6 기계식 후방(R): 활처럼 늘어선 칸 판 대신 표면 판, 모두 표면 위', s5.length > 0 && s5.every((q) => q.ok) && s5.length <= 8, JSON.stringify(s5).slice(0, 300));
  await pg.screenshot({ path: path.join(OUT, 'S5-after-rear.png') });

  // ================= 2. S3: 비스듬히 선 주차 차량(45°, modlot) =================
  await loadMap('modlot');
  const mc = await Y(() => { const c = window.__game.colliderById.get('ma-car0') || window.__game.colliders.find((q) => /ma-car0/.test(q.id)); return c ? { x: c.x, z: c.z, rot: c.rot, id: c.id } : null; });
  await place(mc.x - 5.2, mc.z - 0.6, Math.PI / 2, 'D');
  await until(() => window.__game.dbgZones.some((z) => /ma-car/.test(z.colliderIds[0])), undefined, 20000);
  const s3 = (await zonesOnSurface()).filter((q) => /ma-car/.test(q.col || ''));
  check('S3 45° 주차 차량: 판이 차량 옆면/끝면을 따라 붙는다(차량 축 고정 판 아님)', s3.length > 0 && s3.every((q) => q.ok), JSON.stringify({ mc, s3 }).slice(0, 300));
  await pg.screenshot({ path: path.join(OUT, 'S3-after-angled-car.png') });

  // ================= 3. 정지 중 조향으로 자동 시점 + 위험 순위 근거 로그 (lot: 기둥 pil-1 왼쪽 앞) =================
  await loadMap('lot');
  await Y(() => window.__game.updateSettings({ assistAutoView: true }));
  // 기둥이 왼쪽 앞 바깥. v0.6.3: 직진 통과 간격이 근접 통과 기준(0.3m)보다 넓어야 '핸들을 풀면 경로가 기둥을 벗어남' 전제가 성립한다
  // (이전 위치 −1.45 는 직진 통과 간격 0.25m 라 근접 통과 위험으로 남았다). 0.15m 오른쪽 → 약 0.42m.
  await place(-11.2 - 1.6, 17.2 - 3.4, 0, 'D');
  await sleep(800);
  const st0 = await Y(() => ({ view: window.__game.viewOut.view, top: window.__game.rankOut[0] && { id: window.__game.rankOut[0].id, cls: window.__game.rankOut[0].cls, path: window.__game.rankOut[0].pathDist } }));
  // 정지 상태(속도 0)에서 핸들만 왼쪽으로 크게
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 1 }; });
  const switched = await until(() => { const G = window.__game; return Math.abs(G.car.v) < 0.01 && G.viewOut.auto && G.viewOut.view !== 'front'; }, undefined, 20000);
  const st1 = await Y(() => ({ v: window.__game.car.v, view: window.__game.viewOut.view, reason: window.__game.viewOut.reason, top: window.__game.rankOut.slice(0, 3).map((q) => ({ id: q.id, cls: q.cls, why: q.why, place: q.place, path: q.pathDist && +q.pathDist.toFixed(2), gap: +q.gap.toFixed(2) })) }));
  check('정지 중(속도 0) 왼쪽으로 조향 → 조향 경로가 기둥과 교차 → 자동으로 보조 시점 전환(근거: 위험 순위)', switched && st1.top[0] && st1.top[0].id === 'pil-1' && st1.top[0].path !== null, JSON.stringify({ st0, st1 }));
  await pg.screenshot({ path: path.join(OUT, 'stationary-steer-view.png') });
  // 핸들을 다시 직진으로 → 위험 해소 → 기본 카메라 복귀
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; window.__game.car.steer = 0; });
  const back = await until(() => window.__game.viewOut.view === 'front' && !window.__game.viewOut.auto, undefined, 20000);
  check('핸들을 풀면(경로가 기둥을 벗어남) 기본 전방 카메라로 복귀', back);
  // 수동 카메라 선택 우선
  await Y(() => window.__game.onAction('assistCamRear'));
  await sleep(300);

  // ================= 4. 서라운드 4륜 예상 이동선 =================
  await place(0, -6, 0, 'D');
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0.8 }; });
  const paths = await until(() => { const p = window.__game.assistPanel.debugSurPaths; return p.front === 2 && p.rear === 2 && p.swing === 1; }, undefined, 20000);
  const sp = await Y(() => ({ ...window.__game.assistPanel.debugSurPaths, mode: window.__game.settings.surroundGuideMode }));
  check('서라운드 상세 이동선: 앞바퀴 2(실선)·뒷바퀴 2(점선)·앞 모서리 스윙 1, 정지 중 조향만으로 표시', paths && sp.mode === 'detail', JSON.stringify(sp));
  await pg.screenshot({ path: path.join(OUT, 'surround-wheel-paths.png') });
  await Y(() => window.__game.updateSettings({ surroundGuideMode: 'basic' }));
  await sleep(800);
  const basic = await Y(() => window.__game.assistPanel.debugSurLines);
  check('설정 "기본": 이전 차체 폭 경계선 2개로 돌아간다', basic <= 2, String(basic));
  await Y(() => window.__game.updateSettings({ surroundGuideMode: 'detail' }));

  // ================= 5. 파손 연계: 밀린 주차 차량을 새 위치에서 감지 =================
  await place(-9.1, 12, 0, 'D');
  await Y(() => { const G = window.__game; G.car.v = 5; G.debugInput = { throttle: 0.4, brake: 0, steerInput: 0 }; });
  await until(() => window.__game.damage.stats.pushed >= 1, undefined, 20000);
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await until(() => Math.abs(window.__game.car.v) < 0.05 && window.__game.damage.dynamicColliders.every((c) => true), undefined, 20000);
  await sleep(2500);
  const pushed = await Y(() => { const G = window.__game; const d = G.damage.dynamicColliders[0]; return d ? { id: d.id, x: d.x, z: d.z } : null; });
  await place(pushed.x, pushed.z - 5.6, 0, 'D');
  await until(() => window.__game.dbgZones.some((z) => z.colliderIds[0] === window.__game.damage.dynamicColliders[0].id), undefined, 20000);
  const pz = (await zonesOnSurface()).filter((q) => q.col === pushed.id);
  check('충돌로 밀려난 주차 차량: 새 위치의 표면에 경고 판(이전 위치 잔상 없음)', pz.length > 0 && pz.every((q) => q.ok), JSON.stringify({ pushed, pz }));

  // ================= 6. 기계식 비상 수동복구 (제어반 Action 경로) =================
  await loadMap('mechpark');
  await place(-0.65 - 2.9 + 1.0, 0, Math.PI / 2, 'P');
  await Y(() => { const G = window.__game; const c = G.car; c.x = -0.65 - G.spec.wheelbase; c.z = 0; c.heading = Math.PI / 2; c.v = 0; c.gear = 'P'; c.handbrake = true; G.debugInput = null; });
  await sleep(1500);
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await sleep(500);
  await pg.keyboard.press('KeyO');
  await until(() => window.__game.engine.state === 'OFF', undefined, 20000);
  await Y(() => { window.__game.debugInput = null; });
  await pg.keyboard.press('KeyG');
  await sleep(500);
  await Y(() => { window.__game.mech.selectedSlot = '05A'; });
  await pg.keyboard.press('KeyJ');
  const lifting = await until(() => window.__game.mech.m.phase === 'lifting' && window.__game.mech.m.carriage.y > 3, undefined, 120000);
  await pg.keyboard.press('KeyX'); // 비상정지
  await sleep(500);
  const e0 = await Y(() => ({ ph: window.__game.mech.m.phase, y: window.__game.mech.m.carriage.y, newCars: window.__game.newCarCount }));
  await pg.keyboard.press('KeyZ'); // 제어반
  await sleep(300);
  const manualVisible = await Y(() => !document.querySelector('[data-r="manual"]').classList.contains('hidden'));
  await pg.click('#mech-ctl [data-a="mechManual"]');
  await sleep(300);
  const inManual = await Y(() => window.__game.mech.m.phase === 'manual');
  // 1층 복귀(셔터 닫힘 상태) → 셔터 개방 → 팔레트 승강장 안착 → 복구 완료
  await pg.click('#mech-ctl [data-a="mr:home"]');
  await until(() => window.__game.mech.m.carriage.y === 0 && window.__game.mech.m.manual && window.__game.mech.m.manual.targetY === null, undefined, 120000);
  const carFollow = await Y(() => ({ carY: window.__game.car.y, cy: window.__game.mech.m.carriage.y }));
  await pg.click('#mech-ctl [data-a="mr:doorOpen"]');
  await until(() => window.__game.mech.m.door === 1, undefined, 60000);
  await sleep(300);
  const panelText = await Y(() => document.querySelector('[data-r="mstat"]').textContent);
  await pg.screenshot({ path: path.join(OUT, 'mech-manual-recovery-panel.png') });
  await pg.click('#mech-ctl [data-a="mechRecoverDone"]');
  await sleep(500);
  const fin = await Y(() => { const G = window.__game; const m = G.mech.m; return { ph: m.phase, onPallet: m.carOnPallet, stored: Object.values(m.slots).filter(Boolean).length, newCars: G.newCarCount, msg: m.message }; });
  check('기계식 상승 중 비상정지 → 제어반에서 수동복구 진입 → 1층 복귀(차량이 캐리지와 함께 내려옴) → 셔터 개방 → 복구 완료: 출차 대기, 보관 0·새 차량 없음',
    lifting && e0.ph === 'estop' && manualVisible && inManual && Math.abs(carFollow.carY - carFollow.cy) < 0.05 && fin.ph === 'exit' && fin.onPallet && fin.stored === 0 && fin.newCars === e0.newCars,
    JSON.stringify({ e0, manualVisible, inManual, carFollow, fin, panel: panelText.slice(0, 140) }));
  await pg.keyboard.press('KeyG'); // 탑승
  await sleep(500);
  const boarded = await Y(() => ({ ph: window.__game.mech.m.phase, occ: window.__game.mech.m.occupant }));
  check('복구 후 탑승하면 정상 대기로 돌아가 자동 운전 재개 가능', boarded.ph === 'waiting' && boarded.occ === 'in', JSON.stringify(boarded));

  check('콘솔/페이지 오류 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  srv.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E 스크립트 오류:', e); process.exit(2); });
