// 기계식 부속 구역(maps/mechAnnex.ts)을 붙일 수 있는 벽 위치를 찾는다. 사용: npx tsx scripts/find-annex-sites.ts [mapId...]
// 조건: 문 자리에 벽 외 물체가 없음, 접근 자세~승강장 문까지 직선 통로가 비어 있음(지형 맵은 지면 연속), 맵 시작 위치에서 접근 지점까지 기구학 경로가 있음.
import { BASE_MAPS } from '../src/maps';
import { annexGeom, withMechAnnex, type AnnexSide } from '../src/maps/mechAnnex';
import { groundAt } from '../src/maps/terrain';
import { mapColliders } from '../src/maps/types';
import { findVehicleCollision } from '../src/core/geometry';
import { planPath } from '../src/sim/planner';
import { getVehicle } from '../src/vehicle/spec';

const only = process.argv.slice(2);
const spec = getVehicle('suv-x6');
for (const base of BASE_MAPS) {
  if (only.length ? !only.includes(base.id) : (base.mechFacilities?.length ?? 0) > 0) continue;
  const found: string[] = [];
  for (const side of ['west', 'east', 'south', 'north'] as AnnexSide[]) {
    const horizontal = side === 'east' || side === 'west';
    const [lo, hi] = horizontal ? [base.bounds.minZ, base.bounds.maxZ] : [base.bounds.minX, base.bounds.maxX];
    const ok: number[] = [];
    for (let at = Math.ceil(lo + 3.5); at <= hi - 3.5; at += 1) {
      const o = { id: 'probe', name: 'probe', side, at };
      let m;
      try {
        m = withMechAnnex(base, o);
      } catch {
        continue;
      }
      const g = annexGeom(base.bounds, o);
      const cols = mapColliders(m);
      let clear = true;
      // 접근 자세에서 승강장 문 앞까지 1m 간격 직선
      for (let s = -4; s <= 24 && clear; s += 0.5) {
        const x = g.approach.x + g.out.x * s;
        const z = g.approach.z + g.out.z * s;
        if (findVehicleCollision({ x, z, rot: g.approach.heading, hw: spec.width / 2 + 0.08, hl: spec.length / 2 }, cols, 0, spec.height)) clear = false;
        if (m.terrain && groundAt(m.terrain, x, z, 0) === null) clear = false;
      }
      if (!clear) continue;
      const p = planPath(m, spec, { x: m.spawn.x, z: m.spawn.z, heading: m.spawn.heading }, { x: g.approach.x - g.out.x * 2, z: g.approach.z - g.out.z * 2 }, { maxExpand: 60000 });
      // 시작 위치가 좁은 곳(콘 사이 등)이라 탐색 시작 자세가 막히면 반대로(접근 지점 → 시작 위치) 찾는다. 기구학 경로는 뒤집어도 성립한다
      const q = p.found ? p : planPath(m, spec, { x: g.approach.x - g.out.x * 2, z: g.approach.z - g.out.z * 2, heading: g.approach.heading + Math.PI }, { x: m.spawn.x, z: m.spawn.z }, { maxExpand: 60000, goalRadius: 3 });
      if (q.found) ok.push(at);
    }
    if (ok.length) found.push(`${side}: ${ok.join(',')}`);
  }
  console.log(`${base.id}: ${found.length ? found.join(' | ') : '없음'}`);
}
