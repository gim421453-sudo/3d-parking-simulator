/**
 * v0.5.4 브라우저 통합 테스트 (맵·지형·도로·시설): 실제 게임을 headless Chromium(소프트웨어 WebGL)으로 실행해 검증한다.
 *   node scripts/e2e-v054.cjs          (dist 필요)
 * 시간이 아니라 게임 상태를 기다린다. 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 4341;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v054');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 240000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const loadMap = async (mapId, missionId, veh) => {
    await Y(([mapId, missionId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId, vehicleId: veh }); G.startRun(); }, [mapId, missionId, veh]);
    await until((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 60000);
    await sleep(800);
  };
  const put = (x, z, h, y = 0) => Y(([x, z, h, y]) => { const G = window.__game; const c = G.car; c.x = x; c.z = z; c.heading = h; c.y = y; c.v = 0; c.steer = 0; c.pitch = 0; c.gear = 'D'; c.handbrake = false; G.collisions = 0; G.lastHitId = ''; G.rig.snap(); }, [x, z, h, y]);
  /** 게임 프레임마다 경로를 추종하는 오토파일럿(게임 입력 경로를 그대로 사용: debugInput) */
  await Y(() => {
    window.__ap = (path, speed, look = 3.5) => {
      const G = window.__game; let idx = 0;
      window.__apOff();
      G.__ri = G.readInput.bind(G);
      G.readInput = (dt) => {
        const c = G.car; const sp = G.spec; const off = sp.length / 2 - sp.rearOverhang;
        const cx = c.x + Math.sin(c.heading) * off; const cz = c.z + Math.cos(c.heading) * off;
        while (idx < path.length - 1 && Math.hypot(path[idx][0] - cx, path[idx][1] - cz) < look) idx++;
        const [tx, tz] = path[idx];
        let err = Math.atan2(tx - c.x, tz - c.z) - c.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
        G.debugInput = { throttle: Math.abs(c.v) < speed ? 1 : 0, brake: Math.abs(c.v) > speed * 1.3 ? 0.5 : 0, steerInput: Math.max(-1, Math.min(1, (err * 1.6) / sp.maxSteer)) };
        window.__apIdx = idx;
        return G.__ri(dt);
      };
    };
    window.__apOff = () => { const G = window.__game; if (G.__ri) { G.readInput = G.__ri; G.__ri = null; } G.debugInput = null; };
    window.__brake = () => { window.__apOff(); window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; };
  });
  const engineOff = async () => {
    if (await Y(() => window.__game.engine.state === 'OFF')) return true;
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await until(() => window.__game.brake > 0.4, undefined, 10000);
    await pg.keyboard.press('KeyO');
    const ok = await until(() => window.__game.engine.state === 'OFF', undefined, 20000);
    await Y(() => { window.__game.debugInput = null; });
    return ok;
  };

  // ================= 1. megapark: 실제 지하 B1 =================
  await loadMap('megapark', 'free', 'sedan');
  const mg = await Y(() => { const G = window.__game; return { b1: G.map.terrain.levels.some((l) => Math.abs(l.y + 3.2) < 1e-6), holes: (G.map.groundHoles || []).length, roads: (G.map.roads || []).length, fac: G.facilities.length, tiles: G.built.tileStats() }; });
  check('megapark: B1 층(-3.2m)·지면 구멍(경사로 트렌치)·도로 데이터 22개·기계식 시설 3기 로드', mg.b1 && mg.holes === 1 && mg.roads >= 20 && mg.fac === 3, JSON.stringify(mg));
  // 동쪽 간선도로 → 진입로 → 경사로 → B1 을 실제로 주행
  const Z = await Y(() => window.__game.map.roads.find((r) => r.id === 'ramp-underground').az);
  await put(80, Z - 16, 0, 0);
  await Y(([Z]) => window.__ap([[80, Z - 8], [78.5, Z - 2.5], [74, Z], [60, Z], [44, Z], [30, Z], [12, Z], [4, Z], [-2, Z]], 3.5), [Z]);
  const onRamp = await until(() => window.__game.car.y < -1.2 && window.__game.car.y > -2.2, undefined, 300000);
  const rs = await Y(() => { const G = window.__game; return { y: +G.car.y.toFixed(2), pitch: +G.car.pitch.toFixed(3), rootX: +G.model.root.rotation.x.toFixed(3), camY: +G.rig.active.position.y.toFixed(2), col: G.collisions, floor: document.getElementById('floor-ind').textContent }; });
  check('megapark 지하 경사로: 실제로 내려가는 중(높이 감소) + 차체 피치(코가 아래)가 모델에 반영 + 충돌 0', onRamp && rs.pitch < -0.08 && rs.rootX > 0.05 && rs.col === 0, JSON.stringify(rs));
  await pg.screenshot({ path: path.join(OUT, '10-e2e-ug-ramp.png') });
  const inB1 = await until(() => window.__game.car.y < -3.19 && window.__game.car.x < 6, undefined, 300000);
  await Y(() => window.__brake());
  await until(() => Math.abs(window.__game.car.v) < 0.05, undefined, 30000);
  await until(() => window.__game.indoorK > 0.95, undefined, 60000);
  const b1 = await Y(() => { const G = window.__game; const ids = new Set(); if (G.sensorSnap) for (const r of G.sensorSnap.readings) for (const h of r.hits) ids.add(h.colliderId); return { y: +G.car.y.toFixed(3), pitch: +G.car.pitch.toFixed(3), col: G.collisions, floor: document.getElementById('floor-ind').textContent, indoor: +G.indoorK.toFixed(2), camY: +G.rig.active.position.y.toFixed(2), low: G.currentLighting ? G.currentLighting().low : null, sens: [...ids] }; });
  check('megapark B1 도착: y=-3.2, 평지에서 피치 0, 충돌 0, 층 표시 "지하주차장 B1"', inB1 && Math.abs(b1.y + 3.2) < 0.01 && Math.abs(b1.pitch) < 0.01 && b1.col === 0 && /B1/.test(b1.floor), JSON.stringify(b1));
  check('megapark B1: 실내 구역 인식(주변광 감소) + 자동 전조등 ON + 추적 카메라가 지면 아래(천장 밑)에 있다', b1.indoor > 0.95 && b1.low === true && b1.camY < -0.3 && b1.camY > -3.2, JSON.stringify({ indoor: b1.indoor, low: b1.low, camY: b1.camY }));
  check('megapark B1: PDC 가 감지한 물체는 모두 지하 구역(ug:)의 것(지상 물체 감지 0)', b1.sens.length > 0 && b1.sens.every((id) => /^ug:|^ugr-/.test(id)), JSON.stringify(b1.sens.slice(0, 6)));
  await pg.screenshot({ path: path.join(OUT, '11-e2e-b1.png') });
  // 내비: 지상에서 B1 칸을 목적지로 — 경사로 안내
  const nav = await Y(() => { const G = window.__game; const slot = G.map.slots.find((s) => s.id === 'ug:un-5'); G.car.x = 62; G.car.y = 0; G.car.z = G.map.roads.find((r) => r.id === 'ramp-underground').az; G.car.heading = -Math.PI / 2; G.nav.setDestination(slot, { x: G.car.x, z: G.car.z, y: 0 }); const st = G.nav.update(2, { x: G.car.x, z: G.car.z, y: 0 }); return { status: st.status, ramp: st.ramp, level: st.level, dest: st.destLevel, text: st.text, pts: st.route ? st.route.points.length : 0, minY: st.route ? Math.min(...st.route.points.map((p) => p.y)) : 0 }; });
  check('megapark 내비: 지상 → B1 주차칸 경로(경사로 경유), 현재 층/목적지 층, "경사로 내려가기" 안내', nav.status === 'guiding' && nav.ramp && nav.ramp.dir === 'down' && /B1/.test(nav.dest) && nav.level === '지상' && nav.minY < -3 && /내려가기/.test(nav.text), JSON.stringify(nav));
  // 지상 차량은 B1 위를 그대로 지나간다(층별 충돌 분리)
  await put(-30, Z + 6, Math.PI / 2, 0);
  await Y(([Z]) => window.__ap([[-10, Z + 6], [8, Z + 6]], 4), [Z]);
  const over = await until(() => window.__game.car.x > 4, undefined, 120000);
  const ov = await Y(() => ({ col: window.__game.collisions, y: window.__game.car.y, hit: window.__game.lastHitId }));
  await Y(() => window.__brake());
  check('megapark: 지상 차량이 B1 구역 바로 위(지하 벽/기둥/주차 차량의 x,z)를 충돌 없이 지나간다', over && ov.col === 0 && Math.abs(ov.y) < 1e-6, JSON.stringify(ov));
  // 타일 가시성
  const tl = await Y(() => { const G = window.__game; G.car.x = -58; G.car.z = -190; G.zoneAcc = 1; return null; });
  await sleep(1500);
  const ts = await Y(() => window.__game.built.tileStats());
  check('megapark 타일 스트리밍: 먼 타일은 숨김(보이는 타일 < 전체)', ts.tiles > 20 && ts.visible > 0 && ts.visible < ts.tiles * 0.7, JSON.stringify(ts));
  void tl;

  // ================= 2. megapark: 복수 기계식 시설 독립 운용 =================
  await loadMap('megapark', 'free', 'sedan');
  const setLocal = (idx, lx, lz, lh) => Y(([idx, lx, lz, lh]) => { const G = window.__game; const f = G.facilities[idx].frame; const c = Math.cos(f.yaw), s = Math.sin(f.yaw); const car = G.car; car.x = f.x + lx * c + lz * s; car.z = f.z - lx * s + lz * c; car.heading = lh + f.yaw; car.v = 0; car.steer = 0; car.gear = 'P'; car.handbrake = false; car.pitch = 0; car.y = 0; G.collisions = 0; G.rig.snap(); }, [idx, lx, lz, lh]);
  const creepLocal = async (thr, slowLx, brakeLx) => {
    await Y(([th]) => { const G = window.__game; G.car.handbrake = false; G.car.gear = 'D'; G.debugInput = { throttle: th, brake: 0, steerInput: 0 }; }, [thr]);
    await until((t) => { const G = window.__game; return G.mech.localCar(G.car).x > t; }, slowLx, 300000);
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await until(() => Math.abs(window.__game.car.v) < 0.45, undefined, 60000);
    await Y(() => { const G = window.__game; window.__creep = true; const tick = () => { if (!window.__creep || !G.debugInput) return; G.debugInput = { throttle: Math.abs(G.car.v) < 0.35 ? 0.14 : 0, brake: 0, steerInput: 0 }; requestAnimationFrame(tick); }; G.debugInput = { throttle: 0.14, brake: 0, steerInput: 0 }; tick(); });
    await until((t) => { const G = window.__game; return G.mech.localCar(G.car).x > t; }, brakeLx, 300000);
    await Y(() => { window.__creep = false; window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await until(() => Math.abs(window.__game.car.v) < 0.03, undefined, 60000);
    await Y(() => { const G = window.__game; G.debugInput = null; G.car.gear = 'P'; G.car.handbrake = true; });
    await sleep(500);
  };
  const storeAt = async (idx, slot) => {
    await setLocal(idx, -17, 0, Math.PI / 2);
    await sleep(700);
    await creepLocal(0.5, -9.5, -3.5);
    await engineOff();
    await pg.keyboard.press('KeyG');
    await sleep(400);
    await Y((slot) => { window.__game.mech.selectedSlot = slot; }, slot);
    await pg.keyboard.press('KeyJ');
    return until(([idx, slot]) => { const G = window.__game; return !!G.facilities[idx].ctl.m.slots[slot] && G.facilities[idx].ctl.m.phase === 'waiting' && !!G.playerStoredSlot; }, [idx, slot], 600000);
  };
  const facIds = await Y(() => window.__game.facilities.map((f) => f.cfg.id + '/' + f.cfg.floors));
  const iNorth = facIds.findIndex((s) => /out-mech-north/.test(s));
  const st1 = await storeAt(0, '02B');
  const after1 = await Y(() => { const G = window.__game; return { occ: G.facilities.map((f) => Object.values(f.ctl.m.slots).filter(Boolean).length), act: G.activeFacility.cfg.id, newCars: G.newCarCount, y: G.car.y }; });
  check('megapark 12층 타워(원점 시설) 입고: 2F B 보관, 다른 두 시설은 비어 있음, 새 차 자동 생성 0', st1 && after1.occ[0] === 1 && after1.occ.slice(1).every((n) => n === 0) && after1.newCars === 0 && Math.abs(after1.y - 3) < 0.01, JSON.stringify({ facIds, after1 }));
  // 새 차량(명시적) → 야외 북쪽 6층 시설에 입고 (v0.5.3 에서 브라우저 미검증이던 시설)
  await pg.keyboard.press('KeyI');
  await sleep(500);
  const st2 = await storeAt(iNorth, '06A');
  const after2 = await Y(([i]) => { const G = window.__game; const f = G.facilities[i]; const sc = f.ctl.m.slots['06A']; const pose = sc ? f.ctl.storedPoseW('06A', sc) : null; return { occ: G.facilities.map((q) => Object.values(q.ctl.m.slots).filter(Boolean).length), floors: f.cfg.floors, y: G.car.y, dx: pose ? Math.abs(G.car.x - pose.x) : 9, dz: pose ? Math.abs(G.car.z - pose.z) : 9, act: G.activeFacility.cfg.id, door0: G.facilities[0].ctl.m.door, door: f.ctl.m.door, keys: [...G.storedModels.keys()], park: G.parkAreas.filter((a) => a.mech.length).map((a) => a.id + ':' + a.mech.map((m) => m.free + '/' + m.total).join(',')) }; }, [iNorth]);
  check('megapark 야외 북쪽 6층 시설 실제 입고: 6F A(높이 15m) 보관, 원점 시설의 보관 차량 유지, 시설별 차량 키 분리', st2 && after2.occ[0] === 1 && after2.occ[iNorth] === 1 && after2.floors === 6 && Math.abs(after2.y - 15) < 0.01 && after2.dx < 0.05 && after2.dz < 0.05 && after2.keys.length === 2 && new Set(after2.keys.map((k) => k.split('/')[0])).size === 2, JSON.stringify(after2));
  check('megapark 구역별 기계식 잔여: 기계식 구역 21/22, 야외 구역 22/22 + 9/10 (구역 독립 집계)', after2.park.some((s) => /mechpark:21\/22/.test(s)) && after2.park.some((s) => /outdoor:.*9\/10/.test(s) && /22\/22/.test(s)), JSON.stringify(after2.park));
  await pg.screenshot({ path: path.join(OUT, '12-e2e-mega-north6f.png') });
  // 한 시설이 동작 중일 때 다른 시설의 캐리지/셔터는 움직이지 않는다: 원점 시설에서 출고 시작 → 북쪽 시설 상태 불변
  const indep = await Y(([i]) => { const G = window.__game; const a = G.facilities[0].ctl; const b = G.facilities[i].ctl; const before = { by: b.m.carriage.y, bdoor: b.m.door, bphase: b.m.phase }; a.selectedSlot = '02B'; return before; }, [iNorth]);
  await pg.keyboard.press('KeyI');
  await sleep(400);
  await setLocal(0, -20, 0, Math.PI / 2);
  await sleep(900);
  await Y(() => { window.__game.mech.selectedSlot = '02B'; });
  await pg.keyboard.press('KeyK');
  const moving = await until(() => { const m = window.__game.facilities[0].ctl.m; return m.phase !== 'waiting' && m.carriage.y > 0.5; }, undefined, 120000);
  const ind2 = await Y(([i]) => { const b = window.__game.facilities[i].ctl.m; return { by: b.carriage.y, bdoor: b.door, bphase: b.phase, occ: Object.values(b.slots).filter(Boolean).length }; }, [iNorth]);
  check('megapark 시설 독립: 원점 시설이 출고 동작(캐리지 상승) 중에도 북쪽 시설의 캐리지/셔터/보관 상태는 그대로', moving && ind2.by === indep.by && ind2.bdoor === indep.bdoor && ind2.bphase === 'waiting' && ind2.occ === 1, JSON.stringify({ indep, ind2 }));

  // ================= 3. 다층 타워: 수정된 나선 램프(여러 속도) =================
  for (const [veh, v] of [['suv-x6', 2.0], ['suv-x6', 3.0], ['sedan', 2.5]]) {
    await loadMap('tower', 'free', veh);
    await put(2, 0, Math.PI / 2, 3.2);
    await Y(([v]) => { const sp = { cx: 24, cz: 5.2, rm: 5.05 }; const p = []; for (let x = 4; x <= 24; x += 1) p.push([x, sp.cz - sp.rm]); for (let th = -Math.PI / 2 + 0.05; th <= Math.PI; th += 0.06) p.push([sp.cx + sp.rm * Math.cos(th), sp.cz + sp.rm * Math.sin(th)]); p.push([sp.cx - sp.rm, sp.cz - 1.2], [sp.cx - sp.rm + 0.2, sp.cz - 3.2]); window.__ap(p, v, 3); }, [v]);
    const top = await until(() => window.__game.car.y > 6.39 && window.__game.car.z < 4, undefined, 400000);
    const r = await Y(() => ({ y: +window.__game.car.y.toFixed(2), col: window.__game.collisions, hit: window.__game.lastHitId, floor: document.getElementById('floor-ind').textContent }));
    await Y(() => window.__brake());
    check(`타워 나선 램프(폭 4.5m로 수정) ${veh} ${v}m/s: 3F 도달, 충돌 0`, top && r.col === 0 && r.floor === '3F', JSON.stringify(r));
  }
  await pg.screenshot({ path: path.join(OUT, '13-e2e-tower-3f.png') });

  // ================= 4. 정비소: 2주식 리프트 =================
  await loadMap('garage', 'gar-lift', 'sedan');
  const L = await Y(() => window.__game.lifts[0].cfg);
  await put(L.x, -14 + 1.4, 0, 0); // 시작 위치(문 앞 진입선)에서 D 단으로 출발
  await Y(([L]) => window.__ap([[L.x, -8], [L.x, 0], [L.x, L.z]], 1.2, 2.5), [L]);
  const inBay = await until(([L]) => { const G = window.__game; const off = G.spec.length / 2 - G.spec.rearOverhang; const cz = G.car.z + Math.cos(G.car.heading) * off; return cz > L.z - 0.12; }, [L], 300000);
  await Y(() => window.__brake());
  await until(() => Math.abs(window.__game.car.v) < 0.03, undefined, 30000);
  await Y(() => { const G = window.__game; G.car.gear = 'P'; G.car.handbrake = true; });
  await sleep(500);
  const lp = await Y(() => { const G = window.__game; return { col: G.collisions, visible: !document.getElementById('lift-panel').classList.contains('hidden'), checks: G.liftChecks.filter((c) => !c.ok).map((c) => c.key), active: !!G.activeLift }; });
  check('정비소: 문을 지나 두 기둥 사이 정위치 정차(충돌 0), 리프트 패널 표시, 남은 조건은 "시동 OFF" 뿐', inBay && lp.col === 0 && lp.visible && lp.active && lp.checks.join() === 'engine', JSON.stringify(lp));
  await pg.keyboard.press('PageUp');
  await sleep(400);
  check('정비소: 시동이 걸려 있으면 리프트가 올라가지 않는다', (await Y(() => window.__game.lifts[0].st.phase)) === 'idle');
  await engineOff();
  const camY0 = await Y(() => window.__game.rig.active.position.y);
  await pg.keyboard.press('PageUp');
  const rising = await until(() => { const s = window.__game.lifts[0].st; return s.locked && s.h > 0.6; }, undefined, 120000);
  const mid = await Y(() => { const G = window.__game; return { h: +G.lifts[0].st.h.toFixed(2), carY: +G.car.y.toFixed(2), modelY: +G.model.root.position.y.toFixed(2), arms: G.lifts[0].built.armAngle, carriage: +G.lifts[0].built.carriageY.toFixed(2) }; });
  // 상승 중 주행 입력 차단
  await Y(() => { window.__game.debugInput = { throttle: 1, brake: 0, steerInput: 0 }; window.__game.car.gear = 'D'; });
  await sleep(800);
  const hold = await Y(() => ({ v: window.__game.car.v, x: window.__game.car.x }));
  await Y(() => { window.__game.debugInput = null; window.__game.car.gear = 'P'; });
  check('정비소 리프트 상승: 암 고정 후 차량이 리프트 높이를 그대로 따라 올라간다(차량 y = 리프트 높이 = 모델 y), 주행 입력 차단', rising && Math.abs(mid.carY - mid.h) < 0.03 && Math.abs(mid.modelY - mid.h) < 0.05 && mid.arms === 1 && Math.abs(hold.v) < 1e-6, JSON.stringify({ mid, hold }));
  const topped = await until(() => window.__game.lifts[0].st.phase === 'holding', undefined, 120000);
  await sleep(600);
  const up = await Y(() => { const G = window.__game; return { h: G.lifts[0].st.h, carY: G.car.y, camY: G.rig.active.position.y, phase: G.lifts[0].st.phase }; });
  check('정비소 리프트 최고 높이 1.8m 에서 정지(고정 유지), 추적 카메라가 차량을 따라 올라감', topped && Math.abs(up.h - 1.8) < 1e-6 && Math.abs(up.carY - 1.8) < 0.01 && up.camY > camY0 + 1.0, JSON.stringify({ up, camY0 }));
  await pg.screenshot({ path: path.join(OUT, '14-e2e-lift-up.png') });
  await pg.keyboard.press('PageDown');
  const downed = await until(() => { const s = window.__game.lifts[0].st; return s.phase === 'idle' && !s.locked; }, undefined, 120000);
  const dn = await Y(() => ({ y: window.__game.car.y, h: window.__game.lifts[0].st.h, cycles: window.__game.lifts[0].st.cycles }));
  check('정비소 리프트 하강: 바닥까지 내려온 뒤 고정 해제(차량 y=0), 1회 완료', downed && Math.abs(dn.y) < 1e-6 && dn.h === 0 && dn.cycles === 1, JSON.stringify(dn));
  // 출차(후진): 시동 → R → 문 밖으로
  await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  await until(() => window.__game.brake > 0.4, undefined, 10000);
  await pg.keyboard.press('KeyO');
  await until(() => window.__game.engine.state === 'RUNNING', undefined, 30000);
  await Y(() => { const G = window.__game; G.car.gear = 'R'; G.car.handbrake = false; G.debugInput = { throttle: 0.5, brake: 0, steerInput: 0 }; });
  const outOk = await until(() => window.__game.car.z < -6, undefined, 300000);
  const oc = await Y(() => ({ col: window.__game.collisions, z: window.__game.car.z }));
  await Y(() => window.__brake());
  check('정비소: 하강 후 시동을 걸고 후진으로 정상 출차(충돌 0)', outOk && oc.col === 0, JSON.stringify(oc));

  // ================= 5. 골목길 / 도시형 구역 =================
  await loadMap('alley', 'al-1', 'compact');
  await put(-27, -19.6, Math.PI / 2, 0);
  await Y(() => window.__ap([[-24, -19.6], [-21.5, -19.4], [-19.2, -18.2], [-18.1, -15.5], [-18, -12], [-18, 3], [-17.7, 7], [-16.2, 9.4], [-13, 10], [0, 10], [8.5, 10], [12, 9.6], [13.7, 7.6], [14, 4], [14, -11], [14.3, -15], [16.5, -17.6], [20, -17.4], [26, -17.4]], 1.2, 2.2));
  const alleyOk = await until(() => window.__game.car.x > 20 && window.__game.car.z < -15, undefined, 600000);
  const al = await Y(() => ({ col: window.__game.collisions, hit: window.__game.lastHitId, nav: window.__game.navState.status }));
  await Y(() => window.__brake());
  check('골목길: 소형차가 골목 A→직각→B→직각→C 를 실제 주행으로 통과(충돌 0), 내비 경로 있음', alleyOk && al.col === 0 && al.nav !== 'noRoute', JSON.stringify(al));
  await pg.screenshot({ path: path.join(OUT, '15-e2e-alley.png') });
  await loadMap('citytest', 'ct-park', 'coupe-m4');
  const ct = await Y(() => { const G = window.__game; return { fac: G.facilities.length, roads: G.map.roads.length, nav: G.navState.status, pts: G.navState.route ? G.navState.route.points.length : 0 }; });
  check('도시형 구역: 로드 + 기계식 시설 1기 + 도로 7개 + 미션 목적지까지 내비 경로', ct.fac === 1 && ct.roads === 7 && ct.nav === 'guiding' && ct.pts > 2, JSON.stringify(ct));
  const r0 = await Y(() => window.__game.map.roads.find((r) => r.id === 'ct-h0'));
  await put(r0.ax + 6, r0.az - 2, Math.PI / 2, 0);
  await Y(([r]) => window.__ap([[r.bx - 60, r.az - 2]], 40, 12), [r0]);
  const fast = await until(() => Math.abs(window.__game.car.v) * 3.6 > 90, undefined, 300000);
  const fv = await Y(() => ({ kmh: Math.abs(window.__game.car.v) * 3.6, col: window.__game.collisions }));
  await Y(() => window.__brake());
  const stopped = await until(() => Math.abs(window.__game.car.v) < 0.05, undefined, 120000);
  const fs2 = await Y(([r]) => ({ x: window.__game.car.x, col: window.__game.collisions, lim: r.bx }), [r0]);
  check('도시형 구역 고속 주행: 직선 도로에서 90km/h 이상 가속 → 급제동으로 교차로 전에 정지(충돌 0)', fast && stopped && fs2.col === 0 && fs2.x < fs2.lim, JSON.stringify({ fv, fs2 }));
  // 고속 주행 뒤 같은 차량 상태로 주차장에 저속 진입(상태 초기화 없음)
  const tgt = await Y(() => { const G = window.__game; const s = G.navState.destination; return { x: s.x, z: s.z, eng: G.engine.state, starts: G.engine.starts }; });
  check('도시형 구역: 고속 주행 후에도 차량 상태(시동/기어)가 유지된다(초기화 없음)', tgt.eng === 'RUNNING');
  await pg.screenshot({ path: path.join(OUT, '16-e2e-city.png') });

  check('콘솔/페이지 오류 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  srv.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E 스크립트 오류:', e); process.exit(2); });
