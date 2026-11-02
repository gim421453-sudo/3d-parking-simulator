import { PDC_PALETTES, type PdcPaletteId } from '../pdc/pdcModel';
import { loadJson, saveJson } from './storage';

export type QualityPreset = 'low' | 'medium' | 'high';

export interface Settings {
  quality: QualityPreset;
  resolutionScale: number; // 0.5 ~ 1.0 (devicePixelRatio에 곱함)
  shadows: 'off' | 'low' | 'medium' | 'high';
  showFps: boolean;
  sensorEnabled: boolean;
  sensorSound: boolean;
  sensorVolume: number; // 0..1
  sensorRange: number; // m, 최대 감지 거리
  sensorCritical: number; // m, 연속 경고 거리
  sensorDebug: boolean;
  sensorViewFps: number; // 센서 3D 화면 갱신 FPS (부하 관리)
  rearMirror: boolean; // 후방카메라 좌우 반전(실제 후방카메라처럼)
  rearPip: boolean; // 후진(R) 시 후방카메라 + PDC 주차 보조 화면 자동 표시
  assistFrontAuto: boolean; // D 선택 시 전방카메라 + 전방 PDC 자동 표시
  assistFrontMaxKmh: number; // D 에서 주차 보조 화면이 유지되는 최대 속도(km/h)
  assistExitSec: number; // P 로 바꾼 뒤 주차 보조 화면이 닫히기까지(초)
  assistGuides: boolean; // 조향 연동 주차 가이드라인
  assistCameraFps: number; // 주차 보조 카메라 갱신 FPS (부하 조절)
  pdcPalette: PdcPaletteId; // PDC 경고 색상 프리셋
  assistAutoView: boolean; // 측면 장애물 접근 시 3D 측면/탑뷰로 자동 전환
  infoAutoShow: boolean; // 주차 보조가 필요하면 플로팅 디스플레이 자동 표시
  infoAutoHide: boolean; // 주차 보조가 끝나면 플로팅 디스플레이 자동 숨김 (끄면 내비게이션을 표시하며 유지)
  infoAutoHideSec: number; // 자동 숨김 지연(초)
  cabinFps: number; // 1인칭 실내 화면 갱신 FPS (부하 조절)
  mirrorFps: number; // 사이드미러/룸미러 갱신 FPS (0 = 끔, 부하 조절)
  touchControls: 'auto' | 'on' | 'off';
  touchScale: number; // 0.8 ~ 1.4
  steerControl: 'wheel' | 'buttons'; // 터치 조향 방식 (회전 핸들 1080° / 좌우 버튼)
  steerSensitivity: number; // 핸들 감도 0.6~1.6
  steerReturn: number; // 핸들 복귀 속도 0.5~2
  vehicleId: string;
  mapId: string;
  missionId: string; // 'free' = 자유주행
}

export const QUALITY_PRESETS: Record<QualityPreset, Pick<Settings, 'resolutionScale' | 'shadows' | 'sensorViewFps'>> = {
  low: { resolutionScale: 0.6, shadows: 'off', sensorViewFps: 15 },
  medium: { resolutionScale: 0.85, shadows: 'low', sensorViewFps: 24 },
  high: { resolutionScale: 1.0, shadows: 'high', sensorViewFps: 30 },
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  ...QUALITY_PRESETS.medium,
  showFps: false,
  sensorEnabled: true,
  sensorSound: true,
  sensorVolume: 0.5,
  sensorRange: 3.0,
  sensorCritical: 0.5,
  sensorDebug: false,
  rearMirror: true,
  rearPip: true,
  assistFrontAuto: true,
  assistFrontMaxKmh: 15,
  assistExitSec: 3,
  assistGuides: true,
  assistCameraFps: 30,
  pdcPalette: 'standard',
  assistAutoView: true,
  infoAutoShow: true,
  infoAutoHide: true,
  infoAutoHideSec: 2.5,
  cabinFps: 15,
  mirrorFps: 15,
  touchControls: 'auto',
  touchScale: 1,
  steerControl: 'wheel',
  steerSensitivity: 1,
  steerReturn: 1,
  vehicleId: 'sedan',
  mapId: 'lot',
  missionId: 'lot-front',
};

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.resolutionScale = Math.min(1, Math.max(0.4, Number(s.resolutionScale) || 1));
  s.sensorRange = Math.min(4, Math.max(1, Number(s.sensorRange) || 3.0));
  s.sensorCritical = Math.min(s.sensorRange - 0.2, Math.max(0.1, Number(s.sensorCritical) || 0.5));
  s.sensorVolume = Math.min(1, Math.max(0, Number(s.sensorVolume)));
  s.touchScale = Math.min(1.5, Math.max(0.7, Number(s.touchScale) || 1));
  s.steerControl = s.steerControl === 'buttons' ? 'buttons' : 'wheel';
  s.steerSensitivity = Math.min(1.6, Math.max(0.6, Number(s.steerSensitivity) || 1));
  s.steerReturn = Math.min(2, Math.max(0.5, Number(s.steerReturn) || 1));
  s.sensorViewFps = Math.min(60, Math.max(5, Number(s.sensorViewFps) || 24));
  s.assistFrontMaxKmh = Math.min(30, Math.max(3, Number(s.assistFrontMaxKmh) || 10));
  s.assistExitSec = Math.min(10, Math.max(0, Number.isFinite(Number(s.assistExitSec)) ? Number(s.assistExitSec) : 3));
  s.assistCameraFps = Math.min(60, Math.max(10, Number(s.assistCameraFps) || 30));
  if (!(s.pdcPalette in PDC_PALETTES)) s.pdcPalette = 'standard';
  s.infoAutoHideSec = Math.min(10, Math.max(0.5, Number(s.infoAutoHideSec) || 2.5));
  s.cabinFps = Math.min(30, Math.max(5, Number(s.cabinFps) || 15));
  s.mirrorFps = Math.min(30, Math.max(0, Number.isFinite(Number(s.mirrorFps)) ? Number(s.mirrorFps) : 15));
  return s;
}

export function loadSettings(): Settings {
  return sanitizeSettings(loadJson<Partial<Settings>>('settings', {}));
}
export function saveSettings(s: Settings): boolean {
  return saveJson('settings', s);
}

export interface MissionRecord {
  bestScore: number;
  bestTime: number;
  plays: number;
  clears: number;
}
export type Records = Record<string, MissionRecord>;

export const loadRecords = (): Records => loadJson<Records>('records', {});
export const saveRecords = (r: Records): boolean => saveJson('records', r);
