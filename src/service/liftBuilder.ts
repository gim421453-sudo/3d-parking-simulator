import * as THREE from 'three';
import { disposeObject } from '../core/dispose';
import { LIFT4_DEFAULT, LIFT_DEFAULT, type LiftConfig, type LiftState } from './lift';

/** 2주식 리프트 3D 모델: 기둥 2개는 맵 충돌체(mapBuilder)가 그리고, 여기서는 캐리지/스윙 암/패드/바닥판/상부 보를 그린다(로컬 좌표 → 그룹 변환) */
export interface LiftBuilt {
  group: THREE.Group;
  /** 디버그/테스트: 캐리지 높이, 암 각도 */
  carriageY: number;
  armAngle: number;
  update(s: LiftState): void;
  dispose(): void;
}

export function buildLift(cfg: LiftConfig): LiftBuilt {
  const group = new THREE.Group();
  group.name = `Lift_${cfg.id}`;
  group.position.set(cfg.x, 0, cfg.z);
  group.rotation.y = cfg.heading;
  const steel = new THREE.MeshStandardMaterial({ color: 0x2f5fb8, roughness: 0.5, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.7, metalness: 0.3 });
  const pad = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.95 });
  const warn = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const add = (parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh => {
    const m = new THREE.Mesh(box, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  if (cfg.kind === '4post') {
    // 4주식: 주행판 2개 + 앞뒤 가로보가 한 덩어리(platform)로 승강한다. 기둥 4개는 맵 충돌체가 그린다. 고임목은 arms 값으로 올라온다
    const D = LIFT4_DEFAULT;
    const platform = new THREE.Group();
    group.add(platform);
    for (const sx of [-1, 1]) {
      add(platform, steel, sx * D.runwayX, -0.05, 0, D.runwayW, 0.1, D.runwayL); // 주행판(윗면 = 바닥 높이)
      add(platform, warn, sx * (D.runwayX + D.runwayW / 2 - 0.03), 0.005, 0, 0.05, 0.012, D.runwayL); // 가장자리 표시
    }
    for (const sz of [-1, 1]) add(platform, dark, 0, -0.14, sz * D.postZ, cfg.postHalf * 2 - 0.1, 0.16, 0.2); // 가로보
    const chocks: THREE.Mesh[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) chocks.push(add(platform, pad, sx * D.runwayX, -0.06, sz * (D.runwayL / 2 - 0.25), D.runwayW - 0.08, 0.1, 0.14));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(group, dark, sx * cfg.postHalf, 0.015, sz * D.postZ, 0.5, 0.03, 0.5); // 기둥 바닥판
    const built4: LiftBuilt = {
      group,
      carriageY: 0,
      armAngle: 0,
      update(s) {
        platform.position.y = s.h;
        for (const c of chocks) c.position.y = -0.06 + 0.12 * s.arms; // 고임목이 주행판 위로 올라와 바퀴를 막는다
        built4.carriageY = s.h;
        built4.armAngle = s.arms;
      },
      dispose() {
        disposeObject(group);
      },
    };
    return built4;
  }
  const H = LIFT_DEFAULT.postHeight;
  // 바닥판 + 상부 연결 보(케이블 덮개)
  for (const sx of [-1, 1]) add(group, dark, sx * cfg.postHalf, 0.015, 0, 0.7, 0.03, 0.9);
  add(group, steel, 0, H + 0.1, 0, cfg.postHalf * 2 + 0.3, 0.16, 0.22);
  add(group, warn, 0, 0.012, 0, cfg.postHalf * 2 - 0.9, 0.02, 0.12); // 바닥 중심 표시
  // 캐리지(기둥을 따라 승강) + 스윙 암 4개
  const carriages: THREE.Group[] = [];
  const arms: { pivot: THREE.Group; open: number; closed: number }[] = [];
  const ARM = 1.05;
  for (const sx of [-1, 1]) {
    const c = new THREE.Group();
    c.position.set(sx * (cfg.postHalf - 0.22), 0.14, 0);
    group.add(c);
    carriages.push(c);
    add(c, steel, 0, 0.1, 0, 0.16, 0.36, 0.5);
    for (const sz of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(-sx * 0.02, 0, sz * 0.2);
      c.add(pivot);
      // 암은 pivot 의 로컬 +z 방향으로 뻗는다. 벌어짐(open): 진입로와 평행(앞/뒤로) → 차량이 지나갈 수 있다. 닫힘(closed): 안쪽 대각선으로 차체 아래
      add(pivot, steel, 0, 0, ARM / 2, 0.1, 0.08, ARM);
      add(pivot, pad, 0, 0.06, ARM - 0.06, 0.16, 0.05, 0.16);
      const open = sz > 0 ? 0 : Math.PI;
      const closed = sz > 0 ? -sx * 0.95 : Math.PI + sx * 0.95;
      pivot.rotation.y = open;
      arms.push({ pivot, open, closed });
    }
  }
  const built: LiftBuilt = {
    group,
    carriageY: 0.14,
    armAngle: 0,
    update(s) {
      const y = 0.14 + s.h;
      for (const c of carriages) c.position.y = y;
      for (const a of arms) a.pivot.rotation.y = a.open + (a.closed - a.open) * s.arms;
      built.carriageY = y;
      built.armAngle = s.arms;
    },
    dispose() {
      disposeObject(group);
    },
  };
  return built;
}
