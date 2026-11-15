/**
 * v0.6.2 사하구 OSM 원본 내려받기 (1회성, 결과는 data-raw/saha/ — 저장소에 넣지 않음).
 *   npx tsx scripts/saha/fetch-osm.ts
 * - 경계: 사하구 관계(4055199, 바다 포함 372km²)의 하위 법정동 8개(육지 41.5km²)를 이미 받아 둔 dong-*.osm 에서 읽는다.
 * - 데이터: OSM 편집 API /map 을 격자(0.02°)로 나눠 한 번씩 요청(요청 간 2초). 노드 한도(50000) 초과 응답(400)이면 4분할 재시도.
 *   육지 링 경계상자와 겹치지 않는 격자(바다)는 건너뛴다. 이미 받은 파일은 다시 받지 않는다(중간 결과 보존).
 * - Geofabrik PBF 는 이 환경에서 접근 불가(프록시 403, 허용 요청은 사용자가 거절) → API 를 최소 횟수로 사용.
 * 출처: © OpenStreetMap contributors, ODbL 1.0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = 'data-raw/saha';
const UA = 'parksim-data-prep/0.6.2 (one-time extract)';
type BB = [number, number, number, number]; // 서,남,동,북

function ringBoxes(): BB[] {
  const out: BB[] = [];
  for (const f of fs.readdirSync(DIR).filter((n) => n.startsWith('dong-'))) {
    const xml = fs.readFileSync(path.join(DIR, f), 'utf8');
    const lat = [...xml.matchAll(/lat="([\d.]+)"/g)].map((m) => +m[1]);
    const lon = [...xml.matchAll(/lon="([\d.]+)"/g)].map((m) => +m[1]);
    out.push([Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)]);
  }
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hit = (a: BB, b: BB): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
let calls = 0;
async function get(bb: BB, depth = 0): Promise<void> {
  const name = path.join(DIR, `map_${bb.map((v) => v.toFixed(4)).join('_')}.osm`);
  if (fs.existsSync(name)) return;
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bb.map((v) => v.toFixed(5)).join(',')}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    calls++;
    // Node fetch 는 환경 프록시를 쓰지 않아 curl 로 받는다
    const r = spawnSync('curl', ['-sS', '-m', '300', '-A', UA, '-o', name + '.part', '-w', '%{http_code}', url], { encoding: 'utf8' });
    const status = Number(r.stdout.trim());
    await sleep(2000);
    if (status === 200) {
      fs.renameSync(name + '.part', name);
      console.log('ok', name, (fs.statSync(name).size / 1e6).toFixed(1) + 'MB');
      return;
    }
    const body = fs.existsSync(name + '.part') ? fs.readFileSync(name + '.part', 'utf8').slice(0, 200) : r.stderr;
    if (fs.existsSync(name + '.part')) fs.unlinkSync(name + '.part');
    if (status === 400 && depth < 4) {
      console.log('split', bb.join(','), body);
      const mx = (bb[0] + bb[2]) / 2;
      const my = (bb[1] + bb[3]) / 2;
      for (const q of [[bb[0], bb[1], mx, my], [mx, bb[1], bb[2], my], [bb[0], my, mx, bb[3]], [mx, my, bb[2], bb[3]]] as BB[]) await get(q, depth + 1);
      return;
    }
    console.log('retry', status, bb.join(','), body);
    await sleep(5000 * (attempt + 1));
  }
  throw new Error('실패: ' + bb.join(','));
}
(async () => {
  const boxes = ringBoxes();
  const W = 128.915, S = 34.97, E = 129.015, N = 35.13, STEP = 0.02;
  for (let y = S; y < N - 1e-9; y += STEP)
    for (let x = W; x < E - 1e-9; x += STEP) {
      const bb: BB = [x, y, Math.min(E, x + STEP), Math.min(N, y + STEP)];
      if (!boxes.some((b) => hit(b, bb))) continue;
      await get(bb);
    }
  console.log('API 요청 수', calls);
})();
