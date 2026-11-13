import { angleDiff } from '../core/math';
import type { MapData, MapSlot } from '../maps/types';
import { levelAt } from '../maps/terrain';
import type { VehicleSpec } from '../vehicle/spec';
import { findLevelRoute, levelGraphFor, type LevelGraph } from './levelGraph';
import { buildBestRoadGraph, type RoadGraph } from './roadGraph';
import { distToSeg, findRoute, type Pt, type Route } from './router';

export type ManeuverType = 'straight' | 'left' | 'right' | 'uturn' | 'arrive';
export interface Maneuver {
  type: ManeuverType;
  distM: number; // 다음 기동까지 남은 거리 (내비게이션 안내용 거리 — 주차 센서 거리와 무관)
}
export type NavStatus = 'idle' | 'guiding' | 'arrived' | 'noRoute';

export interface NavState {
  status: NavStatus;
  destination: MapSlot | null;
  route: Route | null;
  remainingM: number;
  next: Maneuver;
  offRoute: boolean;
  rerouteCount: number;
  text: string;
  /** 다층 맵: 현재 층 / 목적지 층 이름, 앞에 있는 경사로 방향(올라감/내려감)과 그 뒤의 층 */
  level?: string;
  destLevel?: string;
  ramp?: { dir: 'up' | 'down'; to: string; distM: number } | null;
}

export const ARRIVE_DIST = 3.2; // 슬롯 중심까지 이 거리 이내면 도착
export const OFF_ROUTE_DIST = 6;
export const TURN_ANGLE = (35 * Math.PI) / 180;

/** 경로 위의 가장 가까운 지점의 (구간 인덱스, 경로 시작부터의 거리, 횡거리) */
export function projectOnRoute(pts: Pt[], p: Pt): { seg: number; along: number; lateral: number } {
  let best = { seg: 0, along: 0, lateral: Infinity };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    // 다층 경로: 차량과 다른 층을 지나는 구간(같은 x,z 의 위/아래층)은 투영 대상에서 뺀다
    if (p.y !== undefined && a.y !== undefined && b.y !== undefined && Math.min(Math.abs(a.y - p.y), Math.abs(b.y - p.y)) > 1.6 && !(p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y))) {
      acc += segLen;
      continue;
    }
    const d = distToSeg(p, a, b);
    if (d < best.lateral) {
      const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / (segLen * segLen)));
      best = { seg: i, along: acc + t * segLen, lateral: d };
    }
    acc += segLen;
  }
  return best;
}

export function routeLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** seg 이후 첫 번째 회전 꼭짓점의 종류와 거기까지의 거리 */
export function nextManeuver(pts: Pt[], seg: number, along: number): Maneuver {
  let acc = 0;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    cum.push(acc);
  }
  for (let i = seg + 1; i < pts.length - 1; i++) {
    const h0 = Math.atan2(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); // heading 규칙: atan2(dx, dz)
    const h1 = Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    const d = angleDiff(h1, h0); // 양수 = 왼쪽
    if (Math.abs(d) >= TURN_ANGLE) {
      return { type: Math.abs(d) > (150 * Math.PI) / 180 ? 'uturn' : d > 0 ? 'left' : 'right', distM: Math.max(0, cum[i] - along) };
    }
  }
  return { type: 'arrive', distM: Math.max(0, acc - along) };
}

const MANEUVER_TEXT: Record<ManeuverType, string> = { straight: '직진', left: '좌회전', right: '우회전', uturn: '유턴', arrive: '목적지 도착' };

export class Navigator {
  private graph: RoadGraph | null = null;
  private map: MapData | null = null;
  private dest: MapSlot | null = null;
  private route: Route | null = null;
  private status: NavStatus = 'idle';
  private offT = 0;
  private cool = 0;
  reroutes = 0;
  private last: NavState = this.make();

  private make(): NavState {
    return { status: this.status, destination: this.dest, route: this.route, remainingM: 0, next: { type: 'straight', distM: 0 }, offRoute: false, rerouteCount: this.reroutes, text: '목적지를 선택하세요' };
  }

