import { localToWorld } from '../core/math';
import type { MapData } from '../maps/types';
import type { ParkingSlot } from '../mission/parking';
import type { VehicleSpec } from '../vehicle/spec';

const TAG_COLOR: Record<string, string> = {
  wall: '#7d8791',
  pillar: '#a0a6ad',
  cone: '#ff7a2a',
  barrier: '#e8e8e8',
  building: '#8a7f6e',
  lamp: '#f2d96a',
  tree: '#3f8a4a',
  planter: '#5f7a4e',
  curb: '#6a7078',
  drum: '#3a79e0',
  car: '#5c6f86',
};
const SURFACE_COLOR: Record<string, string> = { asphalt: '#2b2f35', concrete: '#3a3d42', sidewalk: '#585b60', grass: '#25402a' };

/** 정적 맵 레이어를 한 번 그려 캐시하고, 매 프레임 차량/목표만 덧그린다. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private map: MapData | null = null;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** 다층 맵: 현재 층(높이)에 해당하는 장애물/주차칸만 그린다. null 이면 전부(평면 맵) */
  private levelY: number | null = null;
  setLevel(y: number | null): void {
    if (y === this.levelY) return;
    this.levelY = y;
    this.base = null;
  }

  setMap(map: MapData): void {
    this.map = map;
    this.levelY = null;
    this.base = null;
  }

  /** 캔버스 CSS 크기에 맞춰 내부 해상도 갱신 */
  private fit(): boolean {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(r.width * dpr));
    const h = Math.max(10, Math.round(r.height * dpr));
    if (w === this.w && h === this.h && this.base) return false;
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    this.base = null;
    return true;
  }

  private drawBase(): void {
    const map = this.map;
    if (!map) return;
    const b = map.bounds;
    const pad = 6;
    const mw = b.maxX - b.minX;
    const md = b.maxZ - b.minZ;
    this.scale = Math.min((this.w - pad * 2) / mw, (this.h - pad * 2) / md);
    this.ox = (b.minX + b.maxX) / 2;
    this.oz = (b.minZ + b.maxZ) / 2;
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#10161d';
    g.fillRect(0, 0, this.w, this.h);
    const P = (x: number, z: number): [number, number] => this.toScreen(x, z);
    // 지면
    for (const s of map.surfaces) {
      g.fillStyle = SURFACE_COLOR[s.kind] ?? '#333';
      const [x0, y0] = P(s.x - s.w / 2, s.z + s.d / 2);
      g.fillRect(x0, y0, s.w * this.scale, s.d * this.scale);
    }
    // 주차선
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = Math.max(1, this.scale * 0.1);
    const ly = this.levelY;
    const onLevel = (y0: number, h: number): boolean => ly === null || (y0 + h > ly + 0.2 && y0 < ly + 1.7);
    for (const s of map.slots) if (ly === null || s.y === undefined || Math.abs(s.y - ly) < 0.6) this.slotPath(g, s);
    // 경사로(항상 표시: 층 연결 위치 안내)
    if (map.terrain) {
      g.fillStyle = 'rgba(120,150,190,0.35)';
      for (const t of map.terrain.surfaces) {
        if (t.kind === 'ramp') {
          g.save();
          const fx = Math.sin(t.rot);
          const fz = Math.cos(t.rot);
          const [x, y] = P(t.x + (fx * t.length) / 2, t.z + (fz * t.length) / 2);
          g.translate(x, y);
          g.rotate(t.rot + Math.PI / 2);
          g.fillRect(-(t.length * this.scale) / 2, -(t.width * this.scale) / 2, t.length * this.scale, t.width * this.scale);
          g.restore();
        } else if (t.kind === 'spiral') {
          g.save();
          g.strokeStyle = 'rgba(120,150,190,0.45)';
          g.lineWidth = (t.r1 - t.r0) * this.scale;
          g.beginPath();
          const [cx, cy] = P(t.cx, t.cz);
          // 화면 y 는 z 와 반대 방향이므로 각도 부호 반전
          g.arc(cx, cy, ((t.r0 + t.r1) / 2) * this.scale, -t.th0, -t.th1, t.th1 > t.th0);
          g.stroke();
          g.restore();
        }
      }
    }
    // v0.6.0 실제 지도: 면 → 도로 → 건물 다각형 (충돌 전용 숨김 상자는 그리지 않는다)
    if (map.geo) {
      const poly = (pts: [number, number][]): void => {
        g.beginPath();
        pts.forEach(([x, z], i) => {
          const [sx, sy] = P(x, z);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.closePath();
      };
      const AREA: Record<string, string> = { grass: '#2c4a2e', pitch: '#33553a', water: '#24445f', parking: '#3a4048' };
      for (const a of map.geo.areas) {
        g.fillStyle = AREA[a.kind] ?? '#333';
        poly(a.pts);
        g.fill();
      }
      g.strokeStyle = '#5b636d';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const r of map.geo.roads) {
        g.lineWidth = Math.max(1, r.w * this.scale);
        g.beginPath();
        r.pts.forEach(([x, z], i) => {
          const [sx, sy] = P(x, z);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        g.stroke();
      }
      for (const b of map.geo.buildings) {
        g.fillStyle = b.gen ? '#4d5560' : '#7b8592';
        poly(b.pts);
        g.fill();
      }
    }
    // 장애물
    for (const o of map.obstacles) {
      if (o.hidden) continue;
      if (!onLevel(o.y0 ?? 0, o.h)) continue;
      g.fillStyle = TAG_COLOR[o.tag] ?? '#999';
      if (o.shape === 'cyl') {
        const [x, y] = P(o.x, o.z);
        g.beginPath();
        g.arc(x, y, Math.max(1.5, (o.r ?? 0.3) * this.scale), 0, Math.PI * 2);
        g.fill();
      } else {
        g.save();
        const [x, y] = P(o.x, o.z);
        g.translate(x, y);
        g.rotate(o.rot ?? 0);
        g.fillRect(-((o.w ?? 1) * this.scale) / 2, -((o.d ?? 1) * this.scale) / 2, (o.w ?? 1) * this.scale, (o.d ?? 1) * this.scale);
        g.restore();
      }
    }
    if (map.geo) {
      // 출처 표시 (ODbL)
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.font = `${Math.max(8, Math.round(this.h * 0.045))}px sans-serif`;
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(map.geo.attribution, 4, this.h - 3);
    }
    this.base = c;
  }

  private slotPath(g: CanvasRenderingContext2D, s: ParkingSlot): void {
    g.save();
    const [x, y] = this.toScreen(s.x, s.z);
    g.translate(x, y);
    g.rotate(s.dir);
    g.strokeRect(-(s.w * this.scale) / 2, -(s.l * this.scale) / 2, s.w * this.scale, s.l * this.scale);
    g.restore();
  }

  /** 메뉴 썸네일용: 정적 맵만 그린다 */
  drawStatic(): void {
    if (!this.map) return;
    this.fit();
    if (!this.base) this.drawBase();
    this.ctx.clearRect(0, 0, this.w, this.h);
    if (this.base) this.ctx.drawImage(this.base, 0, 0);
  }

  toScreen(x: number, z: number): [number, number] {
    return [this.w / 2 + (x - this.ox) * this.scale, this.h / 2 - (z - this.oz) * this.scale];
  }

  draw(car: { x: number; z: number; heading: number }, spec: VehicleSpec, target: ParkingSlot | null, t: number): void {
    if (!this.map) return;
    this.fit();
    if (!this.base) this.drawBase();
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    if (this.base) g.drawImage(this.base, 0, 0);

    // 목표 주차 공간
    if (target) {
      g.save();
      const [x, y] = this.toScreen(target.x, target.z);
      g.translate(x, y);
      g.rotate(target.dir);
      g.fillStyle = `rgba(53,224,122,${0.35 + 0.2 * Math.sin(t * 4)})`;
      g.strokeStyle = '#35e07a';
      g.lineWidth = 2;
      g.fillRect(-(target.w * this.scale) / 2, -(target.l * this.scale) / 2, target.w * this.scale, target.l * this.scale);
      g.strokeRect(-(target.w * this.scale) / 2, -(target.l * this.scale) / 2, target.w * this.scale, target.l * this.scale);
      g.restore();
    }

    // 내 차량 (회전한 직사각형 + 진행 방향 화살표)
    const hl = spec.length / 2;
    const hw = spec.width / 2;
    g.save();
    const [cx, cy] = this.toScreen(car.x, car.z);
    g.translate(cx, cy);
    g.rotate(car.heading); // 화면에서 앞(+z)은 위(-y)이므로 heading 이 시계방향 회전과 일치
    const sc = Math.max(this.scale, 2.2);
    g.fillStyle = '#4ea1ff';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.fillRect(-hw * sc, -hl * sc, spec.width * sc, spec.length * sc);
    g.strokeRect(-hw * sc, -hl * sc, spec.width * sc, spec.length * sc);
    g.beginPath();
    g.moveTo(0, -hl * sc - 5);
    g.lineTo(-5, -hl * sc + 3);
    g.lineTo(5, -hl * sc + 3);
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.restore();
    void localToWorld;
  }
}
