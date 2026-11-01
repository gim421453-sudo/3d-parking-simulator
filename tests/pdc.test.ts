import { describe, expect, it } from 'vitest';
import type { Collider } from '../src/core/geometry';
import { DEFAULT_SENSOR_CONFIG, readSensors } from '../src/sensors/sensorSystem';
import { getVehicle, VEHICLES } from '../src/vehicle/spec';
import { AssistController, DEFAULT_ASSIST, type AssistSettings } from '../src/pdc/assistPolicy';
import { buildGuideLines, guideColor } from '../src/pdc/guidelines';
import { BAND_COUNT, PDC_PALETTES, bandLevel, bandLit, buildPdcState, levelBands, sensorSectors, zoneGeometry } from '../src/pdc/pdcModel';

const spec = getVehicle('sedan');
const wall = (x: number, z: number, w: number, d: number): Collider => ({ kind: 'box', id: 'w', tag: 'wall', x, z, w, d, rot: 0, y0: 0, h: 1.2 });
const snapOf = (cols: Collider[], x = 0, z = 0, h = 0) => readSensors({ x, z, heading: h }, spec.sensors, spec.sensorHeight, cols, { ...DEFAULT_SENSOR_CONFIG, collectRays: false });
const centroid = (pts: { x: number; z: number }[]) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, z: pts.reduce((a, p) => a + p.z, 0) / pts.length });

describe('PDC 구역 모델', () => {
  it('센서 구역은 센서 장착 방향과 같은 쪽에 있다 (좌=+x, 앞=+z)', () => {
    for (const v of VEHICLES) {
      const shapes = zoneGeometry(v);
      for (const m of v.sensors) {
        const c = centroid(shapes.find((s) => s.sensorId === m.id && s.band === 2)!.points);
        if (m.group === 'left') expect(c.x, `${v.id}/${m.id}`).toBeGreaterThan(v.width / 2);
        if (m.group === 'right') expect(c.x, `${v.id}/${m.id}`).toBeLessThan(-v.width / 2);
        if (m.group === 'front') expect(c.z, `${v.id}/${m.id}`).toBeGreaterThan(0);
        if (m.group === 'rear') expect(c.z, `${v.id}/${m.id}`).toBeLessThan(0);
        // 좌우 부호는 센서 장착 x 와 일치
        if (Math.abs(m.x) > 0.2) expect(Math.sign(c.x), `${v.id}/${m.id}`).toBe(Math.sign(m.x));
      }
    }
  });
  it('구역(센서 12 × 띠 4)이 겹치지 않고 모든 방향을 덮는다', () => {
    const sec = sensorSectors(spec);
    expect(sec.size).toBe(12);
    const ranges = [...sec.values()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < ranges.length - 1; i++) expect(ranges[i][1]).toBeCloseTo(ranges[i + 1][0], 6);
    expect(ranges[ranges.length - 1][1] - ranges[0][0]).toBeCloseTo(2 * Math.PI, 6);
    expect(zoneGeometry(spec).length).toBe(12 * BAND_COUNT);
  });
  it('띠는 바깥→안쪽 순으로 채워지고 색 단계가 맞는다 (안쪽=위험)', () => {
    expect([1, 2, 3, 4].map((b) => bandLit('far', b))).toEqual([false, false, false, true]);
    expect([1, 2, 3, 4].map((b) => bandLit('critical', b))).toEqual([true, true, true, true]);
    expect([1, 2, 3, 4].map((b) => bandLit('none', b))).toEqual([false, false, false, false]);
    expect(bandLevel(1)).toBe('critical');
    expect(bandLevel(4)).toBe('far');
    expect(levelBands('mid')).toBe(2);
  });
  it('미검출 구역은 소등(none) — 장애물이 없으면 어떤 구역도 켜지지 않는다', () => {
    const st = buildPdcState(spec, snapOf([]), true, 'rear');
    expect(st.zones.every((z) => z.level === 'none')).toBe(true);
    expect(st.overall).toBe('none');
  });
  it('후방 벽은 뒤쪽 구역만 점등, 왼쪽 벽은 왼쪽 구역만 점등 (실제 장애물 위치와 일치)', () => {
    const rear = buildPdcState(spec, snapOf([wall(0, -3.25, 8, 0.5)]), true, 'rear');
    const lit = rear.zones.filter((z) => z.level !== 'none');
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.every((z) => z.group === 'rear' || z.group === 'left' || z.group === 'right')).toBe(true);
    expect(rear.zones.filter((z) => z.group === 'front').every((z) => z.level === 'none')).toBe(true);
    expect(rear.zones.some((z) => z.group === 'rear' && z.level !== 'none')).toBe(true);
    const left = buildPdcState(spec, snapOf([wall(1.5, 0, 0.5, 3)]), true, 'rear');
    expect(left.zones.filter((z) => z.group === 'left' && z.level !== 'none').length).toBeGreaterThan(0);
    expect(left.zones.filter((z) => z.group === 'right' && z.level !== 'none').length).toBe(0);
  });
  it('가까울수록 단계가 올라간다', () => {
    const lv = [2.2, 1.4, 0.8, 0.2].map((gap) => buildPdcState(spec, snapOf([wall(0, -(spec.length / 2 + gap + 0.25), 8, 0.5)]), true, 'rear').overall);
    expect(lv).toEqual(['far', 'mid', 'near', 'critical']);
  });
  it('센서 OFF 이면 모든 구역 소등 + 상태 문구', () => {
    const st = buildPdcState(spec, snapOf([wall(0, -3.25, 8, 0.5)]), false, 'rear');
    expect(st.zones.every((z) => z.level === 'none')).toBe(true);
    expect(st.statusText).toBe('PDC 꺼짐');
  });
  it('상태 문구에는 거리 숫자가 없다 (일반 화면 거리 표시 금지)', () => {
    for (const gap of [2.2, 1.4, 0.8, 0.2, 9]) {
      const st = buildPdcState(spec, snapOf([wall(0, -(spec.length / 2 + gap + 0.25), 8, 0.5)]), true, 'rear');
      expect(st.statusText).not.toMatch(/\d/);
      expect(JSON.stringify(st)).not.toMatch(/distance/);
    }
  });
  it('팔레트 3종: 4단계 색이 서로 다르다', () => {
    for (const p of Object.values(PDC_PALETTES)) expect(new Set(Object.values(p.colors)).size).toBe(4);
  });
});

