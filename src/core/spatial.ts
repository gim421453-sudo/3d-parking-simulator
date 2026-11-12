import type { Collider } from './geometry';

/**
 * 충돌체 공간 인덱스 (균일 격자 해시, v0.5.4). 대형 맵에서 차량/센서 주변의 충돌체만 검사하기 위한 것.
 *  - 충돌체의 축 정렬 경계 상자(AABB)가 걸치는 모든 칸에 등록한다 → 큰 벽/건물도 빠짐없이 조회된다.
 *  - `query(x, z, r)` 는 원(중심, 반경)의 AABB 와 겹치는 칸의 충돌체를 중복 없이 돌려준다(보수적: 실제로는 조금 더 멀리 있는 것도 포함될 수 있다 → 정확한 판정은 호출자가 한다).
 *  - 기존 API(`findVehicleCollision(obb, colliders)`, `readSensors(..., colliders)`)에 조회 결과 배열을 그대로 넘기면 된다.
 */
export class SpatialIndex {
  readonly cell: number;
  private cells = new Map<number, Collider[]>();
  private src: readonly Collider[] | null = null;
  private n = -1;
  /** 통계(테스트/성능 측정) */
  builds = 0;
  count = 0;

  constructor(cell = 8) {
    this.cell = cell;
  }

  private key(ix: number, iz: number): number {
    // 좌표 범위 ±(2^15 칸): 충돌 없이 한 숫자로 합친다
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  static aabb(c: Collider): { minX: number; maxX: number; minZ: number; maxZ: number } {
    if (c.kind === 'cyl') return { minX: c.x - c.r, maxX: c.x + c.r, minZ: c.z - c.r, maxZ: c.z + c.r };
    const cs = Math.abs(Math.cos(c.rot));
    const sn = Math.abs(Math.sin(c.rot));
    // heading 규칙: 로컬 x(폭 w) → (cos, -sin), 로컬 z(깊이 d) → (sin, cos)
    const ex = (c.w / 2) * cs + (c.d / 2) * sn;
    const ez = (c.w / 2) * sn + (c.d / 2) * cs;
    return { minX: c.x - ex, maxX: c.x + ex, minZ: c.z - ez, maxZ: c.z + ez };
  }

  rebuild(list: readonly Collider[]): void {
    this.cells.clear();
    this.src = list;
    this.n = list.length;
    this.count = list.length;
    this.builds++;
    const s = this.cell;
    for (const c of list) {
      const b = SpatialIndex.aabb(c);
      const x0 = Math.floor(b.minX / s);
      const x1 = Math.floor(b.maxX / s);
      const z0 = Math.floor(b.minZ / s);
      const z1 = Math.floor(b.maxZ / s);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = this.key(ix, iz);
          const a = this.cells.get(k);
          if (a) a.push(c);
          else this.cells.set(k, [c]);
        }
      }
    }
  }

  /** 배열이 바뀌었으면(다른 배열이거나 길이가 달라짐) 다시 만든다. 다시 만들었으면 true */
  sync(list: readonly Collider[]): boolean {
    if (list === this.src && list.length === this.n) return false;
    this.rebuild(list);
    return true;
  }

  query(x: number, z: number, r: number, out: Collider[] = []): Collider[] {
    out.length = 0;
    const s = this.cell;
    const x0 = Math.floor((x - r) / s);
    const x1 = Math.floor((x + r) / s);
    const z0 = Math.floor((z - r) / s);
    const z1 = Math.floor((z + r) / s);
    if (x0 === x1 && z0 === z1) {
      const a = this.cells.get(this.key(x0, z0));
      if (a) for (const c of a) out.push(c);
      return out;
    }
    const seen = new Set<Collider>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const a = this.cells.get(this.key(ix, iz));
        if (!a) continue;
        for (const c of a) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push(c);
        }
      }
    }
    return out;
  }
}
