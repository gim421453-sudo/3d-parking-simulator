/**
 * v0.6.3 P0 회귀: 주차보조 자동 카메라가 실제 위험과 반대/무관한 방향으로 바뀌던 문제.
 * 실제 센서 레이캐스트 + 위험 순위 + 시점 정책을 장면 18개 × 차량 방향 4개로 돌려 방향을 직접 판정한다
 * (scripts/pdc-scenes.ts 와 같은 실행기). 이전 버전 비교: v0.6.0 52/72, v0.6.1 48/72(수정 전), 현재 72/72.
 */
import { describe, expect, it } from 'vitest';
import * as math from '../src/core/math';
import * as phys from '../src/vehicle/physics';
import * as sens from '../src/sensors/sensorSystem';
import * as riskM from '../src/pdc/risk';
import * as gateM from '../src/pdc/viewGate';
import * as polM from '../src/pdc/viewPolicy';
import * as frM from '../src/pdc/framing';
import * as guideM from '../src/pdc/guidelines';
import * as camM from '../src/game/cameras';
import * as rankM from '../src/pdc/riskRank';
import * as autoM from '../src/pdc/autoView';
import { VEHICLES } from '../src/vehicle/spec';
import { SCENES } from './fixtures/pdcScenes';
import { runPdcScene, type PdcMods } from './fixtures/runPdcScene';
import { RiskRanker } from '../src/pdc/riskRank';

const mods: PdcMods = { math, phys, sens, riskM, gateM, polM, frM, guideM, camM, rankM, autoM };
const HEADINGS = [0, 1.1, 2.7, -2.0];

describe('자동 카메라 방향 — 장면별 직접 판정 (v0.6.3)', () => {
  for (const sc of SCENES)
    it(`${sc.id}: ${sc.name}`, () => {
      for (const H of HEADINGS) {
        const r = runPdcScene(mods, 'cur', VEHICLES[1], sc, H);
        const msg = JSON.stringify({ H, final: r.finalView, wrong: r.wrong, closest: r.closest, seq: r.views.map((v) => `${v.t}:${v.view}${v.auto ? '*' : ''}`) });
        expect(r.wrong, `금지 방향 카메라 ${msg}`).toEqual([]);
        expect(sc.allow, `최종 카메라 ${msg}`).toContain(r.finalView);
        expect(r.visible, `가장 가까울 때 위험 물체가 화면 밖 ${msg}`).toBe(true);
        expect(r.switches, `전환 횟수 ${msg}`).toBeLessThanOrEqual(sc.maxSwitches ?? 3);
      }
    });
  it('다른 차종(SUV/해치)에서도 좁은 칸·앞벽 이탈 장면이 금지 방향으로 가지 않는다', () => {
    for (const spec of VEHICLES)
      for (const id of ['slot-side-R', 'slot-side-R2', 'nose-in-R', 'tail-in-D', 'stop-left', 'stop-right']) {
        const sc = SCENES.find((s) => s.id === id)!;
        const r = runPdcScene(mods, 'cur', spec, sc, 0.7);
        expect(r.wrong, `${spec.id} ${id}`).toEqual([]);
      }
  });
});

