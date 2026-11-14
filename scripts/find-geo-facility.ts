/**
 * 실제 지도(geo) 맵에 기계식 시설을 놓을 자리 탐색 (v0.6.0): npx tsx scripts/find-geo-facility.ts [mapId=goejeong]
 * 조건: 시설 풋프린트(진입로 포함)가 실제(OSM) 건물·도로·주차장 면과 겹치지 않음, 진입로 끝(로컬 x=-19)이 도로 가장자리에서 0.5~6m,
 * 진입 방향이 그 도로를 등지고 시설을 향함. 절차 생성 건물(gen)과 겹치는 개수가 적은 곳을 먼저 보여 준다.
 */
import { obbOverlap } from '../src/core/geometry';
import { BASE_MAPS } from '../src/maps';
import { FACILITY_FOOTPRINT, footprintObb } from '../src/maps/mechKit';
import { frameOf, toWorldXZ } from '../src/mech/facility';
import { distToPolyline, pointInPoly, type Pt } from '../src/world/footprint';

const id = process.argv[2] ?? 'goejeong';
const m = BASE_MAPS.find((q) => q.id === id)!;
const geo = m.geo!;
const genIds = new Set(geo.buildings.filter((b) => b.gen).map((b) => b.id));
const boxes = m.obstacles.filter((o) => o.tag === 'building').map((o) => ({ o, gen: genIds.has(o.id.replace(/^bld-/, '').replace(/-\d+$/, '')), obb: { x: o.x, z: o.z, rot: o.rot ?? 0, hw: (o.w ?? 1) / 2, hl: (o.d ?? 1) / 2 } }));
const out: { x: number; z: number; rot: number; gen: number; road: string; d: number; c: number }[] = [];
const B = m.bounds;
for (let x = B.minX + 30; x <= B.maxX - 30; x += 4)
  for (let z = B.minZ + 30; z <= B.maxZ - 30; z += 4)
    for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const cfg = { x, z, rotationY: rot };
      const fp = footprintObb(cfg, FACILITY_FOOTPRINT, 0.6);
      if (boxes.some((b) => !b.gen && obbOverlap(fp, b.obb))) continue;
      // 도로/면과 겹치지 않음: 풋프린트 꼭짓점·중심이 도로 폭 안이 아님 + 도로 점이 풋프린트 안이 아님
      const f = frameOf(cfg);
      const corners = [
        [FACILITY_FOOTPRINT.minX, FACILITY_FOOTPRINT.minZ],
        [FACILITY_FOOTPRINT.maxX, FACILITY_FOOTPRINT.minZ],
        [FACILITY_FOOTPRINT.maxX, FACILITY_FOOTPRINT.maxZ],
        [FACILITY_FOOTPRINT.minX, FACILITY_FOOTPRINT.maxZ],
        [-8, 0],
        [-14, 0],
        [0, 0],
      ].map(([lx, lz]) => toWorldXZ(f, lx, lz));
      let bad = false;
      for (const r of geo.roads) {
        for (const p of corners) if (distToPolyline(r.pts as Pt[], p.x, p.z) < r.w / 2 + 0.8) bad = true;
        for (let i = 1; i < r.pts.length && !bad; i++) {
          const [ax, az] = r.pts[i - 1];
          const [bx, bz] = r.pts[i];
          const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 2);
          for (let k = 0; k <= n; k++) if (obbOverlap({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n, rot: 0, hw: r.w / 2, hl: r.w / 2 }, fp)) bad = true;
        }
        if (bad) break;
      }
      if (bad) continue;
      if (geo.areas.some((a) => corners.some((p) => pointInPoly(a.pts as Pt[], p.x, p.z)))) continue;
      // 진입로 끝(-19.5)이 도로 가장자리 0.5~6m
      const e = toWorldXZ(f, FACILITY_FOOTPRINT.minX - 0.5, 0);
      let best = { d: Infinity, name: '' };
      for (const r of geo.roads) {
        const d = distToPolyline(r.pts as Pt[], e.x, e.z) - r.w / 2;
        if (d < best.d) best = { d, name: `${r.name ?? r.id}(${r.hw})` };
      }
      if (best.d < 0.5 || best.d > 6) continue;
      const gen = boxes.filter((b) => b.gen && obbOverlap(fp, b.obb)).length;
      out.push({ x, z, rot, gen, road: best.name, d: +best.d.toFixed(1), c: Math.round(Math.hypot(x, z)) });
    }
out.sort((a, b) => a.gen - b.gen || a.c - b.c);
console.log(`후보 ${out.length}`);
for (const q of out.slice(0, 15)) console.log(JSON.stringify(q));
