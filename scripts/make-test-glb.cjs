/**
 * 코드로 생성한 세단을 실제 GLB 파일로 내보낸다 (GLB 파이프라인 시험용).
 * 사용: npm run build && node scripts/make-test-glb.cjs   → public/models/sedan-test.glb
 * Blender 없이도 "GLB 파일 → 로더 → 바퀴/조향/램프 연결" 전체 경로를 검증하기 위한 도구이다.
 * (실제 Blender 모델은 docs/BLENDER_PIPELINE.md 절차로 만든다. 이 파일의 품질은 코드 생성 차량과 같다.)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4186', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore', cwd: path.join(__dirname, '..') });
  await new Promise((r) => setTimeout(r, 2500));
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  const p = await (await b.newContext()).newPage();
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  await p.goto('http://127.0.0.1:4186/');
  await p.waitForSelector('#m-start');
  const arr = await p.evaluate(() => window.__devExportGlb('sedan'));
  const out = path.join(__dirname, '..', 'public', 'models', 'sedan-test.glb');
  fs.writeFileSync(out, Buffer.from(arr));
  console.log('wrote', out, fs.statSync(out).size, 'bytes');
  await b.close();
  srv.kill();
})();
