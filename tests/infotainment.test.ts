import { describe, expect, it } from 'vitest';
import { DEFAULT_INFO_SETTINGS, InfotainmentController, type InfoSettings } from '../src/infotainment/controller';
import { AssistController, DEFAULT_ASSIST } from '../src/pdc/assistPolicy';

const S: InfoSettings = { ...DEFAULT_INFO_SETTINGS };
const step = (c: InfotainmentController, gear: any, parking: boolean, firstPerson = false, dt = 0.1, s = S) => c.update({ dt, gear, parkingActive: parking, firstPerson }, s);
const hold = (c: InfotainmentController, gear: any, parking: boolean, sec: number, fp = false, s = S) => {
  let o = step(c, gear, parking, fp, 0.1, s);
  for (let t = 0.1; t < sec; t += 0.1) o = step(c, gear, parking, fp, 0.1, s);
  return o;
};

describe('인포테인먼트 공유 상태', () => {
  it('시작 시에는 숨김', () => {
    expect(step(new InfotainmentController(), 'P', false)).toMatchObject({ floatingVisible: false, content: 'nav' });
  });
  it('주차 보조가 활성화되면 플로팅 자동 표시 + parking 콘텐츠', () => {
    const c = new InfotainmentController();
    expect(step(c, 'R', true)).toMatchObject({ floatingVisible: true, content: 'parking' });
  });
  it('자동 표시를 끄면 플로팅은 열리지 않지만 콘텐츠는 parking (실내 화면용)', () => {
    const c = new InfotainmentController();
    const o = step(c, 'R', true, false, 0.1, { ...S, autoShow: false });
    expect(o.floatingVisible).toBe(false);
    expect(o.content).toBe('parking');
  });
  it('주차 보조 종료 시: 자동 숨김이면 지연 후 숨김, 아니면 내비게이션으로 유지', () => {
    const c = new InfotainmentController();
    step(c, 'D', true);
    expect(hold(c, 'D', false, 1).floatingVisible).toBe(true); // 지연 중
    const o = hold(c, 'D', false, 3);
    expect(o.floatingVisible).toBe(false);
    const k = new InfotainmentController();
    step(k, 'D', true, false, 0.1, { ...S, autoHide: false });
    const o2 = hold(k, 'D', false, 10, false, { ...S, autoHide: false });
    expect(o2).toMatchObject({ floatingVisible: true, content: 'nav' });
  });
  it('수동 토글이 자동보다 우선하고 같은 기어에서는 유지된다', () => {
    const c = new InfotainmentController();
    step(c, 'R', true);
    c.hide();
    expect(hold(c, 'R', true, 2).floatingVisible).toBe(false);
    c.toggle();
    expect(step(c, 'R', true).floatingVisible).toBe(true);
  });
  it('R/D 를 새로 선택하면 이전에 수동으로 닫았어도 다시 자동 표시', () => {
    const c = new InfotainmentController();
    step(c, 'R', true);
    c.hide();
    step(c, 'R', true);
    step(c, 'N', false);
    expect(step(c, 'D', true).floatingVisible).toBe(true);
  });
  it('1인칭에서는 플로팅이 자동으로 완전히 숨겨지고 상태는 그대로 공유된다', () => {
    const c = new InfotainmentController();
    step(c, 'R', true);
    const o = step(c, 'R', true, true);
    expect(o.floatingVisible).toBe(false);
    expect(o.wantVisible).toBe(true);
    expect(o.content).toBe('parking'); // 실내 화면이 같은 내용을 표시
  });
  it('3인칭 복귀 시 공유 상태로 플로팅 복원', () => {
    const c = new InfotainmentController();
    step(c, 'R', true);
    step(c, 'R', true, true);
    expect(step(c, 'R', true, false).floatingVisible).toBe(true);
  });
  it('1인칭 동안 주차 보조가 끝나면 자동 숨김 설정을 따라 복귀 시 숨겨져 있다', () => {
    const c = new InfotainmentController();
    step(c, 'D', true);
    hold(c, 'D', false, 3.5, true); // 1인칭에서 주차 종료 + 지연 경과
    expect(step(c, 'D', false, false).floatingVisible).toBe(false);
  });
  it('1인칭에서 한 토글도 3인칭과 같은 상태를 바꾼다 (독립 상태 없음)', () => {
    const c = new InfotainmentController();
    step(c, 'N', false, true);
    c.toggle(); // 1인칭에서 표시 요청
    expect(step(c, 'N', false, true).floatingVisible).toBe(false);
    expect(step(c, 'N', false, false).floatingVisible).toBe(true);
  });
});

describe('15km/h 경계: 주차 화면 ↔ 내비게이션 (AssistController + InfotainmentController)', () => {
  const run = () => {
    const a = new AssistController();
    const i = new InfotainmentController();
    let t = 0;
    const tick = (gear: any, kmh: number, sec: number) => {
      let out: any;
      for (let k = 0; k < sec / 0.05; k++) {
        t += 0.05;
        const ao = a.update({ gear, speedKmh: kmh, dt: 0.05 }, DEFAULT_ASSIST);
        out = { a: ao, i: i.update({ dt: 0.05, gear, parkingActive: ao.active, firstPerson: false }, S) };
      }
      return out;
    };
    return { tick, t: () => t };
  };
  it('기본 임계는 15km/h', () => {
    expect(DEFAULT_ASSIST.frontMaxKmh).toBe(15);
  });
  it('D 저속 → 전방 주차 보조, 15km/h 초과 → 주차 종료 + 내비게이션 콘텐츠', () => {
    const r = run();
    expect(r.tick('D', 5, 0.5).i).toMatchObject({ content: 'parking', floatingVisible: true });
    const o = r.tick('D', 20, 2);
    expect(o.a.active).toBe(false);
    expect(o.i.content).toBe('nav');
  });
  it('15 경계에서 14↔16 으로 빠르게 흔들려도 화면이 번갈아 켜졌다 꺼지지 않는다', () => {
    const r = run();
    r.tick('D', 5, 0.3);
    let flips = 0;
    let prev: boolean | null = null;
    for (let k = 0; k < 120; k++) {
      const o = r.tick('D', k % 2 ? 14 : 16, 0.05);
      if (prev !== null && o.a.active !== prev) flips++;
      prev = o.a.active;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });
  it('다시 충분히 감속(≤9km/h)하고 최소 유지 시간이 지나면 주차 보조 복귀', () => {
    const r = run();
    r.tick('D', 5, 0.3);
    r.tick('D', 20, 2.5);
    expect(r.tick('D', 12, 1).a.active).toBe(false); // 12 는 복귀 임계(9) 초과
    expect(r.tick('D', 6, 2).a.active).toBe(true);
  });
});
