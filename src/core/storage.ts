/** localStorage 래퍼. 차단/비활성 환경에서도 앱이 죽지 않도록 모든 접근을 try/catch로 감싼다. (Android WebView에서는 앱 내부 저장소에 유지됨) */
const PREFIX = 'parksim.v1.';

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* 무시 */
  }
}
