import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { frameView } from '../src/pdc/framing';
import { localToWorld } from '../src/core/math';
import { SELECTABLE_VEHICLES } from '../src/vehicle/spec';

const ASPECT = 480 / 270;

/** 집중 탑뷰 프레임으로 만든 카메라에서 월드 점이 화면 안(NDC ±1)에 들어오는지 */
function ndc(f: ReturnType<typeof frameView>, p: { x: number; y: number; z: number }) {
  const cam = new THREE.PerspectiveCamera(f.fov, ASPECT, 0.1, 300);
  cam.up.set(f.up.x, f.up.y, f.up.z);
  cam.position.set(f.pos.x, f.pos.y, f.pos.z);
  cam.lookAt(f.look.x, f.look.y, f.look.z);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const v = new THREE.Vector3(p.x, p.y, p.z).project(cam);
  return { x: v.x, y: v.y, front: v.z < 1 };
}

describe('전/후방 집중 탑뷰: 자기 차량의 해당 범퍼·차체 일부가 반드시 화면에 보인다 (v0.4.7)', () => {
  for (const spec of SELECTABLE_VEHICLES) {
    for (const view of ['topFront', 'topRear'] as const) {
      for (const gap of [null, 0.3, 0.5, 1, 2, 4, 6]) {
        it(`${spec.id} ${view} 장애물 ${gap === null ? '없음' : gap + 'm'}`, () => {
          const pose = { x: 5, z: -3, heading: 0.7, y: 0 };
          const s = view === 'topFront' ? 1 : -1;
          const hits: { x: number; z: number }[] = [];
          if (gap !== null) for (let k = -3; k <= 3; k++) {
            const w = localToWorld(pose.x, pose.z, pose.heading, k * 0.6, s * (spec.length / 2 + gap));
            hits.push({ x: w.x, z: w.z });
          }
          const f = frameView({ view, pose, spec, hits, colliders: [], aspect: ASPECT });
          const hw = spec.width / 2;
          const hl = spec.length / 2;
          // 범퍼 양끝 모서리 + 범퍼 중앙 + 차체 쪽으로 40% 들어간 지점(차체 일부)
          const pts: [number, number][] = [[hw, s * hl], [-hw, s * hl], [0, s * hl], [hw, s * (hl - spec.length * 0.4)], [-hw, s * (hl - spec.length * 0.4)]];
          for (const [lx, lz] of pts) {
            const w = localToWorld(pose.x, pose.z, pose.heading, lx, lz);
            const p = ndc(f, { x: w.x, y: 0.5, z: w.z });
            expect(p.front).toBe(true);
            expect(Math.abs(p.x)).toBeLessThan(0.99);
            expect(Math.abs(p.y)).toBeLessThan(0.99);
          }
          // 장애물은 높이 상한 안에서 가능한 만큼만(가까운 것 우선) 포함된다. 6m 같이 먼 장애물보다 자기 차량이 항상 우선.
          for (const h of gap !== null && gap <= 4 ? hits : []) {
            const p = ndc(f, { x: h.x, y: 0.5, z: h.z });
            expect(Math.abs(p.x)).toBeLessThan(0.99);
            expect(Math.abs(p.y)).toBeLessThan(0.99);
          }
          // 필요 이상으로 멀리(전체 탑뷰처럼) 줌아웃하지 않는다
          expect(f.pos.y).toBeLessThanOrEqual(12.01);
        });
      }
    }
  }
});
