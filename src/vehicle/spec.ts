import { DEG } from '../core/math';
import type { GearboxKind } from './transmission';

export type SensorGroup = 'front' | 'rear' | 'left' | 'right';

/** 센서 장착 위치(차체 중심 기준 로컬 좌표). 시각 모델/충돌체와 독립적으로 정의된다. */
export interface SensorMount {
  id: string;
  group: SensorGroup;
  x: number; // 왼쪽 +
  z: number; // 앞 +
  angle: number; // 정면(앞)에서 왼쪽으로 + (rad)
  fov: number; // rad
  /** 측면 센서: 차체 중심 기준 |z| 가 이 값 이하인 히트만 이 센서의 감지로 인정 (앞/뒤 벽 오감지 방지) */
  zBound?: number;
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

/** 차량별 주차 보조 지원 기능 (데이터 기반). 지원하지 않는 기능은 호출 자체를 하지 않는다. */
export interface AssistCaps {
  rearCamera: boolean;
  frontCamera: boolean;
  /** 가상 카메라 기반 3D 측면/탑/사선 시점 (실차 카메라 스티칭이 아님) */
  virtualSurround3D: boolean;
  /** 센서 방향에 따른 3D 시점 자동 전환 */
  automaticViewSelection: boolean;
  rearParkingGuidelines: boolean;
  /** 주차 보조 패널 구성: rear = 후방카메라 전용 컴팩트, surround = 전/후방+3D */
  panelLayout: 'rear' | 'surround';
  /** 실내 디스플레이/계기판 외형 프로필 (게임 상태·렌더 로직은 공통) */
  interior: 'generic' | 'coupe' | 'suv';
  /** 사이드미러/룸미러 렌더 지원 */
  mirrors: boolean;
}

export const FULL_ASSIST: AssistCaps = {
  rearCamera: true,
  frontCamera: true,
  virtualSurround3D: true,
  automaticViewSelection: true,
  rearParkingGuidelines: true,
  panelLayout: 'surround',
  interior: 'generic',
  mirrors: true,
};

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
  /** 변속기 종류 (auto 구현됨 / manual 은 구조만 준비, 물리 미구현) */
  transmission: GearboxKind;
  /** 차종 분류 (향후 SUV/버스/트럭 확장용) */
  category: 'compact' | 'sedan' | 'suv' | 'bus' | 'truck';
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
  /** 주차 보조 지원 기능 */
  assist: AssistCaps;
  /** 번호판(한국형 가상 번호). 교체 가능 */
  plate?: string;
  color: number;
  visual: VehicleVisual;
}

/** 범퍼 가장자리 센서 12개(앞4, 뒤4, 좌2, 우2). 5° 간격 광선으로 fov를 채운다. */
export function defaultSensorLayout(length: number, width: number): SensorMount[] {
  const hl = length / 2;
  const hw = width / 2;
  const s: SensorMount[] = [];
  const mk = (id: string, group: SensorGroup, x: number, z: number, angDeg: number, fovDeg: number): void => {
    // 측면 센서(fov 140°)는 담당 구간을 차체 길이 안쪽(+0.35m)으로 제한한다
    s.push({ id, group, x, z, angle: angDeg * DEG, fov: fovDeg * DEG, ...(group === 'left' || group === 'right' ? { zBound: hl + 0.35 } : {}) });
  };
  mk('F-L-out', 'front', hw - 0.12, hl, 40, 90);
  // 안쪽 센서는 중앙을 향해 약간 토인(±4°) + 넓은 시야: 범퍼 정중앙 바로 앞의 가는 장애물(좌우 안쪽 센서 사이)이 사각지대가 되지 않게 한다
  mk('F-L-in', 'front', hw * 0.35, hl, -4, 66);
  mk('F-R-in', 'front', -hw * 0.35, hl, 4, 66);
  mk('F-R-out', 'front', -(hw - 0.12), hl, -40, 90);
  mk('R-L-out', 'rear', hw - 0.12, -hl, 180 - 40, 90);
  mk('R-L-in', 'rear', hw * 0.35, -hl, 180 + 4, 66);
  mk('R-R-in', 'rear', -hw * 0.35, -hl, 180 - 4, 66);
  mk('R-R-out', 'rear', -(hw - 0.12), -hl, -180 + 40, 90);
  mk('L-front', 'left', hw, hl * 0.45, 90, 140);
  mk('L-rear', 'left', hw, -hl * 0.45, 90, 140);
  mk('R-front', 'right', -hw, hl * 0.45, -90, 140);
  mk('R-rear', 'right', -hw, -hl * 0.45, -90, 140);
  return s;
}

