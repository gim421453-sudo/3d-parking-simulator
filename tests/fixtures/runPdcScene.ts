/**
 * PDC 자동 카메라 장면 실행기 (v0.6.3). 하네스(scripts/pdc-scenes.ts — 이전 버전 작업트리 비교)와
 * 단위 테스트(tests/autoView.test.ts)가 같은 실행 코드를 쓴다. 연결 코드는 각 버전 Game.ts 와 같다:
 *  v060: 움직여야 자동 시점 게이트가 열림 · 순위 없음 / v061: 순위 1위를 그대로 / cur: pdc/autoView.ts(viewGateOpens·viewTopOf)
 */
import * as THREE from 'three';
import { hazardPoint, sceneColliders, type Scene } from './pdcScenes';

export interface PdcMods {
  math: typeof import('../../src/core/math');
  phys: typeof import('../../src/vehicle/physics');
  sens: typeof import('../../src/sensors/sensorSystem');
  riskM: typeof import('../../src/pdc/risk');
  gateM: typeof import('../../src/pdc/viewGate');
  polM: typeof import('../../src/pdc/viewPolicy');
  frM: typeof import('../../src/pdc/framing');
  guideM: typeof import('../../src/pdc/guidelines');
  camM: typeof import('../../src/game/cameras');
  rankM: typeof import('../../src/pdc/riskRank') | null;
  autoM: typeof import('../../src/pdc/autoView') | null;
}
export interface SceneResult {
  scene: string;
  name: string;
  H: number;
  ok: boolean;
  finalView: string;
  visible: boolean;
  closest: { gap: number; view: string; vis: boolean; t: number };
  wrong: string[];
  switches: number;
  views: { t: number; view: string; auto: boolean; reason: string; top?: unknown }[];
}

