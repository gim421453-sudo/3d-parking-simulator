import { proximityLevel, type ProximityLevel, type SensorSnapshot } from '../sensors/sensorSystem';
import type { SensorGroup, VehicleSpec } from '../vehicle/spec';

/**
 * PDC 표시 모델 (엔진/렌더링 독립). 센서 스냅샷 → 구역별 경고 단계.
 * 거리(m) 값은 단계 계산에만 쓰이고 이 모델의 출력에는 숫자 거리가 없다. (일반 화면에서 거리 숫자 표시 금지)
 */
export type LitLevel = Exclude<ProximityLevel, 'none'>;
export const LEVEL_ORDER: LitLevel[] = ['far', 'mid', 'near', 'critical'];

/** 단계 → 점등되는 띠(band) 개수. 0=소등 */
export const levelBands = (l: ProximityLevel): number => (l === 'none' ? 0 : LEVEL_ORDER.indexOf(l) + 1);

export type PdcPaletteId = 'standard' | 'colorblind' | 'contrast';
export interface PdcPalette {
  name: string;
  colors: Record<LitLevel, string>;
  idle: string;
}
export const PDC_PALETTES: Record<PdcPaletteId, PdcPalette> = {
  standard: { name: '표준', colors: { far: '#7fc24d', mid: '#f1d13a', near: '#f08a2b', critical: '#e5372f' }, idle: '#27323f' },
  colorblind: { name: '색약 친화', colors: { far: '#56b4e9', mid: '#f0e442', near: '#e69f00', critical: '#d55e00' }, idle: '#27323f' },
  contrast: { name: '고대비', colors: { far: '#00ff7f', mid: '#ffff00', near: '#ff8000', critical: '#ff0000' }, idle: '#1a222c' },
};

export interface PdcZoneState {
  id: string;
  group: SensorGroup;
  level: ProximityLevel;
}
export interface PdcState {
  enabled: boolean;
  zones: PdcZoneState[];
  overall: ProximityLevel;
  focus: 'rear' | 'front';
  statusText: string;
}

const RANK: Record<ProximityLevel, number> = { none: 0, far: 1, mid: 2, near: 3, critical: 4 };

export function buildPdcState(spec: VehicleSpec, snap: SensorSnapshot | null, enabled: boolean, focus: 'rear' | 'front'): PdcState {
  const zones: PdcZoneState[] = spec.sensors.map((m, i) => {
    const r = snap?.readings[i];
    // 측정되지 않은(미검출) 구역은 반드시 'none' — 거짓 경고 금지
    const level: ProximityLevel = enabled && snap && r && r.distance !== null ? proximityLevel(r.distance, snap.range, snap.critical) : 'none';
    return { id: m.id, group: m.group, level };
  });
  let overall: ProximityLevel = 'none';
  for (const z of zones) if (RANK[z.level] > RANK[overall]) overall = z.level;
  const where = focus === 'rear' ? '후방' : '전방';
  const statusText = !enabled
    ? 'PDC 꺼짐'
    : !snap
      ? '센서 대기'
      : overall === 'critical'
        ? '정지 · 장애물이 매우 가깝습니다'
        : overall === 'near'
          ? '장애물이 가깝습니다'
          : overall === 'mid'
            ? '장애물에 접근 중'
            : overall === 'far'
              ? '장애물 감지'
              : `${where} 감지된 장애물 없음`;
  return { enabled, zones, overall, focus, statusText };
}

// ------------------------------------------------------------------ 구역 기하 (차량 로컬 미터)
export interface ZoneBandShape {
  sensorId: string;
  group: SensorGroup;
  band: number; // 1(차에 가장 가까움) ~ 4(바깥)
  points: { x: number; z: number }[]; // x: 왼쪽 +, z: 앞 +
}

export const BAND_COUNT = 4;
const BAND_GAP = 0.06;
const BAND_THICK = 0.24;
const BAND_PITCH = 0.3;

/** 차체 외곽(슈퍼타원)에서 offset 만큼 바깥의 점. θ: 앞(+z)에서 왼쪽(+x)으로 증가 */
export function outlinePoint(spec: VehicleSpec, theta: number, offset: number): { x: number; z: number } {
  const a = spec.width / 2 + offset;
  const b = spec.length / 2 + offset;
  const n = 4;
  const s = Math.abs(Math.sin(theta)) / a;
  const c = Math.abs(Math.cos(theta)) / b;
  const r = Math.pow(Math.pow(s, n) + Math.pow(c, n), -1 / n);
  const x = r * Math.sin(theta);
  const z = r * Math.cos(theta);
  // 앞/뒤로 갈수록 살짝 좁아지는 실제 차체 느낌 (구역과 차량 그래픽이 같은 외곽을 공유)
  return { x: x * (1 - 0.1 * Math.pow(Math.min(1, Math.abs(z) / b), 2.2)), z };
}

/** 센서 장착 위치의 극각 순으로 차 주변 360°를 분할해 센서별 각도 구간을 정한다. */
export function sensorSectors(spec: VehicleSpec): Map<string, [number, number]> {
  const items = spec.sensors.map((m) => ({ id: m.id, th: Math.atan2(m.x, m.z) })).sort((p, q) => p.th - q.th);
  const n = items.length;
  const out = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const prev = items[(i + n - 1) % n].th - (i === 0 ? 2 * Math.PI : 0);
    const next = items[(i + 1) % n].th + (i === n - 1 ? 2 * Math.PI : 0);
    out.set(items[i].id, [(prev + items[i].th) / 2, (items[i].th + next) / 2]);
  }
  return out;
}

export function zoneGeometry(spec: VehicleSpec): ZoneBandShape[] {
  const sectors = sensorSectors(spec);
  const shapes: ZoneBandShape[] = [];
  const gap = (1.2 * Math.PI) / 180;
  const step = (3 * Math.PI) / 180;
  for (const m of spec.sensors) {
    const [t0, t1] = sectors.get(m.id)!;
    const a0 = t0 + gap;
    const a1 = t1 - gap;
    const nSeg = Math.max(1, Math.ceil((a1 - a0) / step));
    for (let band = 1; band <= BAND_COUNT; band++) {
      const inner = BAND_GAP + (band - 1) * BAND_PITCH;
      const outer = inner + BAND_THICK;
      const pts: { x: number; z: number }[] = [];
      for (let i = 0; i <= nSeg; i++) pts.push(outlinePoint(spec, a0 + ((a1 - a0) * i) / nSeg, inner));
      for (let i = nSeg; i >= 0; i--) pts.push(outlinePoint(spec, a0 + ((a1 - a0) * i) / nSeg, outer));
      shapes.push({ sensorId: m.id, group: m.group, band, points: pts });
    }
  }
  return shapes;
}

/** 띠 j(1=가장 가까움..4=바깥)가 해당 단계에서 점등되는가: 바깥에서 안쪽으로 채워진다 */
export function bandLit(level: ProximityLevel, band: number): boolean {
  return band > BAND_COUNT - levelBands(level);
}
/** 띠의 색 단계 (바깥=far … 안쪽=critical) */
export function bandLevel(band: number): LitLevel {
  return LEVEL_ORDER[BAND_COUNT - band];
}
