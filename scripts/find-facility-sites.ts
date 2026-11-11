/**
 * 기계식 주차 시설을 각 맵에 놓을 수 있는 빈 자리를 찾는 개발 도구 (v0.5.3).
 *   npx tsx scripts/find-facility-sites.ts
 * 시설 로컬 직사각형(진입로 포함 x∈[-19,3], z∈[-8,8])이 (1) 맵 경계 안, (2) 어떤 충돌체/주차칸/미션 스폰과도 겹치지 않고,
 * (3) 다층 맵에서는 지상(y=0) 면만 있고 위층 데크가 덮지 않는 곳을 후보로 낸다. 결과는 maps/facilitySites.ts 에 손으로 옮긴다.
 */
import { MAPS, mapColliders } from '../src/maps';
import { obbOverlap, type Collider } from '../src/core/geometry';
import { surfaceHeight } from '../src/maps/terrain';
import { toWorldXZ } from '../src/mech/facility';

const FOOT = process.env.STRUCT_ONLY ? { minX: -8, maxX: 2.6, minZ: -7.8, maxZ: 7.8 } : { minX: -19, maxX: 3, minZ: -8, maxZ: 8 };
const cx = (FOOT.minX + FOOT.maxX) / 2;
const cz = (FOOT.minZ + FOOT.maxZ) / 2;
const W = FOOT.maxX - FOOT.minX;
const D = FOOT.maxZ - FOOT.minZ;
const MARGIN = 0.6;
const ROUTE_M = Number(process.env.ROUTE_M ?? 3);

