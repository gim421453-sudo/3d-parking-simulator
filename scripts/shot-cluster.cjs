/** v0.5.5 계기판 화면 확인: drawCluster 를 여러 상태로 그려 PNG 저장. node scripts/shot-cluster.cjs */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'v055');
(async () => {
  const srv = spawn('npx', ['vite', '--port', '4365', '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 5000));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:4365/');
  const base = { speedKmh: 0, gear: 'P', rpm: 750, engineState: 'RUNNING', signalLeft: false, signalRight: false, hazard: false, lightMode: 'AUTO', lowBeam: false, highBeam: false, handbrake: true, pdcLevel: 'none', pdcOn: true, steerDeg: 0, wheelDeg: 0, floor: null, mission: '자유주행', throttle: 0, brake: 0, pitchDeg: 0, speedMax: 60, redline: 6000, engineLabel: '세단 4기통(합성)', clock: '12:34', tail: false, doorOpen: false, locked: null, zones: { front: 'none', rear: 'none', left: 'none', right: 'none' } };
  const cases = {
    'cluster-1-idle': base,
    'cluster-2-reverse-pdc': { ...base, gear: 'R', speedKmh: 4, rpm: 1100, handbrake: false, brake: 0.4, pdcLevel: 'near', zones: { front: 'none', rear: 'near', left: 'far', right: 'mid' }, wheelDeg: -210, lowBeam: true, tail: true, lightMode: '하향등' },
    'cluster-3-ramp-drive': { ...base, gear: 'D', speedKmh: 18, rpm: 2300, handbrake: false, throttle: 0.6, pitchDeg: 8, floor: '2F', mission: '경사로 → 2층 전면 주차', signalLeft: true, wheelDeg: 35 },
    'cluster-4-fast': { ...base, gear: 'D', speedKmh: 132, speedMax: 160, rpm: 6100, handbrake: false, throttle: 1, highBeam: true, lowBeam: true, tail: true, lightMode: '상향등' },
    'cluster-6-damage': { ...base, gear: 'D', speedKmh: 12, rpm: 1500, handbrake: false, damage: { front: 0.7, rear: 0.1, left: 0.35, right: 0.05, level: 'severe' } },
    'cluster-5-critical-lift': { ...base, pdcLevel: 'critical', zones: { front: 'critical', rear: 'none', left: 'none', right: 'none' }, engineState: 'OFF', rpm: 0, locked: 'lift', hazard: true },
  };
  for (const [name, c] of Object.entries(cases)) {
    const url = await p.evaluate(async (c) => { const M = await import('/src/infotainment/cabinScreens.ts'); const cv = document.createElement('canvas'); cv.width = 768; cv.height = 294; M.drawCluster(cv.getContext('2d'), 768, 294, c); return cv.toDataURL('image/png'); }, c);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    console.log('saved', name);
  }
  await b.close();
  srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
