/**
 * v0.6.3 브라우저 통합 테스트 — P0 자동 카메라 방향(실제 게임, 실제 센서/카메라/화면).
 *   node scripts/e2e-v063.cjs                       (현재 dist)
 *   ROOT=<이전 버전 작업트리> TAG=v061 node scripts/e2e-v063.cjs   (그 작업트리의 dist 로 같은 장면 — 비교 캡처, 판정은 기록만)
 *   ONLY=pdc|map                                    (부분 실행)
 * 장면 정의는 tests/fixtures/pdcScenes.ts(단위 테스트·하네스와 동일). 운전 입력은 게임 시간(G.time) 기준.
 * 화면: docs/screenshots/v063/<TAG>/ — 왼쪽 위에 장면·실제 위험 방향·선택 카메라를 표시한 뒤 캡처.
 * 결과는 PASS/FAIL 줄 + 종료 코드(실패 1, 스크립트 오류 2).
 */
require('tsx/cjs');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { SCENES, sceneColliders } = require('../tests/fixtures/pdcScenes.ts');
const { VEHICLES } = require('../src/vehicle/spec.ts');
const { localToWorld } = require('../src/core/math.ts');

const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '..'));
const TAG = process.env.TAG || 'cur';
const ONLY = process.env.ONLY || '';
const PORT = 4363 + (TAG === 'cur' ? 0 : TAG === 'v061' ? 1 : 2);
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v063', TAG);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const strict = TAG === 'cur';
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : strict ? 'FAIL' : 'NOTE'}  ${name}${detail ? '  — ' + detail : ''}`); };
const DIR_KO = (x, z, hw, hl) => {
  const fb = z > hl * 0.6 ? '앞' : z < -hl * 0.6 ? '뒤' : '';
  const lr = x > hw ? '왼쪽' : x < -hw ? '오른쪽' : '';
  return [lr, fb].filter(Boolean).join(' ') || '정면';
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: ROOT });
  await sleep(3500);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', sensorViewFps: 10, vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false, infoAutoShow: true, assistAutoView: true })));
  await pg.goto(`http://127.0.0.1:${PORT}/`);
  await pg.waitForSelector('#m-start');
  await pg.click('#m-start');
  await pg.waitForSelector('#hud:not(.hidden)');
  const Y = (fn, arg) => pg.evaluate(fn, arg);
  const until = (fn, arg, timeout = 120000) => pg.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true).catch(() => false);
  const loadMap = async (mapId, veh = 'sedan') => {
    await Y(([mapId, veh]) => { const G = window.__game; G.updateSettings({ mapId, missionId: 'free', vehicleId: veh, assistAutoView: true }); G.startRun(); }, [mapId, veh]);
    await until((id) => window.__game.map.id === id && window.__game.state === 'playing', mapId, 90000);
    await sleep(800);
  };
  const place = async (x, z, h, gear) => {
    await Y(([x, z, h]) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = x - Math.sin(h) * off; c.z = z - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; if (G.groundHeight) c.y = G.groundHeight(x, z); G.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; G.rig.snap(); }, [x, z, h]);
    // 이전 장면에서 끝까지 돌린 핸들이 조향 모델로 되돌아오는 중에 변속하면 정차 조향 재평가가 엉뚱한 장면 시작을 만든다 → 직진 복귀 대기
    await until(() => Math.abs(window.__game.car.steer) < 0.01, undefined, 10000);
    await Y(() => { window.__game.debugInput = null; });
    await pg.keyboard.down('KeyS');
    await until(() => window.__game.brake > 0.4, undefined, 10000);
    // P 를 거쳐 변속: 이전 장면의 자동 시점 상태가 남지 않게(기어 변경 = 시점 정책 초기화, 실제 주행 흐름과 같음)
    await Y(() => window.__game.requestShift('P'));
    await until(() => window.__game.car.gear === 'P', undefined, 5000);
    await sleep(200);
    await Y((g) => window.__game.requestShift(g), gear);
    await until((g) => window.__game.car.gear === g, gear, 5000);
    await pg.keyboard.up('KeyS');
    await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
  };

  try {
    if (!ONLY || ONLY === 'pdc') {
      // ================= P0: 자동 카메라 방향 (장면 18개) =================
      await loadMap('megapark');
      const spec = VEHICLES[1];
      // 빈 평지 찾기: 맵 범위 안, 반경 12m 안에 충돌체가 없고 ±6m 지면 높이가 같은 점 (megapark 남서쪽 공터)
      const spot = await Y(() => {
        const G = window.__game;
        const gh = G.groundHeight ? (x, z) => G.groundHeight(x, z) : () => 0; // v0.6.1 이전 빌드에는 없음(비교 실행)
        const b = G.map.bounds;
        for (let x = b.minX + 16; x <= b.maxX - 16; x += 2)
          for (let z = b.minZ + 16; z <= b.maxZ - 16; z += 2) {
            if (!G.colliders.every((c) => Math.hypot(c.x - x, c.z - z) > 12 + (c.kind === 'box' ? Math.max(c.w, c.d) / 2 : c.r))) continue;
            const g0 = gh(x, z);
            if ([[6, 0], [-6, 0], [0, 6], [0, -6]].every(([dx, dz]) => Math.abs(gh(x + dx, z + dz) - g0) < 0.02)) return { x, z, y: g0 };
          }
        return null;
      });
      check('빈 시험 구역 확보(반경 14m 충돌체 없음)', !!spot, JSON.stringify(spot));
      const H = 0.7;
      const hw = spec.width / 2;
      const hl = spec.length / 2;
      const summary = [];
      const SCN = process.env.SCN ? process.env.SCN.split(',') : null;
      for (const sc of SCENES.filter((q) => !SCN || SCN.includes(q.id))) {
        const cols = sceneColliders(sc, spec, H, spot).map((c) => ({ ...c, id: 't-' + c.id, y0: c.y0 + spot.y }));
        const hz = sc.objs.find((o) => o.id === sc.hazard);
        const hzLocal = hz ? hz.at(hw, hl) : null;
        const hazDir = hzLocal ? DIR_KO(hzLocal.x, hzLocal.z, hw, hl) : '양쪽';
        const hazCol = cols.find((c) => c.id === 't-' + sc.hazard) || null;
        // 위험 물체 외곽 표본점(월드) — 브라우저에서 간격 계산
        const hazPts = [];
        if (hazCol && hazCol.kind === 'cyl') for (let k = 0; k < 36; k++) hazPts.push({ x: hazCol.x + hazCol.r * Math.cos((k / 36) * 2 * Math.PI), z: hazCol.z + hazCol.r * Math.sin((k / 36) * 2 * Math.PI) });
        else if (hazCol) for (let k = 0; k <= 30; k++) {
          const a = -hazCol.w / 2 + (hazCol.w * k) / 30;
          const b = -hazCol.d / 2 + (hazCol.d * k) / 30;
          for (const [lx, lz] of [[a, -hazCol.d / 2], [a, hazCol.d / 2], [-hazCol.w / 2, b], [hazCol.w / 2, b]]) hazPts.push(localToWorld(hazCol.x, hazCol.z, hazCol.rot, lx, lz));
        }
        const steps = Math.round(sc.dur / 0.05);
        const prof = Array.from({ length: steps + 1 }, (_, k) => ({ v: sc.vAt ? sc.vAt(k * 0.05) : 0, s: sc.steerAt ? sc.steerAt(k * 0.05) : sc.steer0 ?? 0 }));
        // 장애물 제거(이전 장면) → 배치 → 장애물 추가(배열은 제자리 수정)
        await Y(() => { const G = window.__game; for (let i = G.colliders.length - 1; i >= 0; i--) if (String(G.colliders[i].id).startsWith('t-')) { G.colliderById.delete(G.colliders[i].id); G.colliders.splice(i, 1); } G.debugViewCtx = null; });
        // 같은 개수로 지우고 넣으면 공간 인덱스가 바뀐 줄 모른다(길이/참조 규칙) — 지운 것이 조회에서 사라질 때까지 기다린다
        await until(() => !window.__game.nearColliders().some((c) => String(c.id).startsWith('t-')), undefined, 10000);
        await place(spot.x, spot.z, H, sc.gear);
        await Y((cols) => { const G = window.__game; for (const c of cols) { G.colliders.push(c); G.colliderById.set(c.id, c); } }, cols);
        await sleep(300);
        if (process.env.DBG) console.log('DBG', sc.id, JSON.stringify(await Y(() => { const G = window.__game; return { t: G.colliders.filter((c) => String(c.id).startsWith('t-')).map((c) => c.id), near: G.nearColliders().filter((c) => String(c.id).startsWith('t-')).map((c) => c.id), dyn: (G.damage && G.damage.dynamicColliders || []).map((c) => c.id) }; })));
        // 게임 시간 기준 운전기(페이지 안 rAF) — 위험 물체에 0.25m 까지 다가가면 정지(운전자가 멈추는 상황)
        if (process.env.DBG) await Y(() => { window.__dbgTrace = true; });
        await Y(([prof, hazPts, dur]) => {
          const G = window.__game;
          const st = { t0: G.time, done: false, seq: [], minGap: 1e9, atMin: null, stop: false };
          window.__drv = st;
          const gapOf = () => {
            if (!hazPts.length) return 9;
            const off = G.spec.length / 2 - G.spec.rearOverhang;
            const cx = G.car.x + Math.sin(G.car.heading) * off;
            const cz = G.car.z + Math.cos(G.car.heading) * off;
            const c = Math.cos(G.car.heading), s = Math.sin(G.car.heading);
            let m = 1e9;
            for (const p of hazPts) {
              const dx = p.x - cx, dz = p.z - cz;
              const lx = dx * c - dz * s, lz = dx * s + dz * c;
              m = Math.min(m, Math.hypot(Math.max(Math.abs(lx) - G.spec.width / 2, 0), Math.max(Math.abs(lz) - G.spec.length / 2, 0)));
            }
            return m;
          };
          const tick = () => {
            const t = G.time - st.t0;
            if (t >= dur) { st.done = true; return; }
            const k = Math.min(prof.length - 1, Math.round(t / 0.05));
            const p = prof[k];
            const g = gapOf();
            if (g < 0.25) st.stop = true;
            const want = st.stop ? 0 : Math.abs(p.v);
            const v = Math.abs(G.car.v);
            const thr = want > 0 && v < want ? 0.22 : 0;
            const brk = want === 0 ? 1 : v > want + 0.1 ? 0.3 : 0;
            G.debugInput = { throttle: thr, brake: brk, steerInput: p.s / G.spec.maxSteer };
            const vo = G.viewOut;
            const last = st.seq[st.seq.length - 1];
            if (!last || last.view !== vo.view) st.seq.push({ t: +t.toFixed(2), view: vo.view, auto: vo.auto, reason: vo.reason });
            if (window.__dbgTrace && (!st.tr || t - st.trT >= 0.25)) { st.trT = t; (st.tr = st.tr || []).push({ t: +t.toFixed(2), g: +g.toFixed(2), v: +G.car.v.toFixed(2), st: +G.car.steer.toFixed(2), view: vo.view, r: (G.rankOut || []).map((q) => `${q.id}:c${q.cls}/p${q.pathDist && q.pathDist.toFixed(2)}/pg${q.passGap && q.passGap.toFixed(2)}/${q.relevant ? 'R' : '-'}/${q.contact}/gap${q.gap.toFixed(2)}`).join(' ') }); }
            if (g <= st.minGap + 1e-3) { st.minGap = g; st.atMin = { t, view: vo.view, inView: G.viewLog ? G.viewLog.inView : null, log: G.viewLog ? { id: G.viewLog.id, cls: G.viewLog.cls, place: G.viewLog.place, contact: G.viewLog.contact, relevant: G.viewLog.relevant, gap: G.viewLog.gap, reason: G.viewLog.reason } : null }; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, [prof, hazPts, sc.dur]);
        await until(() => window.__drv.done, undefined, 180000);
        if (process.env.DBG) console.log('TRACE', sc.id, JSON.stringify(await Y(() => window.__drv.tr || []), null, 0));
        await Y(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: window.__game.debugInput ? window.__game.debugInput.steerInput : 0 }; });
        const st = await Y(() => ({ seq: window.__drv.seq, minGap: window.__drv.minGap, atMin: window.__drv.atMin, view: window.__game.viewOut.view, log: window.__game.viewLog || null, top: (window.__game.rankOut || []).slice(0, 2).map((q) => ({ id: q.id, cls: q.cls, place: q.place, contact: q.contact, relevant: q.relevant })) }));
        const autoViews = st.seq.filter((q) => q.auto).map((q) => q.view);
        const wrong = autoViews.filter((v) => sc.forbid.includes(v));
        const finalOk = sc.allow.includes(st.view);
        const seenOk = !st.atMin || st.atMin.inView !== false || st.minGap > 0.8;
        // 캡처: 장면/실제 위험 방향/선택 카메라 라벨
        await Y(([label]) => {
          let d = document.getElementById('e2e-label');
          if (!d) { d = document.createElement('div'); d.id = 'e2e-label'; d.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:rgba(0,0,0,.72);color:#fff;font:600 14px/1.45 sans-serif;padding:8px 10px;border-radius:6px;max-width:560px;white-space:pre-line;pointer-events:none'; document.body.appendChild(d); }
          d.textContent = label;
        }, [`[${TAG}] ${sc.name}\n실제 위험 방향: ${hazDir}${sc.hazard ? ` (${sc.hazard})` : ''}\n선택 카메라: ${st.view}${st.seq.length > 1 ? `  (전환: ${st.seq.map((q) => q.view).join(' → ')})` : ''}\n허용: ${sc.allow.join(', ')} · 금지: ${sc.forbid.join(', ')}`]);
        await pg.screenshot({ path: path.join(OUT, `${sc.id}.png`) });
        await Y(() => { const d = document.getElementById('e2e-label'); if (d) d.remove(); });
        summary.push({ id: sc.id, view: st.view, seq: st.seq.map((q) => q.view), wrong, atMin: st.atMin });
        check(`P0 ${sc.id} ${sc.name}: 금지 방향 전환 없음 · 최종 카메라 허용 · 가장 가까울 때 위험 물체가 화면 안`, wrong.length === 0 && finalOk && seenOk, JSON.stringify({ hazDir, final: st.view, seq: st.seq.map((q) => `${q.t}:${q.view}${q.auto ? '*' : ''}`), wrong, minGap: +st.minGap.toFixed(2), atMin: st.atMin, top: st.top }).slice(0, 700));
      }
      fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
      // 디버그 로그 필드(일반 HUD 에는 숫자 없음)
      if (strict) {
        const lg = await Y(() => window.__game.viewLog);
        check('P0 자동 카메라 프레임 로그: 장애물 ID·월드/로컬 위치·간격·기어·조향·등급·카메라·사유·화면 포함 여부', lg && 'id' in lg && 'world' in lg && 'local' in lg && 'gap' in lg && 'gear' in lg && 'steer' in lg && 'cls' in lg && 'view' in lg && 'reason' in lg && 'inView' in lg, JSON.stringify(lg).slice(0, 300));
        const hudNums = await Y(() => /\d+(\.\d+)?\s*m\b/.test(document.querySelector('#hud').innerText));
        check('일반 HUD 에 거리(m) 숫자 없음', !hudNums);
      }
      await Y(() => { const G = window.__game; for (let i = G.colliders.length - 1; i >= 0; i--) if (String(G.colliders[i].id).startsWith('t-')) { G.colliderById.delete(G.colliders[i].id); G.colliders.splice(i, 1); } });
    }
    if (!ONLY || ONLY === 'pdc' || ONLY === 'real') {
      // ================= P0 실제 맵 장면: 기계식 승강장 안쪽 벽/셔터 쪽 전진 · 주차타워 경사로 직진 =================
      const drive = async (sec, thr, steer) => {
        await Y(([sec, thr, steer]) => {
          const G = window.__game;
          const st = { t0: G.time, done: false, seq: [], logs: [] };
          window.__drv2 = st;
          const tick = () => {
            const t = G.time - st.t0;
            if (t >= sec) { st.done = true; G.debugInput = { throttle: 0, brake: 1, steerInput: steer / G.spec.maxSteer }; return; }
            G.debugInput = { throttle: Math.abs(G.car.v) < 0.6 ? thr : 0, brake: 0, steerInput: steer / G.spec.maxSteer };
            const vo = G.viewOut;
            const last = st.seq[st.seq.length - 1];
            if (!last || last.view !== vo.view) st.seq.push({ t: +t.toFixed(2), view: vo.view, auto: vo.auto, log: G.viewLog ? { id: G.viewLog.id, place: G.viewLog.place, contact: G.viewLog.contact, cls: G.viewLog.cls, relevant: G.viewLog.relevant } : null });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, [sec, thr, steer]);
        await until(() => window.__drv2.done, undefined, 120000);
        return Y(() => window.__drv2.seq);
      };
      await loadMap('mechpark');
      await place(-4.4, 0, Math.PI / 2, 'D'); // 팔레트 위, 안쪽 벽 쪽으로
      const m1 = await drive(3, 0.18, 0);
      const bad1 = m1.filter((q) => q.auto && ['left', 'right', 'rear', 'topRear'].includes(q.view));
      await pg.screenshot({ path: path.join(OUT, 'real-mech-inner-wall.png') });
      check('P0 실제 맵: 기계식 승강장에서 안쪽 벽 쪽 전진 — 측면/후방 자동 시점으로 가지 않는다', bad1.length === 0, JSON.stringify(m1).slice(0, 500));
      await place(-6.5, 0, -Math.PI / 2, 'R'); // 셔터 쪽을 향한 후진 진입 자세 → 후진은 안쪽 벽, 앞은 셔터
      const m2 = await drive(2.5, 0.15, 0);
      const bad2 = m2.filter((q) => q.auto && ['left', 'right', 'front', 'topFront'].includes(q.view));
      await pg.screenshot({ path: path.join(OUT, 'real-mech-reverse.png') });
      check('P0 실제 맵: 기계식 승강장 후진 — 앞 셔터/옆 가이드 때문에 전방·측면 자동 시점으로 가지 않는다', bad2.length === 0, JSON.stringify(m2).slice(0, 500));
      await loadMap('tower');
      await place(-31, 0, Math.PI / 2, 'D');
      const m3 = await drive(6, 0.25, 0);
      const bad3 = m3.filter((q) => q.auto && ['rear', 'topRear'].includes(q.view));
      await pg.screenshot({ path: path.join(OUT, 'real-tower-ramp.png') });
      check('P0 실제 맵: 주차타워 경사로 직진 — 후방 자동 시점 없음(측면뷰는 그 쪽 벽 접촉 부위일 때만)', bad3.length === 0 && m3.filter((q) => q.auto && (q.view === 'left' || q.view === 'right')).every((q) => q.log && q.log.contact && q.log.contact.toLowerCase().includes(q.view)), JSON.stringify(m3).slice(0, 500));
    }
    if (errors.length) console.log('페이지 오류:', errors.slice(0, 5).join(' | '));
    if (strict) check('페이지 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    console.error('스크립트 오류', e);
    await browser.close();
    srv.kill();
    process.exit(2);
  }
  await browser.close();
  srv.kill();
  const pass = results.filter((r) => r.ok).length;
  console.log(`결과: ${pass}/${results.length} ${strict ? 'PASS' : '(비교용 기록)'}`);
  process.exit(strict && pass !== results.length ? 1 : 0);
})();
