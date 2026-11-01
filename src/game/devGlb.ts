import * as THREE from 'three';
import { createCarModel } from '../vehicle/carModel';
import { VEHICLES } from '../vehicle/spec';

/**
 * 개발용 훅: 코드로 생성한 차량 차체를 GLB(바이너리)로 내보낸다. (window.__devExportGlb)
 * 쓰임: scripts/make-test-glb.cjs 가 브라우저에서 호출해 public/models/sedan-test.glb 를 만든다.
 * GLTFExporter 는 필요할 때만 동적으로 불러온다 (일반 플레이 번들에 포함되지 않음).
 */
export async function exportVehicleGlb(vehicleId: string): Promise<number[]> {
  const spec = VEHICLES.find((v) => v.id === vehicleId) ?? VEHICLES[1];
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const model = createCarModel(spec, {});
  const body = model.bodyGroup;
  body.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const buf = (await exporter.parseAsync(body as THREE.Object3D, { binary: true })) as ArrayBuffer;
  return Array.from(new Uint8Array(buf));
}
