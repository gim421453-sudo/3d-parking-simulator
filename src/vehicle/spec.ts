import { DEG } from '../core/math';

export type SensorGroup = 'front' | 'rear' | 'left' | 'right';

/** 센서 장착 위치(차체 중심 기준 로컬 좌표). 시각 모델/충돌체와 독립적으로 정의된다. */
export interface SensorMount {
  id: string;
  group: SensorGroup;
  x: number; // 왼쪽 +
  z: number; // 앞 +
  angle: number; // 정면(앞)에서 왼쪽으로 + (rad)
  fov: number; // rad
}

export interface VehicleVisual {
  /** procedural: 코드로 생성, glb: GLB 모델 로드(실패 시 procedural로 대체) */
  kind: 'procedural' | 'glb';
  body: 'hatch' | 'sedan' | 'suv';
  url?: string;
  scale?: number;
  offset?: { x: number; y: number; z: number };
  rotY?: number;
}

export interface VehicleSpec {
  id: string;
  name: string;
  desc: string;
  // --- 충돌체(실제 판정): 차체 중심 OBB ---
  length: number;
  width: number;
  height: number;
  // --- 주행 ---
  wheelbase: number;
  rearOverhang: number; // 뒷축~뒤 범퍼
  maxSteer: number;
  maxSpeedFwd: number; // m/s
  maxSpeedRev: number;
  accel: number;
  // --- 바퀴(시각/회전) ---
  wheelRadius: number;
  trackWidth: number;
  // --- 카메라 앵커(차체 중심 기준) ---
  driverEye: { x: number; y: number; z: number };
  rearCam: { x: number; y: number; z: number; pitch: number };
  frontCam: { x: number; y: number; z: number; pitch: number };
  // --- 센서 ---
  sensorHeight: number;
  sensors: SensorMount[];
  color: number;
  visual: VehicleVisual;
}

/** 범퍼 가장자리 센서 12개(앞4, 뒤4, 좌2, 우2). 5° 간격 광선으로 fov를 채운다. */
export function defaultSensorLayout(length: number, width: number): SensorMount[] {
  const hl = length / 2;
  const hw = width / 2;
  const s: SensorMount[] = [];
  const mk = (id: string, group: SensorGroup, x: number, z: number, angDeg: number, fovDeg: number): void => {
    s.push({ id, group, x, z, angle: angDeg * DEG, fov: fovDeg * DEG });
  };
  mk('F-L-out', 'front', hw - 0.12, hl, 45, 60);
  mk('F-L-in', 'front', hw * 0.35, hl, 12, 50);
  mk('F-R-in', 'front', -hw * 0.35, hl, -12, 50);
  mk('F-R-out', 'front', -(hw - 0.12), hl, -45, 60);
  mk('R-L-out', 'rear', hw - 0.12, -hl, 180 - 45, 60);
  mk('R-L-in', 'rear', hw * 0.35, -hl, 180 - 12, 50);
  mk('R-R-in', 'rear', -hw * 0.35, -hl, -180 + 12, 50);
  mk('R-R-out', 'rear', -(hw - 0.12), -hl, -180 + 45, 60);
  mk('L-front', 'left', hw, hl * 0.45, 90, 60);
  mk('L-rear', 'left', hw, -hl * 0.45, 90, 60);
  mk('R-front', 'right', -hw, hl * 0.45, -90, 60);
  mk('R-rear', 'right', -hw, -hl * 0.45, -90, 60);
  return s;
}

function make(p: {
  id: string;
  name: string;
  desc: string;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  rearOverhang: number;
  color: number;
  body: 'hatch' | 'sedan' | 'suv';
  wheelRadius: number;
  maxSteer?: number;
  maxSpeedFwd?: number;
}): VehicleSpec {
  const eyeY = p.height - 0.28;
  return {
    id: p.id,
    name: p.name,
    desc: p.desc,
    length: p.length,
    width: p.width,
    height: p.height,
    wheelbase: p.wheelbase,
    rearOverhang: p.rearOverhang,
    maxSteer: p.maxSteer ?? 0.62,
    maxSpeedFwd: p.maxSpeedFwd ?? 40 / 3.6,
    maxSpeedRev: 15 / 3.6,
    accel: 2.6,
    wheelRadius: p.wheelRadius,
    trackWidth: p.width - 0.22,
    driverEye: { x: 0.36, y: eyeY, z: -0.05 },
    rearCam: { x: 0, y: 0.95, z: -p.length / 2 + 0.05, pitch: 28 * DEG },
    frontCam: { x: 0, y: 0.78, z: p.length / 2 - 0.04, pitch: 22 * DEG },
    sensorHeight: 0.55,
    sensors: defaultSensorLayout(p.length, p.width),
    color: p.color,
    visual: { kind: 'procedural', body: p.body },
  };
}

export const VEHICLES: VehicleSpec[] = [
  make({
    id: 'compact',
    name: '소형 해치백',
    desc: '작고 다루기 쉬움 (길이 3.8m). 입문용.',
    length: 3.8,
    width: 1.68,
    height: 1.48,
    wheelbase: 2.4,
    rearOverhang: 0.72,
    color: 0xe0452f,
    body: 'hatch',
    wheelRadius: 0.29,
  }),
  make({
    id: 'sedan',
    name: '중형 세단',
    desc: '균형 잡힌 기본 차량 (길이 4.6m).',
    length: 4.6,
    width: 1.85,
    height: 1.45,
    wheelbase: 2.75,
    rearOverhang: 0.95,
    color: 0x2f6fd6,
    body: 'sedan',
    wheelRadius: 0.32,
  }),
  make({
    id: 'suv',
    name: 'SUV',
    desc: '크고 높음 (길이 4.75m, 폭 1.92m). 상급자용.',
    length: 4.75,
    width: 1.92,
    height: 1.72,
    wheelbase: 2.8,
    rearOverhang: 0.98,
    color: 0x3a8a4f,
    body: 'suv',
    wheelRadius: 0.37,
  }),
];

export const getVehicle = (id: string): VehicleSpec => VEHICLES.find((v) => v.id === id) ?? VEHICLES[1];

/** 주차된 차량(장애물 차량)용 사양: 사양 목록에서 index로 선택 */
export const parkedSpec = (i: number): VehicleSpec => VEHICLES[((i % VEHICLES.length) + VEHICLES.length) % VEHICLES.length];
