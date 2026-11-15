/**
 * 실제 표면에 붙는 PDC 경고 (v0.6.1, 순수 로직). 이전 buildCameraTiles 는 경고 판을 **항상 차량 가로축 방향**으로,
 * 0.3m 칸마다 그 칸의 가장 가까운 히트 거리에 세웠다 → 비스듬한 벽/주차 차량/기둥에서 판이 표면과 어긋나 공중에 뜨고,
 * 같은 물체가 칸마다 다른 깊이로 계단처럼 겹쳤다(사용자 스크린샷 S1~S5).
 *
 * 여기서는 **센서가 실제로 맞춘 충돌체**의 기하로 판을 만든다.
 *  - 상자(OBB): 히트점이 놓인 면(±x/±z)을 찾아, 그 면 위에서 히트점이 덮는 구간만(+여유) 면을 따라 판을 세운다 → 회전한 벽/차량 옆면과 각도가 일치
 *  - 원기둥: 히트점의 각도 범위를 원호로 따라가는 짧은 판 여러 개
 *  - 충돌체 기하를 알 수 없으면(데이터 없음): 히트점들에 근거한 작은 판(최대 0.6m)만 — 큰 판을 지어내지 않는다
 *  - 판 하나 = (충돌체, 면). 서로 다른 물체를 하나로 합치지 않는다
 *  - 반환 형식은 ObstacleZone: corners[3]→corners[2] 가 장애물 표면 위의 밑변(렌더러가 여기서 수직으로 panelHeight 만큼 세운다),
 *    corners[0]/[1] 은 차량 쪽으로 SURF_BAND 만큼 나온 바닥 띠.
 * 색 단계는 그 면 히트점들의 차체 외곽까지 최소 간격으로 정한다(숫자는 내보내지 않는다).
 */
import type { Collider, Obb } from '../core/geometry';
import { localToWorld, worldToLocal } from '../core/math';
import type { SensorSnapshot } from '../sensors/sensorSystem';
import { proximityLevel, type ProximityLevel } from '../sensors/sensorSystem';
import type { VehicleSpec } from '../vehicle/spec';
import type { ObstacleZone } from './overlay';
import { TILE_CORNER, TILE_LAT } from './overlay';
import { pointToObbGap } from './risk';

/** 표면에서 바깥쪽으로 띄우는 거리(겹침/깊이 충돌 방지) */
export const SURF_EPS = 0.025;
/** 히트 구간 양끝 여유 */
export const SURF_PAD = 0.12;
/** 바닥 띠 깊이(표면 → 차량 쪽) */
export const SURF_BAND = 0.18;
/** 판 높이: 장애물 윗면까지, 최대 */
export const SURF_H_MAX = 0.38;
export const SURF_H_MIN = 0.12;
/** 원기둥 원호를 나누는 최대 호 길이 */
export const ARC_SEG = 0.25;
/** 기하를 모르는 물체에 허용하는 최대 판 폭 */
export const FALLBACK_MAX_W = 0.6;

type P = { x: number; z: number };
interface HitInfo {
  x: number;
  z: number;
  gap: number;
}

export interface SurfaceWarnOptions {
  dir: 'front' | 'rear';
  range: number;
  critical: number;
  /** 충돌체 id → 현재 기하(밀려난 물체/벽 조각 포함). 없으면 undefined */
  colliderOf: (id: string) => Collider | undefined;
  /** 지면 높이(판 높이 계산용) */
  baseY?: number;
}

const zoneOf = (id: string, group: 'front' | 'rear', level: Exclude<ProximityLevel, 'none'>, a: P, b: P, toward: P, hits: number, colliderId: string, h: number): ObstacleZone => {
  // a→b 가 표면 위 밑변. 바닥 띠는 표면에서 차량 쪽(toward 단위 벡터)으로
  const ia = { x: a.x + toward.x * SURF_BAND, z: a.z + toward.z * SURF_BAND };
  const ib = { x: b.x + toward.x * SURF_BAND, z: b.z + toward.z * SURF_BAND };
  return { sensorId: id, group, level, corners: [ia, ib, b, a], hits, colliderIds: [colliderId], panelHeight: h };
};

