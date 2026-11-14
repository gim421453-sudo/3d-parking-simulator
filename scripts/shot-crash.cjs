/** v0.6.0 충돌 파손 화면/수치 확인: lot 맵에서 콘·주차차량·방호벽·벽을 속도별로 들이받는다. node scripts/shot-crash.cjs (dist 필요) */
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path = require('path');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v060'); require('fs').mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4371', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: require('path').join(__dirname, '..') });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.7, shadows: 'off', vehicleId: 'sedan', mapId: 'lot', missionId: 'free', sensorSound: false, engineSound: false })));
  await p.goto('http://127.0.0.1:4371/'); await p.waitForSelector('#m-start'); await p.click('#m-start'); await p.waitForSelector('#hud:not(.hidden)'); await p.waitForTimeout(1200);
  const run = async (name, x, z, h, kmh, secs) => {
    await p.evaluate(([x, z, h, kmh]) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = x - Math.sin(h) * off; c.z = z - Math.cos(h) * off; c.heading = h; c.v = kmh / 3.6; c.steer = 0; c.gear = 'D'; c.handbrake = false; G.debugInput = { throttle: 0.6, brake: 0, steerInput: 0 }; G.__cruise = kmh / 3.6; G.rig.snap(); }, [x, z, h, kmh]);
    // 목표 속도 유지(충돌 전까지)
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      await p.evaluate(() => { const G = window.__game; if (G.damage.stats.impacts === 0 && G.car.v < G.__cruise) G.car.v = G.__cruise; });
      await p.waitForTimeout(50);
    }
    await p.evaluate(() => { window.__game.debugInput = { throttle: 0, brake: 1, steerInput: 0 }; });
    await p.waitForTimeout(1500);
    const st = await p.evaluate(() => { const G = window.__game; const d = G.damage; return { stats: d.stats, log: d.log.slice(-3).map((l) => `${l.id}/${l.tag} ${l.kmh.toFixed(0)}km/h ${Math.round(l.energy / 1000)}kJ ${l.action}${l.broke ? ' BROKE' : ''} car+${(l.carDamage * 100).toFixed(0)}%`), car: Object.fromEntries(Object.entries(d.carDamage).map(([k, v]) => [k, +v.toFixed(2)])), fx: d.effects.level, col: G.collisions, n: G.colliders.length, dyn: d.dynamicColliders.length, debris: d.debris.list.length }; });
    console.log(name, JSON.stringify(st));
    await p.screenshot({ path: path.join(OUT, name + '.png') });
    await p.evaluate(() => { const G = window.__game; G.debugInput = null; G.startRun(); });
    await p.waitForTimeout(1500);
  };
  // 콘(슬라럼 첫 콘 -26,-14) 시속 30 → 남쪽에서 북쪽(+z)으로
  await run('crash-1-cone-30', -26, -22, 0, 30, 2.5);
  // 주차 차량(북쪽 줄 n 칸, z=20 차량) 시속 20
  await run('crash-2-parkedcar-20', -9.1, 12, 0, 20, 2.5);
  // 방호벽 barrier-1 (-16,6) 시속 50 (서→동? 벽 길이 3m x 방향 → 남쪽에서 북쪽으로)
  await run('crash-3-barrier-50', -16, -2, 0, 50, 2.5);
  // 벽 n-back (0, 23.5) 시속 30 (막힘 + 균열)
  await run('crash-4-wall-30', 18, 0, Math.PI / 2, 30, 2.5);
  // 벽 n-back 시속 100 (구멍)
  await run('crash-5-wall-100', 8, 0, Math.PI / 2, 100, 2.0);
  await run('crash-6-wall-hole-then-drive', 8, 0, Math.PI / 2, 110, 3.5);
  console.log('errors', errs.slice(0, 3));
  await b.close(); srv.kill();
})();