describe('원인 단위 검사', () => {
  const spec = VEHICLES[1];
  const body = { x: 0, z: 0, rot: 0, hw: spec.width / 2, hl: spec.length / 2 };
  const snapOf = (pts: { x: number; z: number; id: string }[]): sens.SensorSnapshot => ({
    readings: spec.sensors.map((m, k) => ({ id: m.id, group: m.group, distance: k === 0 ? 0.1 : null, nearest: null, hits: k === 0 ? pts.map((p) => ({ x: p.x, z: p.z, distance: 0.1, colliderId: p.id, tag: 'wall' })) : [], origin: { x: 0, z: 0 }, rays: [] })),
    groupMin: { front: null, rear: null, left: null, right: null },
    range: 2.5,
    critical: 0.3,
  });
  it('경로 밖에서 나란히 가까운 차(0.2m)는 2등급이어도 카메라 자격 없음(relevant=false), 게이트도 열지 않음', () => {
    const side = Array.from({ length: 9 }, (_, k) => ({ x: -(body.hw + 0.2), z: -1.6 + k * 0.4, id: 'car' }));
    const r = new RiskRanker().update(0.05, { snap: snapOf(side), spec, body, gear: 'R', v: 0, steer: 0 });
    expect(r[0].cls).toBe(2);
    expect(r[0].relevant).toBe(false);
    expect(autoM.viewTopOf(r)).toBeNull();
    expect(autoM.viewGateOpens(0, 0, 0, r)).toBe(false);
  });
  it('앞벽에 붙은 채(0.05m) 후진: 앞벽은 경로와 교차하지 않아 전방 카메라 근거가 되지 않는다', () => {
    const wall = Array.from({ length: 9 }, (_, k) => ({ x: -0.8 + k * 0.2, z: body.hl + 0.05, id: 'fw' }));
    const r = new RiskRanker().update(0.05, { snap: snapOf(wall), spec, body, gear: 'R', v: 0, steer: 0 });
    expect(r[0].cls).toBe(1);
    expect(r[0].relevant).toBe(false);
    expect(autoM.viewTopOf(r)).toBeNull();
  });
  it('직진 후진 뒷벽: 접촉 부위는 뒤범퍼(모서리 여유 구간 점 때문에 옆면으로 분류하지 않음)', () => {
    const wall = Array.from({ length: 21 }, (_, k) => ({ x: -2 + k * 0.2, z: -body.hl - 0.5, id: 'rw' }));
    const r = new RiskRanker().update(0.05, { snap: snapOf(wall), spec, body, gear: 'R', v: -0.3, steer: 0 });
    expect(r[0].relevant).toBe(true);
    expect(r[0].contact).toBe('rear');
  });
  it('왼쪽 앞 기둥 + 왼쪽 조향(D): 접촉 부위 기준으로 왼쪽/앞 카메라, 오른쪽 아님', () => {
    const pil = Array.from({ length: 7 }, (_, k) => ({ x: body.hw + 0.35 + Math.cos(k) * 0.05, z: body.hl + 0.2 + k * 0.05, id: 'pil' }));
    const r = new RiskRanker().update(0.05, { snap: snapOf(pil), spec, body, gear: 'D', v: 0, steer: 0.5 });
    expect(r[0].relevant).toBe(true);
    expect(['front', 'frontLeft', 'left']).toContain(r[0].contact);
  });
  it('차폭 바깥 기둥에 조향하며 닿으면 모서리 접촉 — 좌우 대칭 장면이 같은 분류(앞범퍼/모서리로 갈리지 않음)', () => {
    // e2e-v061 정차 조향: 왼쪽 장면만 '앞범퍼'로 분류돼 기본 전방 카메라에 머물렀다(점 순서에 따라 갈림)
    for (const sc of SCENES.filter((q) => q.id === 'stop-left' || q.id === 'stop-right')) {
      const r = runPdcScene(mods, 'cur', VEHICLES[1], sc, 0);
      const last = r.views.at(-1)!;
      const side = sc.id === 'stop-left' ? 'Left' : 'Right';
      expect((last.top as { contact?: string } | null)?.contact, JSON.stringify(last.top)).toBe(`front${side}`);
      expect(r.finalView).toBe(side.toLowerCase());
    }
  });
  it('자동 시점끼리 전환은 최소 유지 시간을 지킨다(2등급 접촉 부위가 경계에서 흔들려도 진동 없음)', () => {
    const p = new polM.ViewPolicy();
    const mk = (contact: string): polM.SideObservation => ({
      level: { front: 'none', rear: 'none', left: 'none', right: 'none' },
      hits: { front: 0, rear: 0, left: 0, right: 0 },
      risk: { threat: { front: false, rear: false, left: false, right: false }, veryClose: { front: false, rear: false, left: false, right: false }, pillar: { front: false, rear: false, left: false, right: false }, narrow: false, sideBlocked: { left: false, right: false }, top: { group: 'right', place: 'rearRight', cls: 2, swing: false, id: 'w', contact } },
    });
    const seen: string[] = [];
    for (let k = 0; k < 40; k++) {
      const d = p.update(0.05, 'rear', null, mk(k % 4 < 2 ? 'rearRight' : 'rear'), true);
      if (seen.at(-1) !== d.view) seen.push(d.view);
    }
    expect(seen.length).toBeLessThanOrEqual(2);
  });
});
