import { angleDiff } from '../core/math';
import type { MapData, MapSlot } from '../maps/types';
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

  setMap(map: MapData): void {
    this.map = map;
    this.graph = buildBestRoadGraph(map);
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
    this.last = this.evaluate(from);
  }

  private plan(from: Pt): void {
    if (!this.graph || !this.map || !this.dest) return;
    this.route = findRoute(this.graph, this.map, from, this.dest);
    if (!this.route) this.status = 'noRoute';
    else if (this.status === 'noRoute') this.status = 'guiding';
  }

  private evaluate(p: Pt): NavState {
    const base = this.make();
    if (!this.dest) return base;
    const toDest = Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
    if (toDest <= ARRIVE_DIST) {
      this.status = 'arrived';
      return { ...base, status: 'arrived', remainingM: toDest, next: { type: 'arrive', distM: toDest }, text: '목적지에 도착했습니다' };
    }
    if (this.status === 'arrived') this.status = 'guiding'; // 도착 지점을 벗어나면 다시 안내
    if (!this.route) return { ...base, status: this.status, text: this.status === 'noRoute' ? '경로를 찾을 수 없습니다' : '경로 계산 중' };
    const pr = projectOnRoute(this.route.points, p);
    const rem = Math.max(0, routeLength(this.route.points) - pr.along);
    const next = nextManeuver(this.route.points, pr.seg, pr.along);
    const off = pr.lateral > OFF_ROUTE_DIST;
    return { ...base, status: 'guiding', remainingM: rem, next, offRoute: off, text: off ? '경로를 이탈했습니다 — 재탐색' : MANEUVER_TEXT[next.type] };
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
