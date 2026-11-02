import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, QUALITY_PRESETS, loadRecords, loadSettings, saveRecords, saveSettings, sanitizeSettings } from '../src/core/settings';
import { loadJson, saveJson } from '../src/core/storage';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}
const g = globalThis as unknown as { localStorage?: unknown };

describe('설정/기록 저장', () => {
  beforeEach(() => { g.localStorage = new MemStorage(); });
  afterEach(() => { delete g.localStorage; });

  it('설정을 저장하고 다시 불러온다 (새로고침 시나리오)', () => {
    const s = { ...DEFAULT_SETTINGS, sensorRange: 3.1, sensorSound: false, mapId: 'outdoor' };
    expect(saveSettings(s)).toBe(true);
    const back = loadSettings();
    expect(back.sensorRange).toBe(3.1);
    expect(back.sensorSound).toBe(false);
    expect(back.mapId).toBe('outdoor');
  });
  it('기록을 저장하고 불러온다', () => {
    saveRecords({ 'lot/lot-front': { bestScore: 900, bestTime: 30, plays: 3, clears: 2 } });
    expect(loadRecords()['lot/lot-front'].bestScore).toBe(900);
  });
  it('손상된 JSON 이어도 기본값으로 복구한다', () => {
    (g.localStorage as MemStorage).setItem('parksim.v1.settings', '{broken');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('범위를 벗어난 값은 안전한 범위로 보정한다', () => {
    const s = sanitizeSettings({ sensorRange: 99, sensorCritical: 9, resolutionScale: 0, touchScale: 10, sensorVolume: 5 });
    expect(s.sensorRange).toBeLessThanOrEqual(4);
    expect(s.sensorCritical).toBeLessThan(s.sensorRange);
    expect(s.resolutionScale).toBeGreaterThanOrEqual(0.4);
    expect(s.touchScale).toBeLessThanOrEqual(1.5);
    expect(s.sensorVolume).toBeLessThanOrEqual(1);
  });
  it('품질 프리셋은 낮음 < 보통 < 높음 순으로 해상도가 커진다', () => {
    expect(QUALITY_PRESETS.low.resolutionScale).toBeLessThan(QUALITY_PRESETS.medium.resolutionScale);
    expect(QUALITY_PRESETS.medium.resolutionScale).toBeLessThan(QUALITY_PRESETS.high.resolutionScale);
    expect(QUALITY_PRESETS.low.shadows).toBe('off');
  });
});

describe('저장소를 쓸 수 없는 환경', () => {
  it('localStorage 가 없어도 예외 없이 기본값을 반환한다', () => {
    delete g.localStorage;
    expect(loadJson('x', 42)).toBe(42);
    expect(saveJson('x', 1)).toBe(false);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('pdcView 설정 (v0.4.7)', () => {
  it('기본값은 서라운드, 잘못된 값은 서라운드로 보정, sensor 는 유지', () => {
    expect(DEFAULT_SETTINGS.pdcView).toBe('surround');
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, pdcView: 'x' as never }).pdcView).toBe('surround');
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, pdcView: 'sensor' }).pdcView).toBe('sensor');
  });
});