/** 차체 벨트라인(하부 차체 윗면) 높이 — carModel 의 SHAPES.belt 와 같은 값. 전/후방 카메라가 차체 윗면 바로 위에 장착되도록 계산에 쓴다 */
export const BELT_RATIO = { sedan: 0.86, hatch: 0.84, suv: 1.0 } as const;
/** 전방카메라 장착(범퍼 중앙): 차체 종류별 튜닝값 {앞끝에서 안쪽 거리, 범퍼 윗면 위 높이, 아래로 기울기(도)} */
export const FRONT_CAM_TUNE = { sedan: { inset: 0.03, up: 0.14, pitch: 18 }, hatch: { inset: 0.03, up: 0.14, pitch: 18 }, suv: { inset: 0.16, up: 0.1, pitch: 24 }, glb: { inset: 0.06, up: 0.1, pitch: 20 } } as const;
export function frontCamOf(body: 'hatch' | 'sedan' | 'suv' | 'glb', length: number, height: number): { x: number; y: number; z: number; pitch: number } {
  const t = FRONT_CAM_TUNE[body];
  return { x: 0, y: bumperTopOf(height) + t.up, z: length / 2 - t.inset, pitch: t.pitch * DEG };
}
/** 앞 범퍼 윗면 높이(m) — 차고 비례 근사 */
export const bumperTopOf = (height: number): number => 0.42 * height;
export const beltOf = (body: 'hatch' | 'sedan' | 'suv', height: number): number => BELT_RATIO[body] * (height / 1.45);

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
  accel?: number;
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
    // v0.5.3: 도시 주행 확장을 위한 차종별 최고속도(소형 130 / 세단 150 / SUV 140 km/h), 후진은 20km/h 로 별도 제한. 주차장 속도 제한은 맵/도로 데이터의 몫이다
    maxSpeedFwd: p.maxSpeedFwd ?? (p.body === 'hatch' ? 130 : p.body === 'suv' ? 140 : 150) / 3.6,
    maxSpeedRev: 20 / 3.6,
    accel: p.accel ?? 2.6,
    transmission: 'auto',
    category: p.body === 'suv' ? 'suv' : p.body === 'hatch' ? 'compact' : 'sedan',
    wheelRadius: p.wheelRadius,
    trackWidth: p.width - 0.22,
    driverEye: { x: 0.36, y: eyeY, z: -0.05 },
    // v0.4.9: 카메라를 차체 윗면 바로 위(트렁크 립/후드 끝)에 장착 — 영상 하단에 실제 차체(범퍼 윗면) 일부가 보인다
    rearCam: { x: 0, y: beltOf(p.body, p.height) + 0.14, z: -p.length / 2 + 0.035, pitch: 28 * DEG },
    // v0.5.1: 전방카메라는 **앞 범퍼 중앙**(x=0)에 장착한다 (범퍼 윗면 높이 = 차고의 약 42%). 모델의 앞부분 형상이 달라
    // (앞끝에서의 안쪽 거리, 범퍼 위 높이, 기울기)는 차체 종류별로 실제 렌더에서 튜닝했다 — scripts/tune-frontcam.cjs.
    // 목표: 영상 하단에 자기 범퍼 윗면이 살짝(화면 높이의 약 10~40%) 보이고 중앙 시야는 가리지 않는다.
    frontCam: frontCamOf(p.body, p.length, p.height),
    sensorHeight: 0.55,
    sensors: defaultSensorLayout(p.length, p.width),
    assist: { ...FULL_ASSIST },
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

/**
 * 추가 선택 차량 (장애물 차량 배치에는 쓰이지 않음 → 맵 레이아웃이 바뀌지 않는다).
 * sedan-glb: 같은 제원의 세단을 "실제 GLB 파일"에서 불러오는 파이프라인 시험 차량.
 */