  private spec: VehicleSpec | null = null;
  private lgraph: LevelGraph | null = null;
  /** 다층 맵 경로 탐색에 쓸 차량(차폭/차고/회전 반경에 따라 통과 가능한 길이 달라진다). setMap 전에 호출 */
  setVehicle(spec: VehicleSpec): void {
    if (this.spec !== spec) this.lgraph = null;
    this.spec = spec;
  }
  /** 다층(지형) 맵인가 — 3D 도로 그래프(levelGraph)를 쓴다 */
  get multiLevel(): boolean {
    return !!(this.map?.terrain || this.map?.roads?.length);
  }
  get levelGraph(): LevelGraph | null {
    if (!this.multiLevel || !this.map || !this.spec) return null;
    if (!this.lgraph) this.lgraph = levelGraphFor(this.map, this.spec);
    return this.lgraph;
  }

  setMap(map: MapData): void {
    this.map = map;
    this.lgraph = null;
    // 다층 맵(주차타워/통합 맵)은 3D 도로 그래프(levelGraph: 층·경사로·차종 반영)를 쓴다 — 목적지를 정할 때 만든다(지연 생성)
    this.graph = map.terrain || map.roads?.length || map.id === 'mechpark' ? null : buildBestRoadGraph(map);
    this.dest = null;
    this.route = null;
    this.status = 'idle';
    this.reroutes = 0;
  }
  get roadGraph(): RoadGraph | null {
    return this.graph;
  }
  get state(): NavState {
    return this.last;
  }

  setDestination(slot: MapSlot | null, from: Pt): void {
    this.dest = slot;
    this.route = null;
    this.reroutes = 0;
    this.status = slot ? 'guiding' : 'idle';
    this.offT = 0;
    this.cool = 0;
    if (slot) this.plan(from);
    if (slot && !this.graph && !this.multiLevel) this.status = 'noRoute';
    this.last = this.evaluate(from);
  }

  private plan(from: Pt): void {
    if (this.multiLevel && this.map && this.dest) {
      const g = this.levelGraph;
      const r = g ? findLevelRoute(g, { x: from.x, z: from.z, y: from.y ?? 0 }, { x: this.dest.x, z: this.dest.z, y: this.dest.y ?? 0 }) : null;
      this.route = r ? { points: simplify3(r.points, 0.9), length: r.length, dest: r.dest } : null;
      if (!this.route) this.status = 'noRoute';
      else if (this.status === 'noRoute') this.status = 'guiding';
      return;
    }
    if (!this.graph || !this.map || !this.dest) return;
    this.route = findRoute(this.graph, this.map, from, this.dest);
    if (!this.route) this.status = 'noRoute';
    else if (this.status === 'noRoute') this.status = 'guiding';
  }

