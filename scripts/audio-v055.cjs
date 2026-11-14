/** v0.5.5 엔진음 오프라인 렌더 분석 (소리를 직접 들을 수 없는 환경용 객관 검사). node scripts/audio-v055.cjs
 *  OfflineAudioContext 로 실제 그래프를 렌더해 ① 무음/클리핑/NaN 없음 ② 점화 주파수 성분이 주변보다 큼 ③ 실내가 더 어둡고 조용함 ④ 부하에서 고역 증가 를 확인한다. */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PORT = 4363;
(async () => {
  const srv = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 5000));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/`);
  const res = await p.evaluate(async () => {
    const A = await import('/src/audio/engineSound.ts');
    const E = await import('/src/vehicle/engine.ts');
    const SR = 44100;
    const render = async (prof, rpm, thr, cabin) => {
      const c = new OfflineAudioContext(1, SR * 2, SR);
      const g = A.buildEngineGraph(c, prof);
      const e = { state: 'RUNNING', rpm, t: 0, profile: prof, starts: 0, stops: 0 };
      const prm = A.engineSoundParams(e, thr, cabin, 0.6);
      A.applyEngineParams(g, prm, 0, 0, 0.01);
      const buf = await c.startRendering();
      const d = buf.getChannelData(0).subarray(SR, SR * 2); // 뒤 1초(정착 후)
      let peak = 0, sq = 0, bad = 0;
      for (const v of d) { if (!Number.isFinite(v)) bad++; peak = Math.max(peak, Math.abs(v)); sq += v * v; }
      /* Hann 창: 강한 저음 성분이 다른 주파수로 새는 것(누설)을 막는다 */ const mag = (hz) => { let re = 0, im = 0; const N = d.length; for (let i = 0; i < N; i++) { const a = 2 * Math.PI * hz * i / SR; const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); re += w * d[i] * Math.cos(a); im -= w * d[i] * Math.sin(a); } return 2 * Math.hypot(re, im) / N; };
      const half = (prm.f0 * 2) / prof.cylinders; /* 사이클 주파수의 배수(반차수 포함)에서 대역 에너지를 잰다 */ const band = (lo, hi) => { let s = 0; const st = Math.max(half, (hi - lo) / 60); for (let f = Math.ceil(lo / half) * half; f < hi; f += Math.round(st / half) * half) s += mag(f) ** 2; return Math.sqrt(s); };
      return { f0: prm.f0, peak, rms: Math.sqrt(sq / d.length), bad, atF0: mag(prm.f0), off: Math.max(mag(prm.f0 * 1.31 + 3), mag(prm.f0 * 0.77 - 3)), low: band(30, 300), high: band(1200, 4000) };
    };
    const out = {};
    for (const id of ['compact', 'sedan', 'suv', 'coupe']) {
      const prof = E.ENGINE_PROFILES[id];
      out[id] = { idle: await render(prof, prof.idle, 0, false), mid: await render(prof, 3000, 0.2, false), load: await render(prof, 3000, 1, false), cabin: await render(prof, 3000, 1, true), red: await render(prof, prof.redline, 1, false) };
    }
    return out;
  });
  let fail = 0;
  const ck = (name, ok, info) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, info ?? ''); };
  for (const [id, r] of Object.entries(res)) {
    for (const [k, v] of Object.entries(r)) {
      ck(`${id}/${k}: 소리가 나고(rms>0.01) 클리핑 없음(peak<1) NaN 없음`, v.rms > 0.01 && v.peak < 1 && v.bad === 0, `rms=${v.rms.toFixed(3)} peak=${v.peak.toFixed(3)}`);
      ck(`${id}/${k}: 점화 주파수(${v.f0.toFixed(0)}Hz) 성분이 주변 주파수의 3배 이상`, v.atF0 > 3 * v.off, `f0=${v.atF0.toExponential(2)} off=${v.off.toExponential(2)}`);
    }
    ck(`${id}: 실내가 실외보다 조용하고 고역이 적다`, r.cabin.rms < r.load.rms && r.cabin.high / r.cabin.low < r.load.high / r.load.low, `rms ${r.cabin.rms.toFixed(3)}<${r.load.rms.toFixed(3)} 고역비 ${(r.cabin.high / r.cabin.low).toFixed(4)} < ${(r.load.high / r.load.low).toFixed(4)}`);
    ck(`${id}: 고부하에서 더 크고 고역 비율이 늘어난다`, r.load.rms > r.mid.rms && r.load.high / r.load.low > r.mid.high / r.mid.low, `rms ${r.mid.rms.toFixed(3)}→${r.load.rms.toFixed(3)} 고역비 ${(r.mid.high / r.mid.low).toFixed(4)}→${(r.load.high / r.load.low).toFixed(4)}`);
    ck(`${id}: 공회전은 중간 회전수보다 조용하다`, r.idle.rms < r.load.rms, `${r.idle.rms.toFixed(3)}`);
  }
  await b.close();
  srv.kill();
  console.log(fail ? `FAILED ${fail}` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
