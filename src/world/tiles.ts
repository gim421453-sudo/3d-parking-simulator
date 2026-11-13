/**
 * 대형 월드 타일 시스템 (v0.5.4) — 순수 로직(three.js 의존 없음).
 *
 *  - 전역 좌표(x, z; m, float64)는 **항상 진짜 좌표**다. 차량 물리/주차장 상태/충돌/내비는 전역 좌표만 쓴다.
 *  - 타일: 한 변 `size` m 의 정사각형. `tileOf` 로 타일 인덱스, `toLocal` 로 타일 로컬 좌표(0..size)를 얻는다.
 *  - 스트리밍: 중심(차량/카메라) 주변 `loadRadius` 안의 타일을 "활성", `unloadRadius` 밖의 타일을 "비활성"으로 본다(둘 사이는 유지 = 히스테리시스 → 경계에서 깜박이지 않는다).
 *    비활성은 **렌더 자원만** 해제/숨김 대상이다. 논리 상태(주차 시설/보관 차량)는 타일과 무관하게 유지된다.
 *  - 플로팅 오리진: 렌더 좌표 = 전역 좌표 − 원점. 원점은 카메라가 `originStep` 이상 멀어질 때만 그 배수로 옮긴다(float32 정밀도 유지).
 */
export interface TileId {
  ix: number;
  iz: number;
}
export const tileKey = (ix: number, iz: number): string => `${ix},${iz}`;

export class WorldGrid {
  constructor(readonly size = 64) {}
  tileOf(x: number, z: number): TileId {
    return { ix: Math.floor(x / this.size), iz: Math.floor(z / this.size) };
  }
  keyOf(x: number, z: number): string {
    return tileKey(Math.floor(x / this.size), Math.floor(z / this.size));
  }
  /** 타일의 전역 원점(남서 모서리) */
  originOf(t: TileId): { x: number; z: number } {
    return { x: t.ix * this.size, z: t.iz * this.size };
  }
  centerOf(t: TileId): { x: number; z: number } {
    return { x: (t.ix + 0.5) * this.size, z: (t.iz + 0.5) * this.size };
  }
  /** 전역 → 타일 로컬 (0 ≤ 값 < size) */
  toLocal(x: number, z: number): { tile: TileId; lx: number; lz: number } {
    const tile = this.tileOf(x, z);
    return { tile, lx: x - tile.ix * this.size, lz: z - tile.iz * this.size };
  }
  toGlobal(tile: TileId, lx: number, lz: number): { x: number; z: number } {
    return { x: tile.ix * this.size + lx, z: tile.iz * this.size + lz };
  }
  /** 타일 중심이 (x,z) 에서 radius(+타일 반대각선) 안인가 — 타일의 일부라도 반경 안에 들어오면 true */
  tileWithin(t: TileId, x: number, z: number, radius: number): boolean {
    const c = this.centerOf(t);
    const half = this.size / 2;
    const dx = Math.max(0, Math.abs(c.x - x) - half);
    const dz = Math.max(0, Math.abs(c.z - z) - half);
    return dx * dx + dz * dz <= radius * radius;
  }
  /** 반경 안에 일부라도 걸치는 타일 목록 */
  tilesWithin(x: number, z: number, radius: number): TileId[] {
    const out: TileId[] = [];
    const a = this.tileOf(x - radius, z - radius);
    const b = this.tileOf(x + radius, z + radius);
    for (let ix = a.ix; ix <= b.ix; ix++) for (let iz = a.iz; iz <= b.iz; iz++) if (this.tileWithin({ ix, iz }, x, z, radius)) out.push({ ix, iz });
    return out;
  }
}

export interface StreamUpdate {
  /** 이번에 새로 활성화된 타일 키 */
  loaded: string[];
  /** 이번에 비활성화된 타일 키 */
  unloaded: string[];
}

/** 활성 타일 집합 관리(히스테리시스). `known` = 내용이 있는 타일(없으면 모든 타일) */
export class TileStreamer {
  readonly active = new Set<string>();
  constructor(
    readonly grid: WorldGrid,
    public loadRadius: number,
    public unloadRadius: number,
    private known: Set<string> | null = null,
  ) {
    if (unloadRadius < loadRadius) throw new Error('unloadRadius 는 loadRadius 이상이어야 한다');
  }
  update(x: number, z: number): StreamUpdate {
    const loaded: string[] = [];
    const unloaded: string[] = [];
    for (const t of this.grid.tilesWithin(x, z, this.loadRadius)) {
      const k = tileKey(t.ix, t.iz);
      if (this.known && !this.known.has(k)) continue;
      if (!this.active.has(k)) {
        this.active.add(k);
        loaded.push(k);
      }
    }
    for (const k of [...this.active]) {
      const [ix, iz] = k.split(',').map(Number);
      if (!this.grid.tileWithin({ ix, iz }, x, z, this.unloadRadius)) {
        this.active.delete(k);
        unloaded.push(k);
      }
    }
    return { loaded, unloaded };
  }
}

/**
 * 플로팅 오리진: 카메라가 원점에서 `step` 이상 떨어지면 원점을 `step` 격자점으로 옮긴다.
 * 렌더 좌표(전역 − 원점)의 크기가 항상 step·√2 이하로 유지되어 float32(유효 숫자 약 7자리)에서도 mm 단위 정밀도가 남는다.
 */
export class FloatingOrigin {
  x = 0;
  z = 0;
  shifts = 0;
  constructor(readonly step = 1024) {}
  /** 카메라 전역 위치로 원점을 갱신. 원점이 바뀌었으면 true */
  update(camX: number, camZ: number): boolean {
    if (Math.abs(camX - this.x) < this.step && Math.abs(camZ - this.z) < this.step) return false;
    const nx = Math.round(camX / this.step) * this.step;
    const nz = Math.round(camZ / this.step) * this.step;
    if (nx === this.x && nz === this.z) return false;
    this.x = nx;
    this.z = nz;
    this.shifts++;
    return true;
  }
  toRender(x: number, z: number): { x: number; z: number } {
    return { x: x - this.x, z: z - this.z };
  }
  toGlobal(rx: number, rz: number): { x: number; z: number } {
    return { x: rx + this.x, z: rz + this.z };
  }
}

/** 화질별 타일 가시 반경(m): 로드/언로드 */
export const VIEW_RADIUS: Record<'low' | 'medium' | 'high', { load: number; unload: number }> = {
  low: { load: 90, unload: 110 },
  medium: { load: 130, unload: 155 },
  high: { load: 180, unload: 210 },
};