  private evaluate(p: Pt): NavState {
    const base = this.make();
    if (!this.dest) return base;
    const toDest = Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
    const t = this.map?.terrain;
    const lv = t ? { level: levelAt(t, p.y ?? 0).name, destLevel: levelAt(t, this.dest.y ?? 0).name } : {};
    Object.assign(base, lv);
    const sameLevel = !t || Math.abs((p.y ?? 0) - (this.dest.y ?? 0)) < 1.2;
    if (toDest <= ARRIVE_DIST && sameLevel) {
      this.status = 'arrived';
      return { ...base, status: 'arrived', remainingM: toDest, next: { type: 'arrive', distM: toDest }, text: '목적지에 도착했습니다' };
    }
    if (this.status === 'arrived') this.status = 'guiding'; // 도착 지점을 벗어나면 다시 안내
    if (!this.route) return { ...base, status: this.status, text: this.status === 'noRoute' ? '경로를 찾을 수 없습니다' : '경로 계산 중' };
    const pr = projectOnRoute(this.route.points, p);
    const rem = Math.max(0, routeLength(this.route.points) - pr.along);
    const next = nextManeuver(this.route.points, pr.seg, pr.along);
    const off = pr.lateral > OFF_ROUTE_DIST;
    // 다층: 앞쪽 경로에서 높이가 바뀌기 시작하는 지점(경사로)과 그 뒤에 도착하는 층
    let ramp: NavState['ramp'] = null;
    if (t) {
      const pts = this.route.points;
      const y0 = p.y ?? 0;
      let acc = 0;
      let start = -1;
      for (let i = pr.seg + 1; i < pts.length; i++) {
        const segLen = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        acc += segLen;
        const dy = (pts[i].y ?? 0) - y0;
        if (start < 0 && Math.abs(dy) > 0.25) {
          // 경사가 시작되는 지점: 이 구간 안에서 높이가 바뀌기 시작하는 곳(단순화된 경로는 점이 드물다 → 구간 시작점을 쓴다)
          const dPrev = (pts[i - 1].y ?? 0) - y0;
          start = Math.abs(dPrev) > 0.25 ? acc - segLen : acc - segLen;
        }
        if (start >= 0 && (i === pts.length - 1 || Math.abs((pts[i + 1].y ?? 0) - (pts[i].y ?? 0)) < 0.02) && Math.abs(dy) > 0.8) {
          ramp = { dir: dy > 0 ? 'up' : 'down', to: levelAt(t, pts[i].y ?? 0).name, distM: Math.max(0, start - (pr.along - cumAt(pts, pr.seg))) };
          break;
        }
      }
    }
    const text = off ? '경로를 이탈했습니다 — 재탐색' : ramp && ramp.distM < 40 ? `경사로 ${ramp.dir === 'up' ? '올라가기' : '내려가기'} → ${ramp.to}` : MANEUVER_TEXT[next.type];
    return { ...base, status: 'guiding', remainingM: rem, next, offRoute: off, ramp, text };
  }

  /** 매 프레임 호출. 경로 이탈이 1초 이상 지속되면 재탐색 (최소 1.5초 간격). */
  update(dt: number, p: Pt): NavState {
    this.cool = Math.max(0, this.cool - dt);
    let st = this.evaluate(p);
    if (st.offRoute) {
      this.offT += dt;
      if (this.offT >= 1 && this.cool === 0) {
        this.plan(p);
        this.reroutes++;
        this.offT = 0;
        this.cool = 1.5;
        st = this.evaluate(p);
      }
    } else this.offT = 0;
    this.last = { ...st, rerouteCount: this.reroutes };
    return this.last;
  }
}

/** 경로 시작부터 seg 번째 점까지의 누적 길이 */
function cumAt(pts: Pt[], seg: number): number {
  let l = 0;
  for (let i = 1; i <= seg && i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** 3D 경로 단순화(Douglas–Peucker). 높이 변화는 3배 가중해 경사로 시작/끝 점이 남게 한다 */
export function simplify3(pts: { x: number; z: number; y: number }[], eps: number): { x: number; z: number; y: number }[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const d = (p: { x: number; z: number; y: number }, a: { x: number; z: number; y: number }, b: { x: number; z: number; y: number }): number => {
    const ax = b.x - a.x;
    const az = b.z - a.z;
    const ay = (b.y - a.y) * 3;
    const l2 = ax * ax + az * az + ay * ay;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.z - a.z) * az + (p.y - a.y) * 3 * ay) / l2));
    return Math.hypot(p.x - (a.x + t * ax), p.z - (a.z + t * az), (p.y - a.y) * 3 - t * ay);
  };
  const rec = (a: number, b: number): void => {
    let md = 0;
    let mi = -1;
    for (let i = a + 1; i < b; i++) {
      const q = d(pts[i], pts[a], pts[b]);
      if (q > md) {
        md = q;
        mi = i;
      }
    }
    if (mi >= 0 && md > eps) {
      keep[mi] = true;
      rec(a, mi);
      rec(mi, b);
    }
  };
  rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}