for (const map of MAPS) {
  if (map.id === 'mechpark' || map.id === 'megapark') continue;
  const cols = mapColliders(map);
  const solid = cols.filter((c) => c.tag !== 'curb');
  const spawns = [map.spawn, ...map.missions.map((m) => m.spawn).filter(Boolean)] as { x: number; z: number }[];
  const sites: { x: number; z: number; yaw: number; score: number }[] = [];
  const b = map.bounds;
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (let x = Math.ceil(b.minX); x <= b.maxX; x += 1) {
      for (let z = Math.ceil(b.minZ); z <= b.maxZ; z += 1) {
        const f = { x, z, yaw };
        // 풋프린트 4모서리가 맵 경계 안
        const corners = [[FOOT.minX, FOOT.minZ], [FOOT.minX, FOOT.maxZ], [FOOT.maxX, FOOT.minZ], [FOOT.maxX, FOOT.maxZ]].map(([lx, lz]) => toWorldXZ(f, lx, lz));
        if (corners.some((c) => c.x < b.minX + 1 || c.x > b.maxX - 1 || c.z < b.minZ + 1 || c.z > b.maxZ - 1)) continue;
        const c0 = toWorldXZ(f, cx, cz);
        const obb = { x: c0.x, z: c0.z, hw: (D + MARGIN * 2) / 2, hl: (W + MARGIN * 2) / 2, rot: Math.PI / 2 + yaw };
        let bad = false;
        for (const c of solid) {
          if (c.kind === 'box') {
            if (obbOverlap(obb, { x: c.x, z: c.z, hw: c.w / 2, hl: c.d / 2, rot: c.rot })) { bad = true; break; }
          } else if (Math.hypot(c.x - c0.x, c.z - c0.z) < Math.max(W, D)) {
            // 원통: 풋프린트 로컬 좌표로 변환해 사각형 안인지
            const l = { x: (c.x - f.x) * Math.cos(yaw) - (c.z - f.z) * Math.sin(yaw), z: (c.x - f.x) * Math.sin(yaw) + (c.z - f.z) * Math.cos(yaw) };
            if (l.x > FOOT.minX - MARGIN - c.r && l.x < FOOT.maxX + MARGIN + c.r && l.z > FOOT.minZ - MARGIN - c.r && l.z < FOOT.maxZ + MARGIN + c.r) { bad = true; break; }
          }
        }
        if (bad) continue;
        if (map.slots.some((s) => Math.hypot(s.x - c0.x, s.z - c0.z) < Math.max(W, D) / 2 + 3)) {
          // 주차칸이 풋프린트 안/근처
          const sl = map.slots.some((s) => { const l = { x: (s.x - f.x) * Math.cos(yaw) - (s.z - f.z) * Math.sin(yaw), z: (s.x - f.x) * Math.sin(yaw) + (s.z - f.z) * Math.cos(yaw) }; return l.x > FOOT.minX - 1 && l.x < FOOT.maxX + 1 && l.z > FOOT.minZ - 1 && l.z < FOOT.maxZ + 1; });
          if (sl) continue;
        }
        if (spawns.some((s) => { const l = { x: (s.x - f.x) * Math.cos(yaw) - (s.z - f.z) * Math.sin(yaw), z: (s.x - f.x) * Math.sin(yaw) + (s.z - f.z) * Math.cos(yaw) }; return l.x > FOOT.minX - 2 && l.x < FOOT.maxX + 2 && l.z > FOOT.minZ - 2 && l.z < FOOT.maxZ + 2; })) continue;
        // 미션 동선(스폰 → 목표 주차칸 직선)을 3m 이상 비켜야 한다 (기존 미션이 막히지 않게)
        let blocksRoute = false;
        for (const m of map.missions) {
          const sp = m.spawn ?? map.spawn;
          const tg = map.slots.find((q) => q.id === m.slotId);
          if (!tg) continue;
          for (let t = 0; t <= 1.0001 && !blocksRoute; t += 0.04) {
            const px = sp.x + (tg.x - sp.x) * t;
            const pz = sp.z + (tg.z - sp.z) * t;
            const l = { x: (px - f.x) * Math.cos(yaw) - (pz - f.z) * Math.sin(yaw), z: (px - f.x) * Math.sin(yaw) + (pz - f.z) * Math.cos(yaw) };
            if (l.x > FOOT.minX - ROUTE_M && l.x < FOOT.maxX + ROUTE_M && l.z > FOOT.minZ - ROUTE_M && l.z < FOOT.maxZ + ROUTE_M) blocksRoute = true;
          }
        }
        if (blocksRoute) continue;
        // 다층: 풋프린트 표본점이 모두 지상면이고 위층이 덮지 않는다
        if (map.terrain) {
          let ok = true;
          for (let lx = FOOT.minX; lx <= FOOT.maxX && ok; lx += 1.5) for (let lz = FOOT.minZ; lz <= FOOT.maxZ && ok; lz += 1.5) {
            const w = toWorldXZ(f, lx, lz);
            const hs = map.terrain.surfaces.map((s) => surfaceHeight(s, w.x, w.z)).filter((h): h is number => h !== null);
            if (!hs.some((h) => Math.abs(h) < 0.05) || hs.some((h) => h > 0.3)) ok = false;
          }
          if (!ok) continue;
        }
        // 점수: 주차칸·스폰에서의 최소 거리 (멀수록 좋음) — 미션 동선을 가리지 않게
        const pts = [...map.slots.map((s) => ({ x: s.x, z: s.z })), ...spawns];
        const score = Math.min(...pts.map((p) => Math.hypot(p.x - c0.x, p.z - c0.z)));
        sites.push({ x, z, yaw, score });
      }
    }
  }
  sites.sort((a, b2) => b2.score - a.score);
  if (process.env.LIST === map.id) for (const q of sites.filter((_, i) => i % 6 === 0)) console.log('  ', q.x, q.z, (q.yaw / Math.PI * 180).toFixed(0), q.score.toFixed(1));
  console.log(`${map.id}: 후보 ${sites.length}개`, sites.slice(0, 4).map((s) => `(${s.x},${s.z},yaw ${(s.yaw / Math.PI * 180).toFixed(0)}° s=${s.score.toFixed(1)})`).join(' '));
}
void ({} as Collider);