export function runPdcScene(m: PdcMods, ver: 'v060' | 'v061' | 'cur', spec: import('../../src/vehicle/spec').VehicleSpec, sc: Scene, H: number): SceneResult {
  const { math, phys, sens, riskM, gateM, polM, frM, guideM, camM, rankM, autoM } = m;
  const VER = ver;
  const cfg = { ...sens.DEFAULT_SENSOR_CONFIG, collectRays: false };
  const off = { x: 13.7, z: -6.2 };
  const cols = sceneColliders(sc, spec, H, off);
  const car = phys.createVehicleState(spec, off.x, off.z, H);
  car.gear = sc.gear;
  car.steer = sc.steer0 ?? 0;
  const dt = 1 / 30;
  const views: { t: number; view: string; auto: boolean; reason: string; top?: unknown }[] = [];
  let last = '';
  // --- 버전별 상태 ---
  const tracker = new riskM.RiskTracker();
  const ranker = rankM ? new rankM.RiskRanker() : null;
  const policy = new polM.ViewPolicy();
  let viewGate = false;
  const gateSteer0 = car.steer;
  let pathCut = 99;
  let pathAcc = 1;
  let blockAcc = 1;
  const sideBlocked = { left: false, right: false };
  let lastHits: { x: number; z: number }[] = [];
  let out = { view: sc.gear === 'R' ? 'rear' : 'front', auto: false, reason: '' } as { view: string; auto: boolean; reason: string };
  let rankTop: unknown = null;
  let snap: ReturnType<typeof sens.readSensors> | null = null;
  let closest = { gap: Infinity, view: '', vis: true, t: -1 };
  let stopped = false;
  const hc = cols.find((q) => q.id === sc.hazard);
  const visibleIn = (view: string, pose: { x: number; z: number; heading: number; y: number }, sn: typeof snap, hp: { x: number; z: number }): boolean => {
    let cam: { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; fov: number };
    const hitsNow = (sn?.readings ?? []).flatMap((r) => r.hits.map((h) => ({ x: h.x, z: h.z })));
    if (view === 'rear' || view === 'front') cam = camM.CameraRig.assistTarget(view, pose, spec);
    else {
      const hs = view === 'left' || view === 'right'
        ? hitsNow.filter((h) => {
            const l = math.worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z);
            return (view === 'left' ? l.x > 0 : l.x < 0) && Math.abs(l.z) <= spec.length / 2 + 0.35;
          })
        : hitsNow;
      cam = frM.frameView({ view: view as 'left', pose, spec, hits: hs, colliders: cols, aspect: 16 / 9 });
    }
    const pc = new THREE.PerspectiveCamera(cam.fov, 16 / 9, 0.05, 500);
    pc.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    pc.up.set(cam.up.x, cam.up.y, cam.up.z);
    pc.lookAt(cam.look.x, cam.look.y, cam.look.z);
    pc.updateMatrixWorld();
    // 물체의 가장 가까운 면 위 여러 높이(물체 높이 구간 안) 중 하나라도 화면 안이면 보인다고 본다
    return !hc || [0.3, 0.55, 0.9, 1.3, 1.8].filter((y) => y >= hc.y0 && y <= hc.y0 + hc.h).some((y) => {
      const v = new THREE.Vector3(hp.x, y, hp.z).project(pc);
      return v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    });
  };
  for (let t = 0; t < sc.dur; t += dt) {
    // 입력(정지 중 조향 등)
    const tgtSteer = sc.steerAt ? sc.steerAt(t) : car.steer;
    car.steer = tgtSteer;
    const v = sc.vAt ? sc.vAt(t) : 0;
    // 운동(기구학, 충돌 직전이면 정지)
    const c0 = phys.centerOf(car, spec);
    const body0 = { x: c0.x, z: c0.z, rot: car.heading, hw: spec.width / 2, hl: spec.length / 2 };
    let minGap = Infinity;
    for (const r of snap?.readings ?? []) for (const h of r.hits) minGap = Math.min(minGap, riskM.pointToObbGap(h.x, h.z, body0));
    car.v = stopped || minGap < 0.25 ? 0 : v;
    if (car.v === 0 && minGap < 0.25) stopped = true;
    const dir = car.gear === 'R' ? -1 : 1;
    const sp = Math.abs(car.v) * dir;
    car.heading += ((sp * Math.tan(car.steer)) / spec.wheelbase) * dt;
    car.x += Math.sin(car.heading) * sp * dt;
    car.z += Math.cos(car.heading) * sp * dt;
    car.v = sp;
    const c = phys.centerOf(car, spec);
    const pose = { x: c.x, z: c.z, heading: car.heading, y: 0 };
    snap = sens.readSensors(pose, spec.sensors, spec.sensorHeight, cols, cfg);
    const body = phys.obbOf(car, spec);
    const base = car.gear === 'R' ? 'rear' : 'front';
    {
      pathAcc += dt;
      if (pathAcc >= 0.1) {
        pathAcc = 0;
        pathCut = guideM.guideCutDistance(spec, car.steer, car.gear === 'R' ? -1 : 1, pose, cols, spec.sensorHeight);
      }
      const riskOut = tracker.update(dt, snap, body, spec);
      const rankOut = ranker ? ranker.update(dt, { snap, spec, body, gear: car.gear, v: car.v, steer: car.steer }) : [];
      const hits = snap.readings.flatMap((r) => r.hits.map((h) => ({ x: h.x, z: h.z })));
      if (hits.length) lastHits = hits;
      const sideHits = (side: 'left' | 'right'): { x: number; z: number }[] =>
        lastHits.filter((h) => {
          const l = math.worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z);
          return (side === 'left' ? l.x > 0 : l.x < 0) && Math.abs(l.z) <= spec.length / 2 + 0.35;
        });
      blockAcc += dt;
      if (blockAcc >= 0.2) {
        blockAcc = 0;
        for (const side of ['left', 'right'] as const) {
          if (riskOut.groups[side].threat || out.view === side) sideBlocked[side] = !frM.frameView({ view: side, pose, spec, hits: sideHits(side), colliders: cols, aspect: 16 / 9 }).visible;
          else sideBlocked[side] = false;
        }
      }
      if (VER === 'v060') {
        if (!viewGate && Math.abs(car.v) > 0.3) viewGate = true;
      } else if (autoM) {
        if (!viewGate && autoM.viewGateOpens(car.v, car.steer, gateSteer0, rankOut)) viewGate = true;
      } else if (!viewGate && (Math.abs(car.v) > 0.3 || Math.abs(car.steer - gateSteer0) > 0.05 || (rankOut[0]?.cls ?? 9) <= 2)) viewGate = true;
      const pick = <T,>(f: (g: (typeof riskOut.groups)['front']) => T): Record<'front' | 'rear' | 'left' | 'right', T> => ({ front: f(riskOut.groups.front), rear: f(riskOut.groups.rear), left: f(riskOut.groups.left), right: f(riskOut.groups.right) });
      const gated = gateM.gateViewRisk({ threat: pick((g) => g.threat), veryClose: pick((g) => g.veryClose), gap: pick((g) => g.gap) }, { gear: car.gear, v: car.v, steer: car.steer, pathCut });
      const t0 = rankOut[0];
      const top = autoM ? autoM.viewTopOf(rankOut) ?? undefined : VER === 'v060' || !t0 ? undefined : { group: t0.group, place: t0.place, cls: t0.cls, swing: t0.swing, id: t0.id };
      rankTop = autoM ? top ?? (t0 ? { id: t0.id, cls: t0.cls, why: t0.why } : null) : t0 ? { id: t0.id, place: t0.place, cls: t0.cls, why: t0.why } : null;
      const risk = { threat: gated.threat, veryClose: gated.veryClose, pillar: pick((g) => g.pillar), narrow: riskOut.narrow, gap: pick((g) => g.gap), sideBlocked: { ...sideBlocked }, ...(top ? { top } : {}) };
      const level = { front: 'none', rear: 'none', left: 'none', right: 'none' } as const;
      out = policy.update(dt, base as 'rear', null, { level: { ...level }, hits: { front: 0, rear: 0, left: 0, right: 0 }, risk }, viewGate);
    }
    if (out.view !== last) {
      views.push({ t: +t.toFixed(2), view: out.view, auto: out.auto, reason: out.reason, top: rankTop });
      last = out.view;
    }
    // 위험 물체에 가장 가까워진 순간(간격 0.8m 이하)의 카메라가 그 물체를 화면에 담는가
    const hp = hazardPoint(sc, cols, phys.obbOf(car, spec));
    if (hp) {
      const g = riskM.pointToObbGap(hp.x, hp.z, phys.obbOf(car, spec));
      if (g <= 0.8 && g <= closest.gap + 1e-3) closest = { gap: g, view: out.view, vis: visibleIn(out.view, pose, snap, hp), t };
    }
  }
  const finalView = out.view;
  const vis = closest.vis;
  const autoViews = views.filter((q) => q.auto).map((q) => q.view);
  const wrong = autoViews.filter((v) => (sc.forbid as string[]).includes(v));
  const finalOk = (sc.allow as string[]).includes(finalView);
  const switches = views.length - 1;
  const ok = wrong.length === 0 && finalOk && vis && switches <= (sc.maxSwitches ?? 3);
  return { scene: sc.id, name: sc.name, H, ok, finalView, visible: vis, closest, wrong, switches, views };
}
