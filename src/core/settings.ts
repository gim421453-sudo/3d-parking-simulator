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
  rearPip: boolean; // 후진(R) 시 후방 카메라 보조 화면 자동 표시
  touchControls: 'auto' | 'on' | 'off';
  touchScale: number; // 0.8 ~ 1.4
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
  sensorRange: 2.5,
  sensorCritical: 0.3,
  sensorDebug: false,
  rearMirror: true,
  rearPip: true,
  touchControls: 'auto',
  touchScale: 1,
  vehicleId: 'sedan',
  mapId: 'lot',
  missionId: 'lot-front',
};

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.resolutionScale = Math.min(1, Math.max(0.4, Number(s.resolutionScale) || 1));
  s.sensorRange = Math.min(4, Math.max(1, Number(s.sensorRange) || 2.5));
  s.sensorCritical = Math.min(s.sensorRange - 0.2, Math.max(0.1, Number(s.sensorCritical) || 0.3));
  s.sensorVolume = Math.min(1, Math.max(0, Number(s.sensorVolume)));
  s.touchScale = Math.min(1.5, Math.max(0.7, Number(s.touchScale) || 1));
  s.sensorViewFps = Math.min(60, Math.max(5, Number(s.sensorViewFps) || 24));
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
