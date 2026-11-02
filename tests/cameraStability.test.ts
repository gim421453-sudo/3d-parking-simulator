import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, mountedCamera } from '../src/game/cameras';
import { worldToLocal } from '../src/core/math';
import { getVehicle } from '../src/vehicle/spec';

/** 보조 카메라(후방/전방)가 차량 기준 로컬 좌표에서 속도와 무관하게 같은 위치/방향을 유지하는지 측정 */
function localOffset(rig: CameraRig, pose: { x: number; z: number; heading: number; y: number }) {
  const c = rig.assistCamera;
  const l = worldToLocal(pose.x, pose.z, pose.heading, c.position.x, c.position.z);
  const dir = new THREE.Vector3();
  c.getWorldDirection(dir);
  const ld = worldToLocal(0, 0, pose.heading, dir.x, dir.z);
  return { x: l.x, y: c.position.y - pose.y, z: l.z, dx: ld.x, dz: ld.z, dy: dir.y };
}

function drive(view: 'rear' | 'front', kmh: number, spec = getVehicle('suv-x6'), opt: { accel?: number; pitch?: number } = {}) {
  const rig = new CameraRig();
  const dt = 1 / 60;
  const sgn = view === 'rear' ? -1 : 1;
  let v = kmh / 3.6;
  const pose = { x: 0, z: 0, heading: 0.4, y: 0, pitch: opt.pitch ?? 0 };
  rig.updateAssistCamera(dt, view, pose, spec, null);
  const samples: ReturnType<typeof localOffset>[] = [];
  for (let i = 0; i < 180; i++) {
    if (opt.accel) v = Math.max(0, v + opt.accel * dt);
    pose.x += Math.sin(pose.heading) * v * dt * sgn;
    pose.z += Math.cos(pose.heading) * v * dt * sgn;
    rig.updateAssistCamera(dt, view, pose, spec, null);
    if (i > 60) samples.push(localOffset(rig, pose));
  }
  return samples;
}

describe('후방/전방 카메라: 차량 기준 상대 좌표 안정성 (v0.4.7)', () => {
  for (const view of ['rear', 'front'] as const) {
    for (const kmh of [0, 1, 3, 5, 10]) {
      it(`${view} ${kmh}km/h: 카메라 로컬 위치/방향이 정지 상태와 같다`, () => {
        const ref = drive(view, 0)[0];
        for (const s of drive(view, kmh)) {
          expect(Math.abs(s.x - ref.x)).toBeLessThan(1e-4);
          expect(Math.abs(s.y - ref.y)).toBeLessThan(1e-4);
          expect(Math.abs(s.z - ref.z)).toBeLessThan(1e-4);
          expect(Math.abs(s.dx - ref.dx)).toBeLessThan(1e-4);
          expect(Math.abs(s.dz - ref.dz)).toBeLessThan(1e-4);
        }
      });
    }
  }
  it('가속 중에도 상대 위치가 일정하다', () => {
    const ref = drive('rear', 0)[0];
    for (const s of drive('rear', 0, getVehicle('suv-x6'), { accel: 1.5 })) expect(Math.abs(s.z - ref.z)).toBeLessThan(1e-4);
  });
});

describe('차체 고정 카메라 = 차량 모델 root 와 같은 변환 (경사로 포함)', () => {
  it('pitch/heading 이 있어도 mountedCamera 위치는 모델 root 에 붙인 자식 노드의 월드 위치와 같다', () => {
    const spec = getVehicle('suv-x6');
    for (const pitch of [0, 0.12, -0.18]) {
      const pose = { x: 3, z: -2, heading: 1.1, y: 4.2, pitch };
      const root = new THREE.Object3D();
      root.position.set(pose.x, pose.y, pose.z);
      root.rotation.order = 'YXZ';
      root.rotation.y = pose.heading;
      root.rotation.x = -pitch; // Game.render 와 동일
      const child = new THREE.Object3D();
      child.position.set(spec.rearCam.x, spec.rearCam.y, spec.rearCam.z);
      root.add(child);
      root.updateMatrixWorld(true);
      const w = new THREE.Vector3();
      child.getWorldPosition(w);
      const m = mountedCamera(pose, spec.rearCam, -1);
      expect(m.pos.distanceTo(w)).toBeLessThan(1e-9);
    }
  });
  it('경사로에서 이동 중에도 카메라-차체 상대 위치가 일정', () => {
    const ref = drive('rear', 0, getVehicle('suv-x6'), { pitch: 0.15 })[0];
    for (const s of drive('rear', 5, getVehicle('suv-x6'), { pitch: 0.15 })) {
      expect(Math.abs(s.z - ref.z)).toBeLessThan(1e-4);
      expect(Math.abs(s.y - ref.y)).toBeLessThan(1e-4);
    }
  });
});
