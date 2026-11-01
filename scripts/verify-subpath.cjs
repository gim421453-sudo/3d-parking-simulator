/**
 * GitHub Pages 와 같은 "하위 경로" 배포를 로컬에서 재현해 검증한다 (Actions 를 쓰지 않음).
 * 사용: npm run build && node scripts/verify-subpath.cjs [저장소이름]
 *  - dist 를 http://127.0.0.1:PORT/<repo>/ 아래에서만 서빙 (그 밖의 경로는 404)
 *  - 페이지 로드 → 게임 시작 → WebGL 렌더/리소스 요청 실패/콘솔 오류/localStorage 유지를 확인
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO = process.argv[2] || '3d-parking-simulator';
const DIST = path.join(__dirname, '..', 'dist');
const PORT = 4195;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.glb': 'model/gltf-binary' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const prefix = `/${REPO}/`;
  if (!url.startsWith(prefix)) { res.writeHead(404); return res.end('not found (outside base path)'); }
  let rel = url.slice(prefix.length) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  const bad = [];
  const reqs = [];
  page.on('response', (r) => { reqs.push(r.url()); if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => bad.push('failed ' + r.url()));
  page.on('pageerror', (e) => bad.push('pageerror ' + e.message));
  page.on('console', (m) => m.type() === 'error' && bad.push('console ' + m.text()));
  const results = [];
  const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

  await page.goto(`http://127.0.0.1:${PORT}/${REPO}/`);
  await page.waitForSelector('#m-start', { timeout: 20000 });
  check('하위 경로(/' + REPO + '/)에서 메뉴 로드', true);
  const assets = reqs.filter((u) => /\/assets\//.test(u));
  check('JS/CSS 가 하위 경로의 상대 경로로 로드', assets.length >= 2 && assets.every((u) => u.includes(`/${REPO}/assets/`)), assets.map((u) => u.split('/').slice(-2).join('/')).join(', '));
  await page.click('#m-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const gl = await page.evaluate(() => { const c = document.getElementById('game-canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); return !!window.__game && window.__game.state === 'playing' && !!window.__game.renderer.getContext(); });
  check('WebGL 장면 렌더링 + 게임 진입', gl);
  const px = await page.evaluate(() => { const G = window.__game; return G.renderer.info.render.triangles; });
  check('삼각형이 실제로 그려짐 (renderer.info)', px > 1000, String(px));
  await page.evaluate(() => window.__game.updateSettings({ sensorRange: 3.1 }));
  await page.reload();
  await page.waitForSelector('#m-start');
  check('하위 경로에서 localStorage 설정 유지', (await page.evaluate(() => window.__game.settings.sensorRange)) === 3.1);
  const outside = (await fetch(`http://127.0.0.1:${PORT}/assets/x.js`)).status;
  check('base 경로 밖 요청 없음 (절대 경로 사용 안 함)', !reqs.some((u) => !u.includes(`/${REPO}/`) && u.startsWith(`http://127.0.0.1:${PORT}`)) && outside === 404);
  check('요청 실패/콘솔 오류 없음', bad.length === 0, bad.slice(0, 4).join(' | '));
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'subpath-menu.png') });
  await browser.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(ok ? '\n하위 경로 배포 검증: 모두 PASS' : '\n하위 경로 배포 검증: 실패 있음');
  process.exit(ok ? 0 : 1);
})();
