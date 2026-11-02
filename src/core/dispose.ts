import * as THREE from 'three';

export interface DisposeSkip {
  geometries?: ReadonlySet<THREE.BufferGeometry>;
  materials?: ReadonlySet<THREE.Material>;
  textures?: ReadonlySet<THREE.Texture>;
}

/** 객체 트리의 geometry/material/texture 를 해제한다 (공유 캐시 자원은 skip 으로 제외). 반환: 해제한 개수 */
export function disposeObject(root: THREE.Object3D, skip: DisposeSkip = {}): { geometries: number; materials: number; textures: number } {
  const n = { geometries: 0, materials: 0, textures: 0 };
  const seenG = new Set<THREE.BufferGeometry>();
  const seenM = new Set<THREE.Material>();
  const seenT = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (g && !seenG.has(g) && !skip.geometries?.has(g)) {
      seenG.add(g);
      g.dispose();
      n.geometries++;
    }
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (seenM.has(mat) || skip.materials?.has(mat)) continue;
      seenM.add(mat);
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        const t = v as THREE.Texture | null;
        if (t && (t as THREE.Texture).isTexture && !seenT.has(t) && !skip.textures?.has(t)) {
          seenT.add(t);
          t.dispose();
          n.textures++;
        }
      }
      mat.dispose();
      n.materials++;
    }
  });
  return n;
}
