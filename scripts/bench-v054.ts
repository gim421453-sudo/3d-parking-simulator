/** v0.5.4 벤치: megapark 에서 충돌/지형 조회의 전수 검사 vs 공간 인덱스, 도로 그래프 생성/경로 탐색 시간.  npx tsx scripts/bench-v054.ts */
import { findVehicleCollision, type Collider } from '../src/core/geometry';
import { SpatialIndex } from '../src/core/spatial';
import { getMap, mapColliders } from '../src/maps';
import { groundAt, surfaceHeight } from '../src/maps/terrain';
import { findLevelRoute, levelGraphFor } from '../src/nav/levelGraph';
import { getVehicle } from '../src/vehicle/spec';

const m = getMap('megapark');
const all = mapColliders(m);
const t = m.terrain!;
const N = 20000;
let seed = 42;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
const pts = Array.from({ length: N }, () => ({ x: m.bounds.minX + rnd() * (m.bounds.maxX - m.bounds.minX), z: m.bounds.minZ + rnd() * (m.bounds.maxZ - m.bounds.minZ), r: rnd() * 6.28 }));
const time = (f: () => void): number => { const t0 = performance.now(); f(); return performance.now() - t0; };
const idx = new SpatialIndex(8);
const build = time(() => idx.rebuild(all));
const near: Collider[] = [];
const brute = time(() => { for (const p of pts) findVehicleCollision({ x: p.x, z: p.z, rot: p.r, hw: 1, hl: 2.47 }, all, 0, 1.7); });
const indexed = time(() => { for (const p of pts) { idx.query(p.x, p.z, 6, near); findVehicleCollision({ x: p.x, z: p.z, rot: p.r, hw: 1, hl: 2.47 }, near, 0, 1.7); } });
const gBrute = time(() => { for (const p of pts) { let best: number | null = null; for (const s of t.surfaces) { const h = surfaceHeight(s, p.x, p.z); if (h !== null && Math.abs(h) <= 0.7 && (best === null || h > best)) best = h; } } });
const gIdx = time(() => { for (const p of pts) groundAt(t, p.x, p.z, 0); });
const spec = getVehicle('sedan');
const gb = time(() => levelGraphFor(m, spec));
const g = levelGraphFor(m, spec);
const slot = m.slots.find((s) => s.id === 'ug:un-5')!;
const route = time(() => { for (let i = 0; i < 20; i++) findLevelRoute(g, { x: -58, z: -150, y: 0 }, { x: slot.x, z: slot.z, y: slot.y ?? 0 }); }) / 20;
console.log(JSON.stringify({ colliders: all.length, terrainSurfaces: t.surfaces.length, indexBuildMs: +build.toFixed(2), collisionUsPerQuery: { brute: +((brute / N) * 1000).toFixed(2), indexed: +((indexed / N) * 1000).toFixed(2), speedup: +(brute / indexed).toFixed(1) }, groundUsPerQuery: { brute: +((gBrute / N) * 1000).toFixed(2), indexed: +((gIdx / N) * 1000).toFixed(2), speedup: +(gBrute / gIdx).toFixed(1) }, graph: { nodes: g.nodes.length, buildMs: +gb.toFixed(0), routeMs: +route.toFixed(1) } }, null, 1));
