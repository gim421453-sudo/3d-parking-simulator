import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { disposeObject } from '../core/dispose';
import { MECH_LIMITS } from './limits';
import { STATION, bayOf, type MachineState } from './machine';

/**
 * 승강기식 기계식 주차장 3D 외형 (v0.5.0). 모든 모델/텍스처는 코드 생성(외부 에셋 없음).
 * 충돌/센서 데이터는 MapData(mapMechPark)가 가지고 있고, 여기서는 이동하는 팔레트·문·거울·프레임을 그린다.
 */
export interface MechBuilt {
  group: THREE.Group;
  /** 팔레트(차량 고정 기준 좌표계). 월드 y/z 이동은 update 에서 */
  pallet: THREE.Group;
  /** 홈 안 V자 리브 InstancedMesh (실제 3D 지오메트리) */
  ribs: THREE.InstancedMesh;
  ribCount: number;
  mirror: Reflector;
  /** 거울이 실제로 갱신(렌더)된 횟수 */
  mirrorRenders: number;
  update(m: MachineState, dt: number, camNearStation: boolean): void;
  dispose(): void;
}

function hazardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2c200';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#16181a';
  for (let i = -2; i < 4; i++) {
    const x = i * 32; // 줄무늬 폭 16, 주기 32 (노랑/검정 교대)
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 16, 64);
    g.lineTo(x + 48, 0);
    g.lineTo(x + 32, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildMech(opts: { mirrorSize: number; mirrorFps: number }): MechBuilt {
  const group = new THREE.Group();
  group.name = 'mech';
  const steel = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.55, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.8, metalness: 0.3 });
  const plate = new THREE.MeshStandardMaterial({ color: 0x5f6a74, roughness: 0.5, metalness: 0.5 });
  const ribMat = new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.35, metalness: 0.8 });
  const hz = hazardTexture();
  const hzLong = hz.clone();
  hzLong.repeat.set(7, 1);
  hzLong.needsUpdate = true;
  const hazard = new THREE.MeshStandardMaterial({ map: hzLong, roughness: 0.6, emissive: 0x2a2200, emissiveMap: hzLong });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = sy > 0.2;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const L = MECH_LIMITS.palletLength;
  const W = MECH_LIMITS.palletWidth;
  const gz = MECH_LIMITS.grooveOffset;
  const gh = MECH_LIMITS.grooveHalfWidth;
  const makePallet = (full: boolean): THREE.Group => {
    const p = new THREE.Group();
    // 상판: 중앙 / 바깥 가장자리 / 홈 바닥 (홈은 상판보다 0.05m 낮다)
    const topY = 0.03; // 바닥 면(y=0)보다 3cm 높게 올려 바닥에 묻히지(z-fighting) 않게 한다. 홈 바닥은 바닥면과 거의 같은 높이
    const inner = gz - gh; // 중앙 판 반폭
    const outer = gz + gh;
    add(p, box, plate, 0, topY - 0.05, 0, L, 0.1, 2 * inner); // 중앙 상판
    for (const s of [1, -1]) {
      add(p, box, dark, 0, topY - 0.0245, s * gz, L, 0.003, 2 * gh); // 홈 바닥 y≈0.006
      const edgeW = W / 2 - outer;
      add(p, box, plate, 0, topY - 0.05, s * (outer + edgeW / 2), L, 0.1, edgeW); // 바깥 판
    }
    if (!full) return p;
    // 사이드 가이드(노랑/검정 경고 줄무늬) — 충돌체(MapData 'guide')와 같은 치수
    for (const s of [1, -1]) {
      add(p, box, hazard, 0, 0.15, s * (W / 2 + 0.15), L, 0.3, 0.3);
    }
    // 진입 가장자리 경고 띠
    add(p, box, hazard, -L / 2 + 0.12, topY + 0.003, 0, 0.24, 0.012, W);
    // 앞바퀴 정지턱 (홈 안, 앞바퀴 앞면)
    const stopRel = STATION.stopperX - STATION.palletX + 0.28;
    for (const s of [1, -1]) {
      add(p, box, yellow, stopRel, 0.06, s * gz, 0.12, 0.1, 2 * gh);
    }
    return p;
  };

  const pallet = makePallet(true);
  pallet.position.set(STATION.palletX, 0, 0);
  group.add(pallet);

  // --- 홈 안 V자(∧∧∧) 리브: 얇은 막대 2개가 꼭짓점이 앞(+x)을 향하는 ∧ 모양 ---
  const pitch = 0.14;
  const grooveLen = L - 0.7;
  const n = Math.floor(grooveLen / pitch);
  const ribCount = n * 2 /*홈*/ * 2; /*막대*/
  const ribGeo = new THREE.BoxGeometry(0.2, 0.03, 0.028);
  const ribs = new THREE.InstancedMesh(ribGeo, ribMat, ribCount);
  const tmp = new THREE.Object3D();
  let idx = 0;
  const ang = (38 * Math.PI) / 180;
  for (const s of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const x = -grooveLen / 2 + i * pitch + 0.05;
      for (const side of [1, -1]) {
        // 꼭짓점(앞)이 중심선에 오도록 막대를 ±ang 회전
        tmp.position.set(x - 0.075 * Math.cos(ang), 0.006 + 0.015, s * gz + side * 0.075 * Math.sin(ang));
        tmp.rotation.set(0, -side * ang, 0);
        tmp.updateMatrix();
        ribs.setMatrixAt(idx++, tmp.matrix);
      }
    }
  }
  ribs.instanceMatrix.needsUpdate = true;
  ribs.receiveShadow = true;
  pallet.add(ribs);

  // --- 저장 베이의 빈 팔레트(정적) + 철골 프레임 ---
  const dummies = STATION.bays.map((b) => {
    const d = makePallet(false);
    d.position.set(STATION.palletX, b.y, b.z);
    group.add(d);
    return d;
  });
  const colH = 7.6;
  for (const s of [1, -1]) {
    for (const x of [-6.8, -2.5, 1.8]) {
      for (const z of [s * 1.85, s * 5.4]) add(group, box, steel, x, colH / 2, z, 0.25, colH, 0.25);
    }
    for (const y of [3, 6]) {
      for (const z of [s * 1.85, s * 5.4]) add(group, box, steel, -2.5, y - 0.12, z, 9, 0.2, 0.2);
      add(group, box, steel, -6.8, y - 0.12, s * 3.6, 0.2, 0.2, 3.7);
      add(group, box, steel, 1.8, y - 0.12, s * 3.6, 0.2, 0.2, 3.7);
    }
    add(group, box, steel, -2.5, colH, s * 3.6, 9, 0.2, 0.2);
  }
  // 승강로 상부 프레임 + 호이스트 레일
  add(group, box, steel, -2.5, colH, 0, 9, 0.25, 0.25);
  for (const x of [-6.8, 1.8]) add(group, box, steel, x, colH, 0, 0.25, 0.25, 3.7);

  // --- 출입문(롤업 셔터) + 안전 센서 + 상태등 ---
  const doorH = MECH_LIMITS.doorHeight;
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.6 });
  const door = add(group, box, doorMat, STATION.doorX, doorH / 2, 0, 0.12, doorH, MECH_LIMITS.doorWidth);
  add(group, box, steel, STATION.doorX, doorH + 0.15, 0, 0.3, 0.3, MECH_LIMITS.doorWidth + 0.7); // 상부 셔터 박스(문이 열리면 여기로 감김)
  const bottomBar = add(group, box, hazard, STATION.doorX, 0.06, 0, 0.14, 0.12, MECH_LIMITS.doorWidth);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x00ff66, emissive: 0x00c040, emissiveIntensity: 1.6 });
  const lamp = add(group, new THREE.SphereGeometry(0.1, 12, 8), lampMat, STATION.doorX - 0.3, doorH + 0.3, 0, 1, 1, 1);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 1.2 });
  for (const s of [1, -1]) for (const y of [0.35, 1.2]) add(group, box, eyeMat, STATION.doorX + 0.25, y, s * (MECH_LIMITS.doorWidth / 2 - 0.02), 0.06, 0.08, 0.04);

  // --- 전방 확인 거울: 실제 Three.js 반사(Reflector) — 가짜 이미지 아님. 근처에서만, 낮은 해상도/FPS 로 갱신 ---
  const mirrorW = 1.9;
  const mirrorH = 1.0;
  const mirror = new Reflector(new THREE.PlaneGeometry(mirrorW, mirrorH), {
    clipBias: 0.003,
    textureWidth: opts.mirrorSize,
    textureHeight: Math.round(opts.mirrorSize * (mirrorH / mirrorW)),
    color: 0xd0d8e0,
  });
  mirror.position.set(1.18, 1.35, 0);
  mirror.rotation.y = -Math.PI / 2; // 거울면이 -x(차량 쪽)를 향한다
  group.add(mirror);
  add(group, box, dark, 1.21, 1.35, 0, 0.04, mirrorH + 0.1, mirrorW + 0.1);

  let budget = 0;
  const built: MechBuilt = { group, pallet, ribs, ribCount, mirror, mirrorRenders: 0, update: () => {}, dispose: () => {} };
  const origBefore = mirror.onBeforeRender.bind(mirror);
  mirror.onBeforeRender = (renderer, scene, camera, geometry, material, g) => {
    const interval = opts.mirrorFps > 0 ? 1 / opts.mirrorFps : Infinity;
    if (budget < interval) return; // 갱신 간격 전에는 이전 프레임 텍스처를 재사용
    budget = 0;
    built.mirrorRenders++;
    origBefore(renderer, scene, camera, geometry, material, g);
  };

  built.update = (m, dt, near) => {
    budget += dt;
    pallet.position.y = m.palletY;
    pallet.position.z = m.palletZ;
    door.scale.y = Math.max(0.001, doorH * (1 - m.door));
    door.position.y = doorH - door.scale.y / 2;
    bottomBar.position.y = door.position.y - door.scale.y / 2 + 0.06;
    bottomBar.visible = m.door < 0.98;
    const open = m.door > 0.95;
    lampMat.color.setHex(open ? 0x00ff66 : 0xff3030);
    lampMat.emissive.setHex(open ? 0x00c040 : 0xd02020);
    lamp.visible = true;
    // 거울은 승강장 근처에 있을 때만 렌더 (모바일 부하 절감). 숨기면 렌더 자체가 일어나지 않는다
    mirror.visible = near && m.phase !== 'toBay' && m.phase !== 'stored' && m.phase !== 'fromBay';
    dummies.forEach((d, i) => {
      const b = bayOf(STATION.bays[i].id);
      d.visible = !(Math.abs(m.palletY - b.y) < 0.02 && Math.abs(m.palletZ - b.z) < 0.02);
    });
  };
  built.dispose = () => {
    mirror.getRenderTarget().dispose();
    disposeObject(group);
    hz.dispose();
    hzLong.dispose();
  };
  return built;
}
