/**
 * 엔진 독립 데이터 내보내기 (Unity 등 다른 엔진 이식 준비).
 * 실행: npm run export:data  →  export/*.json
 * 좌표 규칙은 schema.json 참고: 미터, 월드 x-z 평면이 지면, heading 0 = +z, 증가하면 왼쪽 회전, 차량 로컬 +x = 왼쪽.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAPS } from '../src/maps';
import { HEADING_TOLERANCE, HOLD_SECONDS, CORNER_EPS, STOP_SPEED } from '../src/mission/parking';
import { LEVEL_ORDER, PDC_PALETTES } from '../src/pdc/pdcModel';
import { DEFAULT_ASSIST } from '../src/pdc/assistPolicy';
import { LIGHT_MODE_NAME, LEVELING_MAX } from '../src/vehicle/lighting';
import { VEHICLES } from '../src/vehicle/spec';
import { DEFAULT_SENSOR_CONFIG } from '../src/sensors/sensorSystem';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const out = new URL('../export/', import.meta.url);
mkdirSync(out, { recursive: true });
const w = (name: string, data: unknown): void => writeFileSync(new URL(name, out), JSON.stringify(data, null, 2) + '\n');

w('schema.json', {
  version: 1,
  units: 'meter / radian',
  coordinates: {
    world: 'x-z 평면이 지면, y 가 위',
    heading: '0 = +z 방향, 증가하면 왼쪽(반시계) 회전. forward = (sin h, cos h)',
    vehicleLocal: '+z = 앞, +x = 왼쪽, +y = 위. 원점 = 차체 중심의 지면 투영점',
    slot: 'x,z = 중심, w = 가로(진행 방향에 수직), l = 세로(진행 방향), dir = 앞으로 주차할 때 차 앞이 향하는 heading',
    collider: 'box: w(로컬 x) × d(로컬 z), rot(heading 규칙), [y0, y0+h]  /  cyl: r, [y0, y0+h]',
  },
  notes: ['센서 높이보다 낮거나(연석) 높은(천장) 충돌체는 센서에 감지되지 않는다. 차체 충돌은 지상고 0.2m 기준.'],
});
w('vehicles.json', VEHICLES.map((v) => ({
  id: v.id, name: v.name, length: v.length, width: v.width, height: v.height, wheelbase: v.wheelbase, rearOverhang: v.rearOverhang,
  maxSteerRad: v.maxSteer, maxSpeedFwdMps: v.maxSpeedFwd, maxSpeedRevMps: v.maxSpeedRev, accel: v.accel, transmission: v.transmission, category: v.category, wheelRadius: v.wheelRadius, trackWidth: v.trackWidth,
  cameras: { driverEye: v.driverEye, rearCam: v.rearCam, frontCam: v.frontCam },
  sensorHeight: v.sensorHeight, sensors: v.sensors, color: '#' + v.color.toString(16).padStart(6, '0'), visual: v.visual,
})));
w('sensors-and-pdc.json', {
  sensorConfig: { rangeM: DEFAULT_SENSOR_CONFIG.range, criticalM: DEFAULT_SENSOR_CONFIG.critical, rayStepRad: DEFAULT_SENSOR_CONFIG.rayStep },
  levels: { order: LEVEL_ORDER, rule: 'f=(d-critical)/(range-critical): f<.33 near, <.66 mid, else far; d<=critical → critical; 미검출 → none' },
  beep: { rule: 'd<=critical → 연속음(0), 아니면 110~900ms 선형, 범위 밖 → 무음', minMs: 110, maxMs: 900 },
  activeGroups: { R: ['rear', 'left', 'right'], D: 'speed < 10 km/h → front,left,right' },
  palettes: PDC_PALETTES,
});
w('parking-rules.json', { headingToleranceRad: HEADING_TOLERANCE, cornerEpsM: CORNER_EPS, stopSpeedMps: STOP_SPEED, holdSeconds: HOLD_SECONDS, requirements: ['차량 네 모서리가 구획 안', '방향 오차 허용 이내', '정차 상태 유지 시간'] });
w('lighting-and-ui-state.json', {
  lightModes: LIGHT_MODE_NAME,
  rules: { off: 'DRL 100%(P 제외)', position: 'DRL 100%, 후미등', low: 'DRL 30%, 하향등', high: 'DRL 30%, 하향등+상향등', auto: '어두우면 low, 밝으면 off' },
  autoLevelingMaxRad: LEVELING_MAX,
  assistDefaults: DEFAULT_ASSIST,
  uiStates: {
    assistDisplay: { active: 'boolean', camera: 'rear | front', focus: 'rear | front', cameraMode: 'auto | rear | front' },
    gears: ['P', 'R', 'N', 'D'],
    settingsDefaults: DEFAULT_SETTINGS,
  },
});
for (const m of MAPS) w(`map-${m.id}.json`, m);
console.log(`exported ${MAPS.length} maps, ${VEHICLES.length} vehicles → export/`);
