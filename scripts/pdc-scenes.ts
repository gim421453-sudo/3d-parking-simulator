/**
 * v0.6.3 PDC 자동 카메라 방향 회귀 하네스 (헤드리스, 실제 센서 레이캐스트 + 실제 시점 정책).
 * 같은 장면을 여러 차량 방향(heading)에서 재현해, 자동으로 고른 카메라가 실제 위험 방향과 맞는지·
 * 그 카메라 화면 안에 위험 물체가 실제로 들어오는지 판정한다.
 *
 *   npx tsx scripts/pdc-scenes.ts                 # 현재 코드
 *   ROOT=<v0.6.0 작업트리> VER=v060 npx tsx scripts/pdc-scenes.ts
 *   ROOT=<v0.6.1 작업트리> VER=v061 npx tsx scripts/pdc-scenes.ts
 *   JSON=out.json …                               # 결과 저장
 *
 * 연결 코드는 각 버전 Game.ts 와 같다(v060: 움직여야 게이트 열림·순위 없음, v061: 순위 1위 그대로, cur: `pdc/autoView.ts` 의 viewGateOpens/viewTopOf).
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SCENES } from '../tests/fixtures/pdcScenes';
import { runPdcScene, type PdcMods } from '../tests/fixtures/runPdcScene';

const ROOT = path.resolve(process.env.ROOT ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const VER = (process.env.VER ?? 'cur') as 'v060' | 'v061' | 'cur';
const imp = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(ROOT, 'src', rel)).href)) as T;

async function main(): Promise<void> {
  const math = await imp<typeof import('../src/core/math')>('core/math.ts');
  const spec0 = await imp<typeof import('../src/vehicle/spec')>('vehicle/spec.ts');
  const phys = await imp<typeof import('../src/vehicle/physics')>('vehicle/physics.ts');
  const sens = await imp<typeof import('../src/sensors/sensorSystem')>('sensors/sensorSystem.ts');
  const riskM = await imp<typeof import('../src/pdc/risk')>('pdc/risk.ts');
  const gateM = await imp<typeof import('../src/pdc/viewGate')>('pdc/viewGate.ts');
  const polM = await imp<typeof import('../src/pdc/viewPolicy')>('pdc/viewPolicy.ts');
  const frM = await imp<typeof import('../src/pdc/framing')>('pdc/framing.ts');
  const guideM = await imp<typeof import('../src/pdc/guidelines')>('pdc/guidelines.ts');
  const camM = await imp<typeof import('../src/game/cameras')>('game/cameras.ts');
  let rankM: typeof import('../src/pdc/riskRank') | null = null;
  if (VER !== 'v060') rankM = await imp<typeof import('../src/pdc/riskRank')>('pdc/riskRank.ts');
  let autoM: typeof import('../src/pdc/autoView') | null = null;
  if (VER === 'cur') autoM = await imp<typeof import('../src/pdc/autoView')>('pdc/autoView.ts');

  const spec = spec0.VEHICLES[1];
  const mods: PdcMods = { math, phys, sens, riskM, gateM, polM, frM, guideM, camM, rankM, autoM };
  const HEADINGS = [0, 1.1, 2.7, -2.0];
  const results: unknown[] = [];
  let bad = 0;
  let total = 0;

  for (const sc of SCENES) {
    for (const H of HEADINGS) {
      total++;
      const r = runPdcScene(mods, VER, spec, sc, H);
      results.push(r);
      const { ok, finalView, vis, closest, wrong, views } = { ...r, vis: r.visible };
      if (!ok) bad++;
      if (!ok || process.env.V) console.log(`${ok ? 'OK  ' : 'FAIL'} ${sc.id.padEnd(14)} H=${H.toFixed(1).padStart(4)} final=${finalView.padEnd(8)} vis=${vis ? 'Y' : 'N'}@${closest.view || '-'} wrong=[${wrong.join(',')}] seq=${views.map((q) => `${q.t}:${q.view}${q.auto ? '*' : ''}`).join(' > ')} ${JSON.stringify(views.at(-1)?.top ?? null)} ${views.at(-1)?.reason ?? ''}`);
    }
  }
  console.log(`[${VER}] ${total - bad}/${total} 통과`);
  if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify({ ver: VER, total, bad, results }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
