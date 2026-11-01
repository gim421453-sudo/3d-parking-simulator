import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { attachGlbScene } from '../src/vehicle/carModel';
import type { CarModel } from '../src/vehicle/carModel';

/** 노드 이름(Body, Wheel_FL ...)을 가진 박스 메시들로 구성된 최소 GLB 바이너리를 만든다. */
function buildTestGlb(): ArrayBuffer {
  // 단위 삼각형 하나를 모든 메시가 공유
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]); // 패딩 포함 8바이트
  const posBytes = positions.byteLength; // 36
  const idxBytes = indices.byteLength; // 8
  const bin = new Uint8Array(posBytes + idxBytes);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), posBytes);

  const names = ['Body', 'Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'CarRoot', children: [1, 2, 3, 4, 5] },
      ...names.map((n, i) => ({ name: n, mesh: 0, translation: i === 0 ? [0, 0, 0] : [i % 2 ? 0.8 : -0.8, 0.3, i < 3 ? 1.4 : -1.4] })),
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  new Uint8Array(out, 20, jsonBytes.length).set(jsonBytes);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true); // BIN
  new Uint8Array(out, o + 8, bin.length).set(bin);
  return out;
}

function emptyModel(): CarModel {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);
  bodyGroup.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); // 기존 프로시저럴 차체
  return {
    root, bodyGroup, cockpit: new THREE.Group(), steeringWheel: null, frontPivots: [], rollers: [],
    headSpot: null, highSpot: null, lights: null, setState: () => {}, dispose: () => {},
  };
}

describe('GLB 차량 모델 교체', () => {
  it('GLB 를 로드하고 Wheel_FL/FR/RL/RR 노드를 조향/회전 대상으로 연결한다', async () => {
    const glb = buildTestGlb();
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => new GLTFLoader().parse(glb, '', res as never, rej));
    const model = emptyModel();
    const ok = attachGlbScene(model, gltf.scene, 1, { x: 0, y: 0, z: 0 }, 0);
    expect(ok).toBe(true);
    expect(model.rollers.length).toBe(4);
    expect(model.frontPivots.length).toBe(2);
    // 기존 프로시저럴 차체가 제거되고 GLB 씬으로 교체됨
    expect(model.bodyGroup.children.length).toBe(1);
    expect(model.bodyGroup.children[0]).toBe(gltf.scene);
    // 앞바퀴 pivot 회전이 바퀴에 반영된다
    model.frontPivots[0].rotation.y = 0.5;
    expect(model.frontPivots[0].children[0].name).toMatch(/^Wheel_F/);
  });
});
