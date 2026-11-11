import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { disposeObject } from '../core/dispose';
import { MECH_LIMITS } from './limits';
import { FLOOR_H, SLOTS, SLOT_Z, STATION, TOP_FLOOR, floorY, statusBoard, type Guidance, type MachineState } from './machine';
import { BOLLARDS, BOLLARD_H, BOLLARD_R } from '../maps/mapMechPark';

/**
 * 승강기식 기계식 주차장 3D 외형 (v0.5.0). 모든 모델/텍스처는 코드 생성(외부 에셋 없음).
 * 충돌/센서 데이터는 MapData(mapMechPark)가 가지고 있고, 여기서는 이동하는 팔레트·문·거울·프레임을 그린다.
 */
export interface MechBuilt {
  group: THREE.Group;
  /** 승강장 팔레트(차량 지지, 캐리지와 별개). 팔레트 로컬 좌표 = 차량 고정 기준 */
  pallet: THREE.Group;
  /** 승강 캐리지(플랫폼) — 4개 모서리 기둥의 가이드 레일을 따라 y 로 움직인다 */
  carriage: THREE.Group;
  /** 슬롯별 보관 팔레트 (점유 시에만 보임) */
  slotPallets: Map<string, THREE.Group>;
  /** 홈 안 V자 리브 InstancedMesh (실제 3D 지오메트리) */
  ribs: THREE.InstancedMesh;
  ribCount: number;
  mirror: Reflector;
  /** 거울이 실제로 갱신(렌더)된 횟수 */
  mirrorRenders: number;
  /** 입구 안내 표시기(거울 옆)/셔터 상단 상태 LED 에 마지막으로 그려진 상태(테스트/디버그) */
  signState: string;
  signDraws: number;
  statusState: string;
  statusDraws: number;
  bollards: THREE.InstancedMesh;
  /** 승강 구조 (테스트용): 모서리 기둥/가이드 레일 */
  columns: THREE.Object3D[];
  rails: THREE.Object3D[];
  /** 세계 좌표로 본 제어반 위치 */
  panelPos: THREE.Vector3;
  update(m: MachineState, dt: number, camNearStation: boolean, guide?: Guidance): void;
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


/** 작은 CanvasTexture 표지판 도우미 */
function makeBoard(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, g, tex };
}

