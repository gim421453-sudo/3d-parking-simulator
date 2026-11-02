/** v0.4.8 전/후 비교 스크린샷: node scripts/shot-v048.cjs <tag> [repoDir]  → docs/screenshots/v048/<tag>-*.png (repoDir 의 dist 사용) */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const repo = process.argv[3] || path.join(__dirname, '..');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v048'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4195', '--host', '127.0.0.1', '--strictPort'], { cwd: repo, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  // 태블릿 터치 1280×800: 레버/기어/페달 배치
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off', vehicleId: 'suv-x6', assistCameraFps: 60 })));
    await p.goto('http://127.0.0.1:4195/'); await p.waitForSelector('#m-start'); await p.tap('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
    const g = (f, a) => p.evaluate(f, a);
    const place = (cx, cz, h, gear) => g(({ cx, cz, h, gear }) => { const G = window.__game; const c = G.car; const off = G.spec.length / 2 - G.spec.rearOverhang; c.x = cx - Math.sin(h) * off; c.z = cz - Math.cos(h) * off; c.heading = h; c.v = 0; c.steer = 0; c.gear = gear; c.handbrake = true; if (G.viewGate !== undefined) setTimeout(() => { G.viewGate = true; }, 400); }, { cx, cz, h, gear });
    const box = (id, x, z, w, d, h = 1.4) => g(([id, x, z, w, d, h]) => { const c = { kind: 'box', id: 't-' + id, tag: 'wall', x, z, w, d, rot: 0, y0: 0, h }; window.__game.colliders.push(c); window.__game.colliderById.set(c.id, c); }, [id, x, z, w, d, h]);
    const clear = () => g(() => { const G = window.__game; G.colliders = G.colliders.filter((c) => !String(c.id).startsWith('t-')); for (const k of [...G.colliderById.keys()]) if (String(k).startsWith('t-')) G.colliderById.delete(k); G.rig.colliders = G.colliders; });
    const L = await g(() => window.__game.spec.length);
    await clear(); await place(0, 10, 0, 'D'); await box('f', 0, 10 + L / 2 + 1.1 + 0.25, 7, 0.5, 1.6);
    await p.waitForTimeout(4500);
    await p.screenshot({ path: path.join(OUT, `${tag}-front-warning-tablet.png`) });
    await clear(); await place(0, 10, 0, 'R'); await box('r', 0, 10 - L / 2 - 1.1 - 0.25, 7, 0.5, 1.6);
    await p.waitForTimeout(4500);
    await p.screenshot({ path: path.join(OUT, `${tag}-rear-warning-tablet.png`) });
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
