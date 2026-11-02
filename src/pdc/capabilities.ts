import type { AssistCaps } from '../vehicle/spec';
import type { AssistView } from './viewPolicy';
import { ASSIST_VIEW_ORDER } from './viewPolicy';
import type { AssistSettings } from './assistPolicy';

/** 차량이 표시할 수 있는 주차 보조 시점 */
export function allowedViews(caps: AssistCaps): AssistView[] {
  return ASSIST_VIEW_ORDER.filter((v) => {
    if (v === 'rear') return caps.rearCamera;
    if (v === 'front') return caps.frontCamera;
    return caps.virtualSurround3D; // left/right/top/oblique
  });
}

/** 수동 카메라 버튼 순환 목록 ('auto' 포함). 선택지가 없으면 빈 배열(= 버튼 없음) */
export function cameraCycle(caps: AssistCaps): ('auto' | AssistView)[] {
  const v = allowedViews(caps);
  return v.length <= 1 ? [] : ['auto', ...v];
}

/** 차량 지원 범위에 맞춰 자동 표시 설정을 제한 (전방카메라가 없으면 D 에서 주차 화면을 열지 않음) */
export function restrictAssist(s: AssistSettings, caps: AssistCaps): AssistSettings {
  return { ...s, autoRear: s.autoRear && caps.rearCamera, autoFront: s.autoFront && caps.frontCamera };
}

/** 3D 시점 자동 전환 가능 여부 */
export function autoViewAllowed(caps: AssistCaps): boolean {
  return caps.virtualSurround3D && caps.automaticViewSelection;
}

/** 기본 시점이 차량에서 지원되지 않으면 지원되는 시점으로 보정 */
export function clampView(view: AssistView, caps: AssistCaps): AssistView {
  const a = allowedViews(caps);
  return a.includes(view) ? view : (a[0] ?? 'rear');
}