export function buildSurfaceWarnings(snap: SensorSnapshot | null, spec: VehicleSpec, body: Obb, o: SurfaceWarnOptions): ObstacleZone[] {
  if (!snap) return [];
  const half = body.hw + TILE_LAT;
  const byCol = new Map<string, HitInfo[]>();
  spec.sensors.forEach((_m, i) => {
    const r = snap.readings[i];
    if (!r) return;
    for (const h of r.hits) {
      const l = worldToLocal(body.x, body.z, body.rot, h.x, h.z);
      const beyond = o.dir === 'front' ? l.z - body.hl : -l.z - body.hl;
      if (beyond < -TILE_CORNER || Math.abs(l.x) > half) continue;
      const gap = pointToObbGap(h.x, h.z, body);
      if (gap > o.range) continue;
      let list = byCol.get(h.colliderId);
      if (!list) byCol.set(h.colliderId, (list = []));
      list.push({ x: h.x, z: h.z, gap });
    }
  });
  const out: ObstacleZone[] = [];
  const baseY = o.baseY ?? 0;
  const heightOf = (c: Collider | undefined): number => (c ? Math.max(SURF_H_MIN, Math.min(SURF_H_MAX, c.y0 + c.h - baseY)) : SURF_H_MAX);
  for (const [cid, hs] of byCol) {
    const c = o.colliderOf(cid);
    const h = heightOf(c);
    if (c && c.kind === 'box') {
      // 면별로 나눈다: 로컬 좌표에서 어느 면에 가까운가
      const faces = new Map<string, { hits: HitInfo[]; t: number[] }>();
      const hx = c.w / 2;
      const hz = c.d / 2;
      for (const q of hs) {
        const l = worldToLocal(c.x, c.z, c.rot, q.x, q.z);
        const fx = Math.abs(Math.abs(l.x) - hx);
        const fz = Math.abs(Math.abs(l.z) - hz);
        const key = fx <= fz ? (l.x >= 0 ? '+x' : '-x') : l.z >= 0 ? '+z' : '-z';
        let f = faces.get(key);
        if (!f) faces.set(key, (f = { hits: [], t: [] }));
        f.hits.push(q);
        f.t.push(key[1] === 'x' ? l.z : l.x);
      }
      for (const [key, f] of faces) {
        const ext = key[1] === 'x' ? hz : hx;
        const t0 = Math.max(-ext, Math.min(...f.t) - SURF_PAD);
        const t1 = Math.min(ext, Math.max(...f.t) + SURF_PAD);
        const s = key[0] === '+' ? 1 : -1;
        const off = (key[1] === 'x' ? hx : hz) + SURF_EPS;
        const la = key[1] === 'x' ? { x: s * off, z: t0 } : { x: t0, z: s * off };
        const lb = key[1] === 'x' ? { x: s * off, z: t1 } : { x: t1, z: s * off };
        const a = localToWorld(c.x, c.z, c.rot, la.x, la.z);
        const b = localToWorld(c.x, c.z, c.rot, lb.x, lb.z);
        // 바깥 법선(면 → 바깥) = 로컬 축 방향 s
        const nl = key[1] === 'x' ? { x: s, z: 0 } : { x: 0, z: s };
        const n0 = localToWorld(0, 0, c.rot, nl.x, nl.z);
        const gap = Math.min(...f.hits.map((q) => q.gap));
        const level = proximityLevel(gap, o.range, o.critical);
        if (level === 'none') continue;
        out.push(zoneOf(`surf-${cid}-${key}`, o.dir, level, a, b, n0, f.hits.length, cid, h));
      }
    } else if (c && c.kind === 'cyl') {
      // 원호: 중심에서 본 히트 각도 범위(차량 쪽을 기준으로 펼쳐 랩어라운드 방지)
      const ref = Math.atan2(body.z - c.z, body.x - c.x);
      const angs = hs.map((q) => {
        let a = Math.atan2(q.z - c.z, q.x - c.x) - ref;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        return a;
      });
      const padA = SURF_PAD / Math.max(0.05, c.r);
      const a0 = Math.max(-Math.PI / 2, Math.min(...angs) - padA);
      const a1 = Math.min(Math.PI / 2, Math.max(...angs) + padA);
      const rr = c.r + SURF_EPS;
      // 분할 수는 현(chord) 길이 기준 — 작은 기둥(반지름 0.15m)이 원호 길이 때문에 3조각 이상으로 쪼개지지 않게
      const n = Math.max(1, Math.ceil((2 * rr * Math.sin((a1 - a0) / 2)) / ARC_SEG));
      const gap = Math.min(...hs.map((q) => q.gap));
      const level = proximityLevel(gap, o.range, o.critical);
      if (level === 'none') continue;
      for (let k = 0; k < n; k++) {
        const u0 = ref + a0 + ((a1 - a0) * k) / n;
        const u1 = ref + a0 + ((a1 - a0) * (k + 1)) / n;
        const a = { x: c.x + Math.cos(u0) * rr, z: c.z + Math.sin(u0) * rr };
        const b = { x: c.x + Math.cos(u1) * rr, z: c.z + Math.sin(u1) * rr };
        const um = (u0 + u1) / 2;
        out.push(zoneOf(`surf-${cid}-arc${k}`, o.dir, level, a, b, { x: Math.cos(um), z: Math.sin(um) }, hs.length, cid, h));
      }
    } else {
      // 기하 미상: 히트점들만으로 작은 판 — 히트들의 주축 방향, 폭 제한, 차량을 향하는 법선
      const cx = hs.reduce((s, q) => s + q.x, 0) / hs.length;
      const cz = hs.reduce((s, q) => s + q.z, 0) / hs.length;
      let tx = 1;
      let tz = 0;
      if (hs.length >= 2) {
        let far = hs[0];
        for (const q of hs) if (Math.hypot(q.x - hs[0].x, q.z - hs[0].z) > Math.hypot(far.x - hs[0].x, far.z - hs[0].z)) far = q;
        const L = Math.hypot(far.x - hs[0].x, far.z - hs[0].z);
        if (L > 1e-3) {
          tx = (far.x - hs[0].x) / L;
          tz = (far.z - hs[0].z) / L;
        }
      }
      let toward = { x: body.x - cx, z: body.z - cz };
      const tl = Math.hypot(toward.x, toward.z) || 1;
      toward = { x: toward.x / tl, z: toward.z / tl };
      if (hs.length < 2) {
        tx = -toward.z;
        tz = toward.x;
      }
      const ts = hs.map((q) => (q.x - cx) * tx + (q.z - cz) * tz);
      const w = Math.min(FALLBACK_MAX_W, Math.max(...ts) - Math.min(...ts) + 2 * SURF_PAD);
      const a = { x: cx - (tx * w) / 2, z: cz - (tz * w) / 2 };
      const b = { x: cx + (tx * w) / 2, z: cz + (tz * w) / 2 };
      const gap = Math.min(...hs.map((q) => q.gap));
      const level = proximityLevel(gap, o.range, o.critical);
      if (level === 'none') continue;
      out.push(zoneOf(`surf-${cid}-pts`, o.dir, level, a, b, toward, hs.length, cid, Math.min(h, 0.3)));
    }
  }
  return out;
}
