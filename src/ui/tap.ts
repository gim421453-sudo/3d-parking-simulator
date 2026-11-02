/**
 * 멀티터치에서도 확실히 동작하는 "탭" 바인딩.
 * 다른 손가락(브레이크/핸들)이 눌려 있는 동안에는 일부 모바일 브라우저(Samsung Internet 등)가 두 번째 손가락의
 * `click` 합성을 생략/지연하는 일이 있어, 터치 포인터는 pointerdown→pointerup(같은 요소, 이동 14px 이내)로 직접 실행한다.
 * 같은 탭에서 뒤따르는 합성 click 은 무시해 이중 실행을 막고, 마우스/키보드는 기존 click 으로 처리한다.
 * 각 요소는 자기 pointerId 만 추적하므로 다른 손가락의 입력을 가로채지 않는다.
 */
export const TAP_MOVE_TOLERANCE = 14;
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  let down: { id: number; x: number; y: number } | null = null;
  let suppressUntil = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || down) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointerup', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved <= TAP_MOVE_TOLERANCE) {
      suppressUntil = performance.now() + 600;
      fn(e);
    }
  });
  const cancel = (e: PointerEvent): void => {
    if (down && e.pointerId === down.id) down = null;
  };
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', (e) => {
    // 손가락이 요소 밖으로 나가면(캡처 없음) 탭 취소
    if (e.pointerType !== 'mouse') cancel(e);
  });
  el.addEventListener('click', (e) => {
    if (performance.now() < suppressUntil) return;
    fn(e);
  });
}
