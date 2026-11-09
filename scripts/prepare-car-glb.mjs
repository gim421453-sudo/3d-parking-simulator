/**
 * Khronos "Car Concept" (CC-BY-4.0, 원본: Unity Fan 의 CC0 "Free Concept Car 004") → 게임용 경량 GLB 변환.
 * 사용: node prepare-car-glb.mjs <in.glb> <out.glb>   (의존: @gltf-transform/core,extensions,functions, meshoptimizer, sharp — 저장소에 포함하지 않는 로컬 도구)
 * 변경 내역(CC-BY 변경 고지): 실내/엔진/와이퍼/번호판 노드 제거, 바퀴 노드를 Wheel_FL/FR/RL/RR 로 재구성(피벗=바퀴 중심),
 * 램프 재질을 Lamp_* 규약으로 개명(후미 방향지시등은 좌/우 분리), 유리 transmission/iridescence 제거, 메시 단순화, 텍스처 1024 이하 WebP.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, simplify, prune, dedup, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mat3, mat4, quat, vec3 } from 'gl-matrix';

const [, , inP, outP] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inP);
const root = doc.getRoot();
const byName = (n) => root.listNodes().find((x) => x.getName() === n);

// 1) 제거할 노드 (실내/엔진/와이퍼/번호판/후드 안쪽) — 게임이 자체 코크핏·번호판을 쓴다
const drop = /^(Interior|Engine|BodyHoodInterior|BodyHoodUnder|BodyWindshieldWipers|License Plate|Axles)/;
for (const n of root.listNodes()) if (drop.test(n.getName())) n.dispose();

// 2) 유리 transmission/iridescence/variants 제거 → 단순 알파 블렌드(모바일 성능)
for (const mat of root.listMaterials()) {
  if (mat.getName() === 'Glass') {
    mat.setExtension('KHR_materials_transmission', null);
    mat.setAlphaMode('BLEND').setBaseColorFactor([0.04, 0.06, 0.08, 0.38]).setRoughnessFactor(0.06).setMetallicFactor(0.2);
  }
  mat.setExtension('KHR_materials_iridescence', null);
}
for (const e of root.listExtensionsUsed()) if (e.extensionName === 'KHR_materials_variants') e.dispose();

// 3) 램프 재질 규약
const rename = { Headlight: 'Lamp_Head', Brakelight: 'Lamp_Tail' };
for (const mat of root.listMaterials()) if (rename[mat.getName()]) mat.setName(rename[mat.getName()]);
// 후미 방향지시등: 한 메시를 좌/우 삼각형으로 분리
for (const n of root.listNodes()) {
  const mesh = n.getMesh();
  if (!mesh) continue;
  for (const p of mesh.listPrimitives()) {
    if (p.getMaterial()?.getName() !== 'Signallight') continue;
    const pos = p.getAttribute('POSITION');
    const idx = p.getIndices();
    const L = [], R = [];
    for (let i = 0; i < idx.getCount(); i += 3) {
      const a = idx.getScalar(i), b = idx.getScalar(i + 1), c = idx.getScalar(i + 2);
      const x = (pos.getElement(a, [])[0] + pos.getElement(b, [])[0] + pos.getElement(c, [])[0]) / 3;
      (x >= 0 ? L : R).push(a, b, c);
    }
    const mk = (arr, name) => {
      const q = doc.createPrimitive().setMode(p.getMode());
      for (const sem of p.listSemantics()) q.setAttribute(sem, p.getAttribute(sem));
      q.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(arr)).setBuffer(root.listBuffers()[0]));
      q.setMaterial(p.getMaterial().clone().setName(name));
      mesh.addPrimitive(q);
    };
    mk(L, 'Lamp_SigL');
    mk(R, 'Lamp_SigR');
    mesh.removePrimitive(p);
  }
}

// 4) 좌표 정리: 루트(BodyUnderside)의 Blender(Z-up) 변환 행렬을 정점/자식에 굽는다 → 루트 항등, glTF Y-up
const rootNode = root.listScenes()[0].listChildren()[0];
const M = rootNode.getMatrix();
{
  const rm = rootNode.getMesh();
  if (rm) for (const prim of rm.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); const o = vec3.transformMat4([0, 0, 0], v, M); pos.setElement(i, o); }
    const nor = prim.getAttribute('NORMAL');
    if (nor) { const nm = mat3.normalFromMat4(mat3.create(), M); for (let i = 0; i < nor.getCount(); i++) { nor.getElement(i, v); const o = vec3.transformMat3([0, 0, 0], v, nm); vec3.normalize(o, o); nor.setElement(i, o); } }
    const tan = prim.getAttribute('TANGENT');
    if (tan) { const t4 = [0, 0, 0, 0]; for (let i = 0; i < tan.getCount(); i++) { tan.getElement(i, t4); const o = vec3.transformMat4([0, 0, 0], [t4[0], t4[1], t4[2]], mat4.fromValues(M[0], M[1], M[2], 0, M[4], M[5], M[6], 0, M[8], M[9], M[10], 0, 0, 0, 0, 1)); tan.setElement(i, [o[0], o[1], o[2], t4[3]]); } }
  }
  for (const ch of rootNode.listChildren()) ch.setMatrix(mat4.multiply(mat4.create(), M, ch.getMatrix()));
  rootNode.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
}

// 5) 바퀴: 노드 이름 규약 + 앞바퀴가 모델에서 돌아간 채(약 30° 조향 포즈)로 저장돼 있어 축을 차체 X 방향으로 되돌린다(조향은 게임이 한다)
const wmap = { WheelFrontL: 'Wheel_FL', WheelFrontR: 'Wheel_FR', WheelRearL: 'Wheel_RL', WheelRearR: 'Wheel_RR' };
const wheelInfo = {};
for (const [old, nn] of Object.entries(wmap)) {
  const w = byName(old);
  const m = w.getMatrix();
  const t = [m[12], m[13], m[14]];
  const q = quat.create();
  mat4.getRotation(q, m);
  // 현재 바퀴 축(로컬 +X)의 월드 방향
  const axle = vec3.transformQuat([0, 0, 0], [1, 0, 0], q);
  const sign = axle[0] >= 0 ? 1 : -1;
  const ang = Math.atan2(axle[2], axle[0] * sign); // xz 평면에서 X(부호 포함)로부터의 편차
  const fix = quat.setAxisAngle(quat.create(), [0, 1, 0], ang);
  const q2 = quat.multiply(quat.create(), fix, q);
  w.setName(nn).setTranslation(t).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]); // 메시 로컬 X 가 바퀴 축이므로 항등 회전(스핀 각도는 게임이 roll 로 제어)
  const ax2 = vec3.transformQuat([0, 0, 0], [1, 0, 0], q2);
  // 타이어(이름 없는 자식) 반지름/폭
  let r = 0, wd = 0;
  for (const ch of w.listChildren()) {
    const mesh = ch.getMesh();
    if (!mesh || ch.getName()) continue;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const prim of mesh.listPrimitives()) { const pos = prim.getAttribute('POSITION'); const v = [0, 0, 0]; for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); } } }
    wd = mx[0] - mn[0]; r = (mx[1] - mn[1]) / 2;
  }
  wheelInfo[nn] = { center: t.map((v) => +v.toFixed(3)), axleBefore: axle.map((v) => +v.toFixed(2)), axleAfter: ax2.map((v) => +v.toFixed(2)), tireRadius: +r.toFixed(3), tireWidth: +wd.toFixed(3) };
}

// 6) 단순화 + 텍스처 축소
await MeshoptSimplifier.ready;
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.002, lockBorder: false }), dedup(), prune(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }));

await io.write(outP, doc);
const sceneB = getBounds(root.listScenes()[0]);
let tris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log(JSON.stringify({ wheelInfo, tris: Math.round(tris), min: sceneB.min.map((v) => +v.toFixed(3)), max: sceneB.max.map((v) => +v.toFixed(3)), materials: root.listMaterials().map((m) => m.getName()) }, null, 1));
