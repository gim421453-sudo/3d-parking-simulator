import { describe, expect, it } from 'vitest';
import { MirrorOverlay } from '../src/game/mirrors';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings';

describe('3인칭 미러 오버레이 (v0.5.0)', () => {
  it('기본값은 OFF 이고 저장값은 boolean 으로 보정된다', () => {
    expect(DEFAULT_SETTINGS.thirdMirror).toBe(false);
    expect(sanitizeSettings({ thirdMirror: 'yes' as unknown as boolean }).thirdMirror).toBe(false);
    expect(sanitizeSettings({ thirdMirror: true }).thirdMirror).toBe(true);
  });
  for (const [w, h] of [[1280, 800], [800, 360], [640, 360], [1920, 1080], [412, 915]] as const) {
    it(`레이아웃(${w}x${h}): 화면 안, 서로 겹치지 않음, 좌/룸/우 순서`, () => {
      const L = MirrorOverlay.layout(w, h);
      for (const r of Object.values(L)) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(w);
        expect(r.y + r.h).toBeLessThanOrEqual(h);
        expect(r.w).toBeGreaterThan(40);
      }
      expect(L.left.x + L.left.w).toBeLessThanOrEqual(L.room.x);
      expect(L.room.x + L.room.w).toBeLessThanOrEqual(L.right.x);
    });
  }
});
