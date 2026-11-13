import { facilityKit } from '../maps/mechKit';
import { lamp, parkedCar, slotPaint, slotRow, tree } from '../maps/helpers';
import type { MapSlot, ObstacleDef, PaintRect, RoadSeg, SurfaceRect } from '../maps/types';
import { makeFacility, type MechFacilityConfig } from '../mech/facility';

/**
 * 도시 블록 키트 (v0.5.4) — 재사용 가능한 도로/교차로/블록 모듈로 도시형 구역의 **맵 데이터**를 만든다.
 * 실제 도시나 실제 도로를 재현한 것이 아니다(가상의 격자형 구역). 치수는 개발 단계의 기본값이다.
 *
 *  - 격자: cols × rows 블록, 블록 사이와 바깥 둘레에 양방향 2차로 도로(중앙선/가장자리선/보행로).
 *  - 블록 종류: commercial(상업 건물) · residential(주거 건물 4동) · parking(평면 주차장) · mech(기계식 주차타워, 시설 키트) · alley(골목 블록) · plaza(빈 광장)
 *  - 결과: 지면/도색/충돌체/주차칸/도로 데이터/기계식 시설 설정 — 그대로 MapData 에 넣거나 compose 로 다른 맵과 합칠 수 있다.
 */
export type CityBlockKind = 'commercial' | 'residential' | 'parking' | 'mech' | 'alley' | 'plaza';
export interface CityOptions {
  /** id 접두어 */
  ns: string;
  /** blocks[row][col] — row 0 이 남쪽(-z) */
  blocks: CityBlockKind[][];
  blockW?: number;
  blockD?: number;
  roadW?: number;
  /** 구역 중심 */
  cx?: number;
  cz?: number;
}
export interface CityData {
  surfaces: SurfaceRect[];
  paint: PaintRect[];
  obstacles: ObstacleDef[];
  slots: MapSlot[];
  roads: RoadSeg[];
  facilities: MechFacilityConfig[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 블록 정보(종류, 사각형) */
  blockRects: { kind: CityBlockKind; col: number; row: number; x0: number; x1: number; z0: number; z1: number }[];
  /** 교차로 중심 */
  intersections: { x: number; z: number }[];
}

const YEL = 0xf2c200;
const WHT = 0xf4f4f4;
const SIDEWALK = 2.0;

export function buildCity(o: CityOptions): CityData {
  const rows = o.blocks.length;
  const cols = o.blocks[0].length;
  const bw = o.blockW ?? 60;
  const bd = o.blockD ?? 50;
  const rw = o.roadW ?? 8;
  const W = cols * bw + (cols + 1) * rw;
  const D = rows * bd + (rows + 1) * rw;
  const x0 = (o.cx ?? 0) - W / 2;
  const z0 = (o.cz ?? 0) - D / 2;
  const ns = o.ns;
  const surfaces: SurfaceRect[] = [{ x: x0 + W / 2, z: z0 + D / 2, w: W + 8, d: D + 8, kind: 'grass' }];
  const paint: PaintRect[] = [];
  const obstacles: ObstacleDef[] = [];
  const slots: MapSlot[] = [];
  const roads: RoadSeg[] = [];
  const facilities: MechFacilityConfig[] = [];
  const blockRects: CityData['blockRects'] = [];
  const intersections: CityData['intersections'] = [];

  // ---- 도로(남북 cols+1 개, 동서 rows+1 개) ----
  const vx = (i: number): number => x0 + rw / 2 + i * (bw + rw);
  const hz = (j: number): number => z0 + rw / 2 + j * (bd + rw);
  for (let i = 0; i <= cols; i++) {
    const outer = i === 0 || i === cols;
    roads.push({ id: `${ns}-v${i}`, name: `${outer ? '외곽' : '남북'}도로 ${i + 1}`, kind: outer ? 'avenue' : 'street', ax: vx(i), az: z0 + rw / 2, bx: vx(i), bz: z0 + D - rw / 2, width: rw, lanes: 2 });
    surfaces.push({ x: vx(i), z: z0 + D / 2, w: rw, d: D, kind: 'asphalt' });
  }
  for (let j = 0; j <= rows; j++) {
    const outer = j === 0 || j === rows;
    roads.push({ id: `${ns}-h${j}`, name: `${outer ? '외곽' : '동서'}도로 ${j + 1}`, kind: outer ? 'avenue' : 'street', ax: x0 + rw / 2, az: hz(j), bx: x0 + W - rw / 2, bz: hz(j), width: rw, lanes: 2 });
    surfaces.push({ x: x0 + W / 2, z: hz(j), w: W, d: rw, kind: 'asphalt' });
  }
  for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) intersections.push({ x: vx(i), z: hz(j) });
  // 차선: 블록 변을 따라(교차로 안은 비운다) 중앙 점선 + 가장자리 실선 + 정지선
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j < rows; j++) {
      const za = hz(j) + rw / 2;
      const zb = hz(j + 1) - rw / 2;
      const n = Math.floor((zb - za) / 6);
      for (let k = 0; k < n; k++) paint.push({ x: vx(i), z: za + ((k + 0.5) * (zb - za)) / n, w: 0.14, d: 3, color: YEL });
      for (const s of [-1, 1]) paint.push({ x: vx(i) + s * (rw / 2 - 0.2), z: (za + zb) / 2, w: 0.12, d: zb - za, color: WHT });
      paint.push({ x: vx(i) - rw / 4, z: zb - 0.4, w: rw / 2 - 0.5, d: 0.3, color: WHT }, { x: vx(i) + rw / 4, z: za + 0.4, w: rw / 2 - 0.5, d: 0.3, color: WHT });
    }
  }
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < cols; i++) {
      const xa = vx(i) + rw / 2;
      const xb = vx(i + 1) - rw / 2;
      const n = Math.floor((xb - xa) / 6);
      for (let k = 0; k < n; k++) paint.push({ x: xa + ((k + 0.5) * (xb - xa)) / n, z: hz(j), w: 3, d: 0.14, color: YEL });
      for (const s of [-1, 1]) paint.push({ x: (xa + xb) / 2, z: hz(j) + s * (rw / 2 - 0.2), w: xb - xa, d: 0.12, color: WHT });
      paint.push({ x: xb - 0.4, z: hz(j) + rw / 4, w: 0.3, d: rw / 2 - 0.5, color: WHT }, { x: xa + 0.4, z: hz(j) - rw / 4, w: 0.3, d: rw / 2 - 0.5, color: WHT });
    }
  }

  // ---- 블록 ----
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = o.blocks[r][c];
      const bx0 = x0 + rw + c * (bw + rw);
      const bz0 = z0 + rw + r * (bd + rw);
      const bx1 = bx0 + bw;
      const bz1 = bz0 + bd;
      const mx = (bx0 + bx1) / 2;
      const mz = (bz0 + bz1) / 2;
      const id = `${ns}-b${r}${c}`;
      blockRects.push({ kind, col: c, row: r, x0: bx0, x1: bx1, z0: bz0, z1: bz1 });
      // 블록 바닥(보도) — 주차장/기계식 블록은 아래에서 아스팔트/콘크리트를 덧깐다
      surfaces.push({ x: mx, z: mz, w: bw, d: bd, kind: 'sidewalk' });
      // 가로등/가로수(블록 모서리 안쪽)
      obstacles.push(lamp(`${id}-lamp0`, bx0 + 1, bz0 + 1), lamp(`${id}-lamp1`, bx1 - 1, bz1 - 1));
      if (kind === 'commercial') {
        obstacles.push({ id: `${id}-bld`, tag: 'building', shape: 'box', x: mx, z: mz, w: bw - 2 * SIDEWALK - 4, d: bd - 2 * SIDEWALK - 4, h: 14 + ((r * 3 + c * 5) % 3) * 4, color: [0xa8b4c4, 0xc8c0b0, 0xbfc7b4][(r + c) % 3] });
      } else if (kind === 'residential') {
        const hw = (bw - 2 * SIDEWALK - 8) / 2;
        const hd = (bd - 2 * SIDEWALK - 8) / 2;
        let k = 0;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) obstacles.push({ id: `${id}-house${k++}`, tag: 'building', shape: 'box', x: mx + sx * (hw / 2 + 2), z: mz + sz * (hd / 2 + 2), w: hw, d: hd, h: 6 + ((k + r) % 2) * 2, color: [0xd4c4a8, 0xc4b8c8][k % 2] });
        obstacles.push(tree(`${id}-tree`, mx, mz));
      } else if (kind === 'parking') {
        // 평면 주차장: 남쪽 도로에서 진입(입구 폭 8m), 가운데 통로 양쪽에 직각 주차 2줄, 둘레는 낮은 담(1.0m)
        surfaces.push({ x: mx, z: mz, w: bw - 4, d: bd - 4, kind: 'asphalt' });
        const wx0 = bx0 + 2;
        const wx1 = bx1 - 2;
        const wz0 = bz0 + 2;
        const wz1 = bz1 - 2;
        const wall = (wid: string, x: number, z: number, w: number, d: number): ObstacleDef => ({ id: `${id}-${wid}`, tag: 'wall', shape: 'box', x, z, w, d, h: 1.0, color: 0x9c9c98 });
        obstacles.push(wall('wn', mx, wz1, wx1 - wx0 + 0.4, 0.4), wall('ww', wx0, mz, 0.4, wz1 - wz0), wall('we', wx1, mz, 0.4, wz1 - wz0));
        obstacles.push(wall('ws1', (wx0 + mx - 4) / 2, wz0, mx - 4 - wx0, 0.4), wall('ws2', (mx + 4 + wx1) / 2, wz0, wx1 - (mx + 4), 0.4));
        const pitch = 2.6;
        const count = Math.floor((bw - 12) / pitch);
        const sx = mx - ((count - 1) * pitch) / 2;
        const rowN = slotRow({ prefix: `${id}-pn`, startX: sx, z: wz1 - 3.2, count, pitch, w: pitch, l: 5.2, dir: 0, empty: Array.from({ length: count }, (_, i) => i).filter((i) => i % 3 === 1) });
        const rowS = slotRow({ prefix: `${id}-pm`, startX: sx, z: mz - 1.0, count, pitch, w: pitch, l: 5.2, dir: Math.PI, empty: Array.from({ length: count }, (_, i) => i).filter((i) => i % 4 === 2) });
        // 가운데 줄(rowS)은 입구 통로(가운데 8m)를 비운다
        const keep = (s: MapSlot): boolean => Math.abs(s.x - mx) > 5.2;
        for (const s of [...rowN.slots, ...rowS.slots.filter(keep)]) {
          slots.push(s);
          paint.push(...slotPaint(s));
        }
        obstacles.push(...rowN.cars, ...rowS.cars.filter((q) => Math.abs(q.x - mx) > 5.2));
        // 진입로(보도 턱 낮춤): 남쪽 도로 → 입구
        surfaces.push({ x: mx, z: bz0 + 1, w: 8, d: 2.2, kind: 'asphalt' });
        paint.push({ x: mx, z: bz0 + 0.2, w: 7, d: 0.25, color: WHT });
      } else if (kind === 'mech') {
        // 기계식 주차타워: 시설 키트를 블록 가운데에 놓고(진입로는 서쪽 도로에서 동쪽으로), 진입부를 포장한다
        const f = makeFacility({ id: `${id}-mech`, name: '도시 기계식 주차타워 (8층)', x: bx0 + 30, z: mz, rotationY: 0, floors: 8 });
        facilities.push(f);
        const kit = facilityKit(f, { idPrefix: `${f.id}:`, pad: true });
        obstacles.push(...kit.obstacles);
        paint.push(...kit.paint);
        surfaces.push({ x: bx0 + 7, z: mz, w: 14, d: 8, kind: 'asphalt' }, ...kit.surfaces);
      } else if (kind === 'alley') {
        // 골목 블록: 건물 2동 사이에 폭 3.6m 골목(남북 관통)
        const gap = 3.6;
        const bwid = (bw - 2 * SIDEWALK - gap) / 2;
        for (const s of [-1, 1]) obstacles.push({ id: `${id}-bld${s > 0 ? 'e' : 'w'}`, tag: 'building', shape: 'box', x: mx + s * (gap / 2 + bwid / 2), z: mz, w: bwid, d: bd - 2 * SIDEWALK, h: 9 + (s > 0 ? 3 : 0), color: s > 0 ? 0xc4b8c8 : 0xd4c4a8 });
        surfaces.push({ x: mx, z: mz, w: gap, d: bd, kind: 'asphalt' });
        obstacles.push(parkedCar(`${id}-car`, mx + 6, bz0 - 0.2 - 100, 0, 1)); // 자리 표시용(맵 밖) — 아래에서 제거
        obstacles.pop();
      } else {
        obstacles.push(tree(`${id}-t0`, mx - 8, mz), tree(`${id}-t1`, mx + 8, mz));
      }
    }
  }
  const pad = 4;
  return { surfaces, paint, obstacles, slots, roads, facilities, blockRects, intersections, bounds: { minX: x0 - pad, maxX: x0 + W + pad, minZ: z0 - pad, maxZ: z0 + D + pad } };
}