describe('동적 주차 가이드라인', () => {
  it('조향 0: 차폭 평행선(후진은 뒤 범퍼에서 뒤로)', () => {
    const g = buildGuideLines(spec, 0, -1);
    expect(g.left[0].x).toBeCloseTo(spec.width / 2, 6);
    expect(g.left[0].z).toBeCloseTo(-spec.length / 2, 6);
    const last = g.left[g.left.length - 1];
    expect(last.x).toBeCloseTo(spec.width / 2, 6);
    expect(last.z).toBeCloseTo(-spec.length / 2 - 4.5, 6);
  });
  it('전진 가이드는 앞 범퍼에서 앞으로', () => {
    const g = buildGuideLines(spec, 0, 1);
    expect(g.right[0].z).toBeCloseTo(spec.length / 2, 6);
    expect(g.right[g.right.length - 1].z).toBeGreaterThan(spec.length / 2 + 4);
  });
  it('후진 + 왼쪽 조향: 경로가 왼쪽(+x)으로 휜다, 오른쪽 조향은 반대', () => {
    const l = buildGuideLines(spec, 0.4, -1);
    const r = buildGuideLines(spec, -0.4, -1);
    expect(l.left[l.left.length - 1].x).toBeGreaterThan(spec.width / 2 + 0.2);
    expect(r.right[r.right.length - 1].x).toBeLessThan(-spec.width / 2 - 0.2);
    // 좌우 대칭
    expect(l.left[l.left.length - 1].x).toBeCloseTo(-r.right[r.right.length - 1].x, 6);
  });
  it('전진 + 왼쪽 조향도 왼쪽(+x)으로 휜다', () => {
    const g = buildGuideLines(spec, 0.4, 1);
    expect(g.left[g.left.length - 1].x).toBeGreaterThan(spec.width / 2 + 0.2);
  });
  it('가이드 경로는 실제 물리(stepVehicle)가 만드는 뒤 왼쪽 모서리 궤적과 일치한다', async () => {
    const { createVehicleState, stepVehicle, requestGear } = await import('../src/vehicle/physics');
    const { localToWorld } = await import('../src/core/math');
    const steer = 0.4;
    const s = createVehicleState(spec, 0, 0, 0); // 차체 중심이 원점, heading 0 → 로컬 좌표 = 월드 좌표
    requestGear(s, 'R');
    const guide = buildGuideLines(spec, steer, -1, 3).left;
    const fixedSpec = { ...spec, maxSteer: steer };
    let travelled = 0;
    while (travelled < 3) {
      const ox = s.x, oz = s.z;
      s.v = -1.0; // 일정 속도, 조향각 고정
      s.steer = steer;
      stepVehicle(s, { throttle: 0, brake: 0, steerInput: 1 }, fixedSpec, 1 / 240);
      travelled += Math.hypot(s.x - ox, s.z - oz); // 뒤축 이동 거리 = 가이드의 진행 거리 s
    }
    const corner = localToWorld(s.x, s.z, s.heading, spec.width / 2, -spec.rearOverhang); // 뒤축 기준 (폭/2, 뒤 오버행)
    // 뒤 범퍼 왼쪽 모서리(차체 중심 기준 (W/2, -L/2))는 뒤축 기준으로 (W/2, -rearOverhang)
    const target = guide[guide.length - 1];
    expect(corner.x).toBeCloseTo(target.x, 1);
    expect(corner.z).toBeCloseTo(target.z, 1);
  });
  it('가까운 구간은 빨강, 먼 구간은 초록', () => {
    expect(guideColor(0.5)).toBe('critical');
    expect(guideColor(1.5)).toBe('mid');
    expect(guideColor(3)).toBe('far');
  });
});

