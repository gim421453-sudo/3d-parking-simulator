/** 터치 레이아웃 측정: node scripts/measure-touch.cjs <before|after>  (dist 필요) — 페달/기어/핸들/레버 좌표 + 스크린샷 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const tag = process.argv[2] || 'after';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v047'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4191', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const res = {};
  for (const [w, h] of [[1280, 800], [1024, 768], [960, 540], [780, 360]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    await p.addInitScript(() => localStorage.setItem('parksim.v1.settings', JSON.stringify({ quality: 'low', resolutionScale: 0.6, shadows: 'off' })));
    await p.goto('http://127.0.0.1:4191/'); await p.waitForSelector('#m-start'); await p.tap('#m-start');
    await p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 }); await p.waitForTimeout(1500);
    await p.evaluate(() => { const G = window.__game; G.car.gear = 'D'; G.car.v = 0.4; });
    await p.waitForTimeout(2000);
    res[`${w}x${h}`] = await p.evaluate(() => {
      const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      const act = document.querySelector('#gear-big span[data-g="' + document.getElementById('gear-big').dataset.g + '"]');
      return { vw: innerWidth, vh: innerHeight, brake: r('#touch .brk'), gas: r('#touch .gas'), wheel: r('#t-wheel'), shifter: r('#shifter'), gearBig: r('#gear-big'), gearActiveFont: act ? parseFloat(getComputedStyle(act).fontSize) : null };
    });
    await p.screenshot({ path: path.join(OUT, `${tag}-${w}x${h}.png`) });
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, `${tag}-metrics.json`), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res));
  await b.close(); srv.kill();
})();