export function buildMech(opts: { mirrorSize: number; mirrorFps: number }): MechBuilt {
  const group = new THREE.Group();
  group.name = 'mech';
  const steel = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.55, metalness: 0.5 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x4d535a, roughness: 0.6, metalness: 0.5 });
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
  const stoppers: THREE.Mesh[] = [];
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
  const GUIDE_H = 0.12; // v0.5.2: 낮은 가이드(타이어가 타고 넘을 수 있는 높이, 지상고 0.2m 아래). 충돌체와 같은 값
  const makePallet = (full: boolean): THREE.Group => {
    const p = new THREE.Group();
    const topY = 0.03; // 바닥 면(y=0)보다 3cm 높게 올려 z-fighting 을 피한다. 홈 바닥은 바닥면과 거의 같은 높이
    const inner = gz - gh;
    const outer = gz + gh;
    add(p, box, plate, 0, topY - 0.05, 0, L, 0.1, 2 * inner);
    for (const s of [1, -1]) {
      add(p, box, dark, 0, topY - 0.0245, s * gz, L, 0.003, 2 * gh);
      const edgeW = W / 2 - outer;
      add(p, box, plate, 0, topY - 0.05, s * (outer + edgeW / 2), L, 0.1, edgeW);
    }
    if (!full) {
      for (const s of [1, -1]) add(p, box, hazard, 0, GUIDE_H / 2, s * (W / 2 + 0.15), L, GUIDE_H, 0.3);
      return p;
    }
    for (const s of [1, -1]) add(p, box, hazard, 0, GUIDE_H / 2, s * (W / 2 + 0.15), L, GUIDE_H, 0.3);
    add(p, box, whiteMat, 0, topY + 0.002, 0, L - 0.8, 0.004, 0.06);
    add(p, box, whiteMat, STATION.stopperX - STATION.palletX - 0.06, topY + 0.002, 0, 0.06, 0.004, 2 * (gz - gh) - 0.05);
    add(p, box, hazard, -L / 2 + 0.12, topY + 0.003, 0, 0.24, 0.012, W);
    // 낮은 정지턱(약 6cm, 저속에서 타고 넘는다): 홈 안, 기준 차축 안착 홈 바로 앞
    const stopRel = STATION.stopperX - STATION.palletX + 0.2;
    for (const s of [1, -1]) stoppers.push(add(p, box, yellow, stopRel, 0.04, s * gz, 0.1, 0.06, 2 * gh));
    return p;
  };

  // --- 승강장 팔레트 + V자(∧∧∧) 리브 ---
  const pallet = makePallet(true);
  pallet.position.set(STATION.palletX, 0, 0);
  group.add(pallet);
  const pitch = 0.14;
  const grooveLen = L - 0.7;
  const n = Math.floor(grooveLen / pitch);
  const ribCount = n * 2 * 2;
  const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.03, 0.028), ribMat, ribCount);
  const tmp = new THREE.Object3D();
  let idx = 0;
  const ang = (38 * Math.PI) / 180;
  for (const s of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const x = -grooveLen / 2 + i * pitch + 0.05;
      for (const side of [1, -1]) {
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

  // --- 승강 구조: 4개 모서리 기둥 + 수직 가이드 레일 + 층별 슬롯 레일/보 (팔레트 정중앙을 지나는 기둥 없음) ---
  const TOWER_H = floorY(TOP_FLOOR) + 4.2;
  const colX = [STATION.palletX - L / 2 - 0.75, STATION.palletX + L / 2 + 0.75]; // 팔레트 길이 양끝 바깥
  const colZ = 2.15; // 캐리지 모서리(승강로) — 슬롯(z=±3.6)로 이송하는 팔레트는 기둥 사이(x 방향 끝)를 지나지 않고 옆으로 빠진다
  const columns: THREE.Object3D[] = [];
  const rails: THREE.Object3D[] = [];
  for (const x of colX) {
    for (const z of [-colZ, colZ]) {
      const c = add(group, box, steelDark, x, TOWER_H / 2, z, 0.32, TOWER_H, 0.32);
      columns.push(c);
      // 수직 가이드 레일 (기둥 안쪽 면): 캐리지 러너가 물려 올라간다
      const r = add(group, box, ribMat, x + (x < STATION.palletX ? 0.19 : -0.19), TOWER_H / 2, z, 0.06, TOWER_H, 0.12);
      rails.push(r);
    }
  }
  // 바깥 랙 기둥(슬롯 바깥쪽 모서리, 4개) — 슬롯 팔레트 길이 양끝 바깥
  for (const x of colX) for (const z of [-5.9, 5.9]) add(group, box, steelDark, x, TOWER_H / 2, z, 0.32, TOWER_H, 0.32);
  // 층별 구조: 슬롯 레일(팔레트 아래 2개 × 슬롯 2개) + 길이 방향 보(기둥 연결) — InstancedMesh
  const floors = TOP_FLOOR - 1;
  const railInst = new THREE.InstancedMesh(box, steel, floors * 2 * 2);
  const beamInst = new THREE.InstancedMesh(box, steelDark, floors * 4);
  let ri = 0;
  let bi = 0;
  const m4 = new THREE.Object3D();
  const put = (im: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    m4.position.set(x, y, z);
    m4.scale.set(sx, sy, sz);
    m4.updateMatrix();
    im.setMatrixAt(i, m4.matrix);
  };
  for (let f = 2; f <= TOP_FLOOR; f++) {
    const y = floorY(f);
    for (const side of [1, -1]) {
      const zc = side * SLOT_Z;
      // 슬롯 레일: 팔레트 양 가장자리 아래, 팔레트 길이 방향
      for (const dz of [-0.9, 0.9]) put(railInst, ri++, STATION.palletX, y - 0.14, zc + dz, L + 0.4, 0.12, 0.14);
      // 보: 안쪽 기둥(z=±colZ) ↔ 바깥 기둥(z=±5.9), 양 끝 x
      for (const x of colX) put(beamInst, bi++, x, y - 0.14, side * ((colZ + 5.9) / 2), 0.22, 0.24, 5.9 - colZ);
    }
  }
  railInst.instanceMatrix.needsUpdate = true;
  beamInst.instanceMatrix.needsUpdate = true;
  group.add(railInst, beamInst);
  // 상단 연결 프레임 + 하부 지지판
  for (const z of [-colZ, colZ, -5.9, 5.9]) add(group, box, steelDark, STATION.palletX, TOWER_H, z, colX[1] - colX[0], 0.3, 0.3);
  for (const x of colX) add(group, box, steelDark, x, TOWER_H, 0, 0.3, 0.3, 11.8);

  // --- 승강 캐리지(플랫폼): 팔레트 아래를 받치는 프레임 + 모서리 러너(가이드 레일에 물림) + 수평 이송 셔틀 ---
  const carriage = new THREE.Group();
  carriage.position.set(STATION.palletX, 0, 0);
  group.add(carriage);
  add(carriage, box, steel, 0, -0.16, 0, L + 0.3, 0.12, 2 * colZ - 0.4); // 바닥 프레임
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(carriage, box, hazard, sx * (colX[1] - STATION.palletX - 0.45), -0.1, sz * (colZ - 0.2), 0.2, 0.22, 0.2); // 러너
  for (const sz of [-1, 1]) add(carriage, box, steelDark, 0, -0.1, sz * (colZ - 0.2), L + 0.3, 0.14, 0.18);
  const shuttle = add(carriage, box, yellow, 0, -0.06, 0, L - 0.2, 0.05, 0.34); // 수평 이송 셔틀(팔레트를 밀고 당긴다)

  // --- 슬롯별 보관 팔레트(점유 시에만 보임): 22개 ---
  const slotPallets = new Map<string, THREE.Group>();
  for (const sd of SLOTS) {
    const sp = makePallet(false);
    sp.position.set(STATION.palletX, sd.y, sd.z);
    sp.visible = false;
    group.add(sp);
    slotPallets.set(sd.id, sp);
  }

  // --- 출입문(롤업 셔터) + 안전 센서 + 상태등 ---
  const doorH = MECH_LIMITS.doorHeight;
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.6 });
  const door = add(group, box, doorMat, STATION.doorX, doorH / 2, 0, 0.12, doorH, MECH_LIMITS.doorWidth);
  add(group, box, steel, STATION.doorX, doorH + 0.15, 0, 0.3, 0.3, MECH_LIMITS.doorWidth + 0.7);
  const bottomBar = add(group, box, hazard, STATION.doorX, 0.06, 0, 0.14, 0.12, MECH_LIMITS.doorWidth);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x00ff66, emissive: 0x00c040, emissiveIntensity: 1.6 });
  add(group, new THREE.SphereGeometry(0.1, 12, 8), lampMat, STATION.doorX - 0.3, doorH + 0.5, 1.5, 1, 1, 1);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 1.2 });
  for (const s of [1, -1]) for (const y of [0.35, 1.2]) add(group, box, eyeMat, STATION.doorX + 0.25, y, s * (MECH_LIMITS.doorWidth / 2 - 0.02), 0.06, 0.08, 0.04);

  // --- 셔터 상단 정중앙: 기계식 주차장 작동 상태 전용 LED 안내판 (입고 가능/입고 중/승강 중/출고 중/복귀 중/금지/비상/오류) ---
  const stBoard = makeBoard(768, 192);
  const stMat = new THREE.MeshBasicMaterial({ map: stBoard.tex, toneMapped: false });
  const stMesh = add(group, new THREE.PlaneGeometry(1, 1), stMat, STATION.doorX - 0.4, doorH + 0.85, 0, 3.4, 0.85, 1);
  stMesh.rotation.y = -Math.PI / 2;
  stMesh.castShadow = false;
  add(group, box, dark, STATION.doorX - 0.34, doorH + 0.85, 0, 0.1, 0.95, 3.5); // 뒷판
  const COL: Record<string, string> = { ready: '#37ff7a', storing: '#ffb020', lifting: '#4da3ff', retrieving: '#c78bff', returning: '#7be0ff', blocked: '#ff3b30', estop: '#ff3b30', fault: '#ff3b30' };
  const drawStatus = (kind: string, text: string, blink: boolean): void => {
    const g = stBoard.g;
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, 768, 192);
    g.strokeStyle = '#1b2430';
    g.lineWidth = 6;
    g.strokeRect(6, 6, 756, 180);
    const c = COL[kind] ?? '#ffffff';
    g.fillStyle = blink ? '#552020' : c;
    g.shadowColor = c;
    g.shadowBlur = blink ? 0 : 22;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${text.length > 12 ? 62 : 78}px "Noto Sans KR","Malgun Gothic",sans-serif`;
    g.fillText(text, 384, 100);
    g.shadowBlur = 0;
    stBoard.tex.needsUpdate = true;
  };

  // --- 전방 확인 거울(뒷벽) + 그 바로 옆의 입구 정렬 안내판(전진/정지/후진) ---
  const mirrorW = 1.9;
  const mirrorH = 1.0;
  const mirror = new Reflector(new THREE.PlaneGeometry(mirrorW, mirrorH), {
    clipBias: 0.003,
    textureWidth: opts.mirrorSize,
    textureHeight: Math.round(opts.mirrorSize * (mirrorH / mirrorW)),
    color: 0xd0d8e0,
  });
  mirror.position.set(1.18, 1.35, 0.35);
  mirror.rotation.y = -Math.PI / 2;
  group.add(mirror);
  add(group, box, dark, 1.21, 1.35, 0.35, 0.04, mirrorH + 0.1, mirrorW + 0.1);
  const sc = makeBoard(512, 320);
  const smat = new THREE.MeshBasicMaterial({ map: sc.tex, toneMapped: false });
  const SIGN_Z = 0.35 - mirrorW / 2 - 0.1 - 0.55; // 거울 바로 옆(왼쪽 끝에 붙음)
  const sign = add(group, new THREE.PlaneGeometry(1, 1), smat, 1.15, 1.35, SIGN_Z, 1.1, 0.6875, 1);
  sign.rotation.y = -Math.PI / 2;
  sign.castShadow = false;
  add(group, box, dark, 1.19, 1.35, SIGN_Z, 0.04, 0.78, 1.2);
  const drawSign = (g: Guidance): void => {
    const c = sc.g;
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, 512, 320);
    const rows = [
      { label: '전진', on: '#37ff7a', off: '#0c2a17', y: 8, active: g.state === 'forward' },
      { label: '정지', on: '#ff3b30', off: '#33100e', y: 112, active: g.state === 'stop' },
      { label: '후진', on: '#ffb020', off: '#33250a', y: 216, active: g.state === 'back' },
    ];
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold 86px "Noto Sans KR","Malgun Gothic",sans-serif';
    for (const r of rows) {
      c.fillStyle = r.active ? r.on : r.off;
      if (r.active) {
        c.shadowColor = r.on;
        c.shadowBlur = 28;
      }
      c.fillText(r.label, 256, r.y + 48);
      c.shadowBlur = 0;
    }
    if (g.state === 'align' || g.state === 'blocked') {
      c.fillStyle = 'rgba(5,7,10,0.88)';
      c.fillRect(0, 100, 512, 120);
      c.fillStyle = g.state === 'blocked' ? '#ff3b30' : '#ffb020';
      c.shadowColor = c.fillStyle;
      c.shadowBlur = 24;
      const arrow = g.steer === 'left' ? '◀ ' : g.steer === 'right' ? ' ▶' : '';
      c.font = 'bold 74px "Noto Sans KR","Malgun Gothic",sans-serif';
      c.fillText(g.steer === 'right' ? g.text + arrow : arrow + g.text, 256, 160);
      c.shadowBlur = 0;
    }
    sc.tex.needsUpdate = true;
  };
  drawSign({ state: 'blocked', text: '', steer: null, mode: 'fwd' });
  drawStatus('blocked', '입출고 금지', false);

  // --- 셔터 옆 제어반(제어함): 입구 오른쪽(+z) 바깥 벽, 운전자가 내려서 접근 ---
  const panelPos = new THREE.Vector3(STATION.doorX - 0.9, 0, -(MECH_LIMITS.doorWidth / 2 + 0.75));
  const cab = new THREE.Group();
  cab.position.copy(panelPos);
  group.add(cab);
  add(cab, box, steelDark, 0, 0.55, 0, 0.45, 1.1, 0.7); // 함체
  add(cab, box, steel, 0, 1.12, 0, 0.5, 0.06, 0.75); // 지붕
  const scrBoard = makeBoard(256, 160);
  const scrMat = new THREE.MeshBasicMaterial({ map: scrBoard.tex, toneMapped: false });
  const scr = add(cab, new THREE.PlaneGeometry(1, 1), scrMat, -0.232, 0.82, 0, 0.5, 0.3, 1);
  scr.rotation.y = -Math.PI / 2;
  scrBoard.g.fillStyle = '#04141f';
  scrBoard.g.fillRect(0, 0, 256, 160);
  scrBoard.g.fillStyle = '#7bd0ff';
  scrBoard.g.font = 'bold 28px "Noto Sans KR","Malgun Gothic",sans-serif';
  scrBoard.g.textAlign = 'center';
  scrBoard.g.fillText('기계식 주차 제어반', 128, 40);
  scrBoard.g.font = '22px "Noto Sans KR","Malgun Gothic",sans-serif';
  scrBoard.g.fillText('층 · 슬롯 선택 / 입고 · 출고', 128, 90);
  scrBoard.g.fillText('비상 정지', 128, 130);
  scrBoard.tex.needsUpdate = true;
  const btnMat = [0x37c871, 0xffb020, 0xe5372f].map((c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6 }));
  btnMat.forEach((mt, i) => add(cab, box, mt, -0.235, 0.52, -0.2 + i * 0.2, 0.03, 0.09, 0.12));

  // --- 입구 금속 볼라드: 강철 원통 + 노랑 반사띠 (충돌체/센서 감지는 MapData 'bollard') ---
  const bolMat = new THREE.MeshStandardMaterial({ color: 0xc3cad1, roughness: 0.38, metalness: 0.45 });
  const bollards = new THREE.InstancedMesh(new THREE.CylinderGeometry(BOLLARD_R, BOLLARD_R, BOLLARD_H, 20), bolMat, BOLLARDS.length);
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.4, emissive: 0x3a2e00 });
  const bands = new THREE.InstancedMesh(new THREE.CylinderGeometry(BOLLARD_R + 0.004, BOLLARD_R + 0.004, 0.14, 20), bandMat, BOLLARDS.length * 2);
  const bm = new THREE.Object3D();
  BOLLARDS.forEach((b, i) => {
    bm.position.set(b.x, BOLLARD_H / 2, b.z);
    bm.updateMatrix();
    bollards.setMatrixAt(i, bm.matrix);
    for (let k = 0; k < 2; k++) {
      bm.position.set(b.x, BOLLARD_H - 0.14 - k * 0.24, b.z);
      bm.updateMatrix();
      bands.setMatrixAt(i * 2 + k, bm.matrix);
    }
    const base = add(group, new THREE.CylinderGeometry(BOLLARD_R + 0.07, BOLLARD_R + 0.07, 0.03, 20), bolMat, b.x, 0.015, b.z, 1, 1, 1);
    base.castShadow = false;
  });
  bollards.castShadow = true;
  group.add(bollards, bands);

  let budget = 0;
  const built: MechBuilt = { group, pallet, carriage, slotPallets, ribs, ribCount, mirror, mirrorRenders: 0, signState: '', signDraws: 0, statusState: '', statusDraws: 0, bollards, columns, rails, panelPos, update: () => {}, dispose: () => {} };
  const origBefore = mirror.onBeforeRender.bind(mirror);
  mirror.onBeforeRender = (renderer, scene, camera, geometry, material, g) => {
    const interval = opts.mirrorFps > 0 ? 1 / opts.mirrorFps : Infinity;
    if (budget < interval - 1e-3) return; // 부동소수 오차로 한 프레임 건너뛰어 FPS 가 절반이 되는 것을 방지
    budget = Math.min(budget - interval, interval); // 잔여 시간을 유지해 목표 FPS 에 정확히 맞춘다
    built.mirrorRenders++;
    origBefore(renderer, scene, camera, geometry, material, g);
  };

  built.update = (m, dt, near, guide) => {
    budget += dt;
    // 캐리지는 y 로 승강(가이드 레일을 따라), 팔레트는 캐리지 위(또는 슬롯)에 있다
    carriage.position.y = m.carriage.y;
    shuttle.position.z = m.carriage.z;
    pallet.visible = m.palletLoc === 'station' || m.palletLoc === 'carriage';
    pallet.position.set(STATION.palletX, m.carriage.y, m.carriage.z);
    pallet.rotation.y = m.yaw; // 턴테이블: 팔레트(와 고정된 차량)가 함께 회전
    for (const st of stoppers) st.visible = m.yaw < 0.1;
    for (const [id, sp] of slotPallets) sp.visible = !!m.slots[id];
    // 문
    door.scale.y = Math.max(0.001, doorH * (1 - m.door));
    door.position.y = doorH - door.scale.y / 2;
    bottomBar.position.y = door.position.y - door.scale.y / 2 + 0.06;
    bottomBar.visible = m.door < 0.98;
    const open = m.door > 0.95;
    lampMat.color.setHex(open ? 0x00ff66 : 0xff3030);
    lampMat.emissive.setHex(open ? 0x00c040 : 0xd02020);
    mirror.visible = near && (m.phase === 'waiting' || m.phase === 'closing' || m.phase === 'exit' || m.phase === 'opening');
    if (guide) {
      const key = `${guide.state}|${guide.text}`;
      if (key !== built.signState) {
        built.signState = key;
        built.signDraws++;
        drawSign(guide);
      }
    }
    // 셔터 상단 작동 상태 LED: 상태기계에서만 결정 (비상정지는 깜박임)
    const sb = statusBoard(m);
    const blink = (sb.kind === 'estop' || sb.kind === 'fault') && Math.floor(m.clock * 2) % 2 === 0;
    const key = `${sb.kind}|${sb.text}|${blink ? 1 : 0}`;
    if (key !== built.statusState) {
      built.statusState = key;
      built.statusDraws++;
      drawStatus(sb.kind, sb.text, blink);
    }
  };
  built.dispose = () => {
    mirror.getRenderTarget().dispose();
    sc.tex.dispose();
    stBoard.tex.dispose();
    scrBoard.tex.dispose();
    disposeObject(group);
    hz.dispose();
    hzLong.dispose();
  };
  return built;
}

void FLOOR_H;