export const VEHICLE_EXTRAS: VehicleSpec[] = [
  {
    ...VEHICLES[1],
    id: 'sedan-glb',
    name: '중형 세단 (GLB 시험)',
    desc: '같은 제원을 GLB 파일에서 불러오는 파이프라인 시험 차량 (public/models/sedan-test.glb).',
    visual: { kind: 'glb', body: 'sedan', url: './models/sedan-test.glb', scale: 1, offset: { x: 0, y: 0, z: 0 }, rotY: 0 },
  },
];
/**
 * v0.5.0: 외부에서 확보한 **실차형 GLB** (Khronos glTF-Sample-Assets "Car Concept", CC-BY-4.0, 원본 Unity Fan CC0).
 * 출처/라이선스/변경 내역: docs/ASSETS.md, public/models/LICENSE-concept-coupe.md. BMW 원본이 아니다(BMW 모델은 인증 필요로 미확보).
 * 크기는 GLB 실측(길이 4.357, 미러 포함 폭 2.34, 높이 1.149, 축거 2.80, 타이어 반경 0.384)에 맞췄고 충돌체/센서/카메라는 이 제원을 기준으로 한다.
 */
export const CONCEPT_COUPE: VehicleSpec = {
  ...make({
    id: 'concept-coupe',
    maxSpeedFwd: 180 / 3.6,
    accel: 4.0,
    name: '컨셉 스포츠 쿠페 (실차형 GLB · CC BY)',
    desc: '외부 실차형 GLB 모델(Khronos Car Concept, CC-BY 4.0). 앞바퀴 조향/4바퀴 회전/램프 연동. BMW 원본 아님.',
    length: 4.357,
    width: 2.34,
    height: 1.149,
    wheelbase: 2.8,
    rearOverhang: 0.626,
    color: 0xaa0000,
    body: 'sedan',
    wheelRadius: 0.384,
  }),
  frontCam: frontCamOf('glb', 4.357, 1.149),
  visual: { kind: 'glb', body: 'sedan', url: './models/concept-coupe.glb', scale: 1, offset: { x: 0, y: 0, z: -0.2385 }, rotY: 0 },
  plate: '123가 4567',
};

/**
 * 차량 2대 프로필 (v0.4.1). 외형은 승인된 에셋이 없어 **임시 절차 모델**이다(Blender 작업 후 GLB 로 교체).
 * - coupe-m4: M4(G82) 계열 제원. 후방카메라 전용 (전방카메라/서라운드/3D 시점 없음).
 * - suv-x6: X6(G06) xDrive40i 계열 제원. 전/후방 + 가상 3D 서라운드.
 */
const rearOnly: AssistCaps = {
  rearCamera: true,
  frontCamera: false,
  virtualSurround3D: false,
  automaticViewSelection: false,
  rearParkingGuidelines: true,
  panelLayout: 'rear',
  interior: 'coupe',
  mirrors: true,
};
export const PROFILE_VEHICLES: VehicleSpec[] = [
  {
    ...make({
      id: 'coupe-m4',
      maxSpeedFwd: 180 / 3.6,
      accel: 4.2,
      name: '스포츠 쿠페 (M4 계열)',
      desc: '낮고 긴 2도어 쿠페 (임시 형상). 후방카메라 전용 PDC.',
      length: 4.794,
      width: 1.887,
      height: 1.393,
      wheelbase: 2.857,
      rearOverhang: 1.02,
      color: 0x1f3d8f,
      body: 'sedan',
      wheelRadius: 0.34,
    }),
    assist: rearOnly,
    plate: '123가 4567',
  },
  {
    ...make({
      id: 'suv-x6',
      name: '프리미엄 SUV 쿠페 (X6 xDrive40i 계열)',
      desc: '크고 높은 SUV 쿠페 (임시 형상). 전/후방카메라 + 3D 서라운드 PDC.',
      length: 4.936,
      width: 2.004,
      height: 1.696,
      wheelbase: 2.972,
      rearOverhang: 1.1,
      color: 0x2b2f36,
      body: 'suv',
      wheelRadius: 0.39,
    }),
    assist: { ...FULL_ASSIST, interior: 'suv' },
    plate: '456나 7890',
  },
];

export const SELECTABLE_VEHICLES: VehicleSpec[] = [...VEHICLES, ...PROFILE_VEHICLES, ...VEHICLE_EXTRAS, CONCEPT_COUPE];

export const getVehicle = (id: string): VehicleSpec => SELECTABLE_VEHICLES.find((v) => v.id === id) ?? VEHICLES[1];

/** 주차된 차량(장애물 차량)용 사양: 사양 목록에서 index로 선택 */
export const parkedSpec = (i: number): VehicleSpec => VEHICLES[((i % VEHICLES.length) + VEHICLES.length) % VEHICLES.length];