describe('주차 보조 표시 정책 (R/D 자동 전환)', () => {
  const S: AssistSettings = { ...DEFAULT_ASSIST };
  const run = (c: AssistController, gear: 'P' | 'R' | 'N' | 'D', speed: number, dt = 0.05, s = S) => c.update({ gear, speedKmh: speed, dt }, s);

  it('R: 후방카메라 + 후방 PDC 자동 표시', () => {
    const c = new AssistController();
    run(c, 'P', 0);
    const o = run(c, 'R', 0);
    expect(o).toMatchObject({ active: true, camera: 'rear', focus: 'rear' });
  });
  it('R 자동 표시를 끄면 열리지 않는다', () => {
    const c = new AssistController();
    run(c, 'P', 0);
    expect(run(c, 'R', 0, 0.05, { ...S, autoRear: false }).active).toBe(false);
  });
  it('R → D: 같은 표시 상태에서 카메라만 전방으로 바뀐다 (active 유지)', () => {
    const c = new AssistController();
    run(c, 'R', 0);
    const d = run(c, 'D', 1);
    expect(d).toMatchObject({ active: true, camera: 'front', focus: 'front' });
  });
  it('D: 고속이면 닫히고(일반 화면 복귀), 충분히 느려지면 다시 열린다 (히스테리시스)', () => {
    const c = new AssistController();
    run(c, 'D', 2);
    expect(run(c, 'D', 2).active).toBe(true);
    expect(run(c, 'D', 12).active).toBe(false);
    expect(run(c, 'D', 8).active).toBe(false); // 10 이하지만 6(=10×0.6) 초과 → 아직 닫힘
    expect(run(c, 'D', 5).active).toBe(true);
  });
  it('D 속도 조건은 설정으로 바뀐다', () => {
    const c = new AssistController();
    const s = { ...S, frontMaxKmh: 20 };
    run(c, 'D', 15, 0.05, s);
    expect(run(c, 'D', 15, 0.05, s).active).toBe(true);
    const c2 = new AssistController();
    expect(run(c2, 'D', 15, 0.05, S).active).toBe(false);
  });
  it('D 에서 이미 고속이면 기어를 바꿔도 열리지 않는다', () => {
    const c = new AssistController();
    expect(run(c, 'D', 30).active).toBe(false);
  });
  it('전방 자동 표시를 끄면 D 에서 열리지 않는다', () => {
    const c = new AssistController();
    expect(run(c, 'D', 1, 0.05, { ...S, autoFront: false }).active).toBe(false);
  });
  it('P: 지연 후 종료 (그 전에는 유지)', () => {
    const c = new AssistController();
    run(c, 'R', 0);
    expect(run(c, 'P', 0, 1).active).toBe(true);
    expect(run(c, 'P', 0, 1).active).toBe(true);
    expect(run(c, 'P', 0, 1.1).active).toBe(false);
  });
  it('N: 저속에서는 유지, 고속에서는 종료', () => {
    const c = new AssistController();
    run(c, 'R', 0);
    expect(run(c, 'N', 3).active).toBe(true);
    expect(run(c, 'N', 15).active).toBe(false);
  });
  it('수동 카메라 선택이 자동보다 우선하고 기어 변경 시 자동으로 복귀한다', () => {
    const c = new AssistController();
    run(c, 'R', 0);
    c.setManualCamera('front');
    const o = run(c, 'R', 0);
    expect(o).toMatchObject({ camera: 'front', focus: 'rear', cameraMode: 'front' });
    const d = run(c, 'D', 1);
    expect(d).toMatchObject({ camera: 'front', cameraMode: 'auto' });
    run(c, 'R', 0);
    expect(run(c, 'R', 0).camera).toBe('rear');
  });
  it('수동으로 닫으면 같은 기어에서는 다시 열리지 않고 기어 변경 시 정책 복귀', () => {
    const c = new AssistController();
    run(c, 'R', 0);
    c.dismiss();
    expect(run(c, 'R', 0).active).toBe(false);
    expect(run(c, 'R', 0).active).toBe(false);
    run(c, 'N', 0);
    expect(run(c, 'R', 0).active).toBe(true);
  });
  it('수동 열기(toggle)는 P/N 에서도 열리고 다시 누르면 닫힌다', () => {
    const c = new AssistController();
    run(c, 'P', 0);
    c.toggleManual();
    expect(run(c, 'P', 0, 10).active).toBe(true);
    c.toggleManual();
    expect(run(c, 'P', 0).active).toBe(false);
  });
});
