/**
 * v0.6.3 건물 외벽 PBR 아틀라스(코드 생성 — 외부 이미지/에셋 없음, 라이선스 문제 없음).
 *  - 칸 12개(4×3): 아파트·빌라·주택·상가(위층/1층)·사무·공장·창고·학교/공공·주차타워·생성(주거/공업)
 *  - 맵 3장: 색(sRGB, 창틀 그늘을 칠해 AO 근사) · 법선(높이 캔버스에서 계산) · 거칠기/금속도(G=거칠기, B=금속도 — 유리는 낮은 거칠기·약한 금속)
 *  - 셰이더 패치: 정점 속성 aCell(본 칸·1층 칸 오프셋)과 UV(모듈/층 단위)로 칸 안에서 반복(fract) + textureGrad(밉맵 이음새 방지)
 *    → 건물 종류가 달라도 타일당 재질 1개(그리기 호출 증가 없음)
 * 실제 건물 사진 기반이 아니다(일반적인 외벽). 실제 외관을 재현했다고 표기하지 말 것.
 */
import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, FACADE_CELLS, type FacadeCell } from './facadeTypes';

type Ctx = CanvasRenderingContext2D;
interface Layers {
  c: Ctx; // 색
  h: Ctx; // 높이(회색조)
  r: Ctx; // 거칠기(G)/금속도(B)
}
const rgb = (v: number): string => `rgb(${v},${v},${v})`;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 한 칸 그리기 도우미: 좌표는 칸 기준 0~1(위→아래) */
function painter(L: Layers, ox: number, oy: number, S: number) {
  const R = (x: number, y: number, w: number, h: number): [number, number, number, number] => [ox + x * S, oy + y * S, w * S, h * S];
  return {
    /** 색·높이(0~1)·거칠기(0~1)·금속도(0~1) 사각형 */
    rect(x: number, y: number, w: number, h: number, color: string, height: number, rough: number, metal = 0): void {
      const r = R(x, y, w, h);
      L.c.fillStyle = color;
      L.c.fillRect(...r);
      L.h.fillStyle = rgb(Math.round(height * 255));
      L.h.fillRect(...r);
      L.r.fillStyle = `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
      L.r.fillRect(...r);
    },
    /** 색만 어둡게(틈·그늘 — AO 근사) */
    shade(x: number, y: number, w: number, h: number, a: number): void {
      L.c.fillStyle = `rgba(0,0,0,${a})`;
      L.c.fillRect(...R(x, y, w, h));
    },
    noise(seed: number, n: number, amp: number): void {
      const r = rng(seed);
      for (let i = 0; i < n; i++) {
        L.c.fillStyle = r() > 0.5 ? `rgba(255,255,255,${amp * r()})` : `rgba(0,0,0,${amp * r()})`;
        const p = Math.max(1, Math.round(S / 96));
        L.c.fillRect(ox + r() * S, oy + r() * S, p, p);
      }
    },
  };
}

/** 창: 창틀(돌출) + 유리(움푹, 낮은 거칠기·약한 금속) + 위쪽 반사 띠 + 아래 그늘 */
function windowAt(p: ReturnType<typeof painter>, x: number, y: number, w: number, h: number, frame: string, glass: string): void {
  const f = Math.min(w, h) * 0.08;
  p.rect(x - f, y - f, w + 2 * f, h + 2 * f, frame, 0.62, 0.55);
  p.rect(x, y, w, h, glass, 0.18, 0.08, 0.55);
  p.rect(x, y, w, h * 0.22, 'rgba(255,255,255,0.10)', 0.18, 0.06, 0.6);
  p.shade(x, y + h * 0.85, w, h * 0.15, 0.25);
}

const DRAW: Record<FacadeCell, (p: ReturnType<typeof painter>) => void> = {
  apartment: (p) => {
    p.rect(0, 0, 1, 1, '#d9d3c4', 0.5, 0.85);
    p.noise(1, 260, 0.05);
    windowAt(p, 0.14, 0.18, 0.72, 0.52, '#c9c3b6', '#2c4257');
    p.rect(0, 0.82, 1, 0.1, '#bdb6a6', 0.95, 0.8); // 발코니 슬래브
    p.rect(0.04, 0.74, 0.92, 0.03, '#8f9499', 0.85, 0.4, 0.7); // 난간
    p.shade(0, 0.92, 1, 0.08, 0.28);
  },
  villa: (p) => {
    p.rect(0, 0, 1, 1, '#9c5b45', 0.5, 0.9);
    for (let row = 0; row < 12; row++) {
      p.rect(0, row / 12, 1, 0.012, '#7b4636', 0.42, 0.95);
      for (let k = 0; k < 6; k++) p.rect(((k + (row % 2) * 0.5) / 6) % 1, row / 12, 0.008, 1 / 12, '#7b4636', 0.42, 0.95);
    }
    p.noise(2, 300, 0.07);
    windowAt(p, 0.27, 0.25, 0.46, 0.42, '#e3ddd2', '#2f4a5f');
    p.rect(0, 0.92, 1, 0.08, '#cfc7b8', 0.7, 0.8);
  },
  house: (p) => {
    p.rect(0, 0, 1, 1, '#e7dcc4', 0.5, 0.92);
    p.noise(3, 340, 0.06);
    windowAt(p, 0.33, 0.28, 0.34, 0.38, '#f3efe6', '#344b5c');
    p.rect(0.3, 0.68, 0.4, 0.04, '#cfc4ad', 0.7, 0.9); // 창턱
  },
  shop: (p) => {
    p.rect(0, 0, 1, 1, '#b9bcc0', 0.5, 0.7);
    p.noise(4, 200, 0.05);
    windowAt(p, 0.04, 0.26, 0.92, 0.42, '#8b9096', '#273c4f');
    p.rect(0, 0.88, 1, 0.12, '#a3a7ac', 0.65, 0.7);
  },
  shopGround: (p) => {
    p.rect(0, 0, 1, 1, '#4f555c', 0.5, 0.6);
    p.rect(0, 0, 1, 0.2, '#d0a13a', 0.75, 0.5); // 간판 띠(색은 일반 — 상호 없음)
    p.rect(0, 0.18, 1, 0.04, '#3a3d42', 0.8, 0.5); // 차양
    p.shade(0, 0.22, 1, 0.06, 0.35);
    windowAt(p, 0.05, 0.3, 0.56, 0.62, '#6d737a', '#36506a'); // 진열창
    p.rect(0.68, 0.3, 0.26, 0.7, '#2b2f34', 0.25, 0.35, 0.3); // 출입문
    p.rect(0.79, 0.62, 0.04, 0.06, '#c9ccd1', 0.6, 0.3, 0.9); // 손잡이
  },
  office: (p) => {
    p.rect(0, 0, 1, 1, '#3a5068', 0.25, 0.07, 0.65);
    p.rect(0, 0.0, 1, 0.07, '#8a96a3', 0.6, 0.35, 0.6); // 층 경계(스팬드럴)
    for (const x of [0, 0.5]) p.rect(x, 0, 0.025, 1, '#9aa6b2', 0.65, 0.3, 0.8); // 멀리언
    p.rect(0, 0.07, 1, 0.25, 'rgba(255,255,255,0.08)', 0.25, 0.05, 0.7);
  },
  factory: (p) => {
    p.rect(0, 0, 1, 1, '#aab3ba', 0.5, 0.55, 0.45);
    for (let k = 0; k < 24; k++) p.rect(k / 24, 0, 0.5 / 24, 1, '#97a0a7', 0.62, 0.5, 0.5); // 골판
    p.rect(0.05, 0.12, 0.9, 0.12, '#33485a', 0.2, 0.1, 0.5); // 높은 띠창
    p.shade(0, 0.9, 1, 0.1, 0.2);
  },
  warehouse: (p) => {
    p.rect(0, 0, 1, 1, '#b8b2a4', 0.5, 0.6, 0.4);
    for (let k = 0; k < 24; k++) p.rect(k / 24, 0, 0.5 / 24, 1, '#a39d90', 0.62, 0.55, 0.45);
    // 롤 셔터
    p.rect(0.3, 0.45, 0.4, 0.55, '#8d9195', 0.35, 0.5, 0.5);
    for (let k = 0; k < 14; k++) p.rect(0.3, 0.45 + (k / 14) * 0.55, 0.4, 0.008, '#6f7377', 0.3, 0.5, 0.5);
    p.shade(0.3, 0.45, 0.4, 0.04, 0.3);
  },
  school: (p) => {
    p.rect(0, 0, 1, 1, '#d6d2c8', 0.5, 0.85);
    p.noise(8, 220, 0.05);
    windowAt(p, 0.18, 0.24, 0.64, 0.46, '#ece9e2', '#30485e');
    p.rect(0, 0.86, 1, 0.14, '#c2bdb1', 0.75, 0.85);
  },
  parking: (p) => {
    p.rect(0, 0, 1, 1, '#16181b', 0.15, 0.95); // 열린 층(안쪽 어둠)
    p.rect(0, 0.62, 1, 0.38, '#b9b6ae', 0.75, 0.9); // 슬래브 띠
    p.rect(0, 0.55, 1, 0.07, '#8d9196', 0.7, 0.5, 0.7); // 방호 난간
    for (const x of [0.02, 0.96]) p.rect(x, 0, 0.04, 0.62, '#a9a69e', 0.7, 0.9); // 기둥
  },
  genBlock: (p) => {
    // 생성 건물(실제 아님): 회청 패널, 창문 없음 — 실제 건물과 구분
    p.rect(0, 0, 1, 1, '#aab3bd', 0.5, 0.95);
    p.rect(0, 0.96, 1, 0.04, '#97a0aa', 0.45, 0.95);
    p.rect(0.98, 0, 0.02, 1, '#9fa8b2', 0.48, 0.95);
  },
  genIndustrial: (p) => {
    p.rect(0, 0, 1, 1, '#a4adb7', 0.5, 0.9);
    for (let k = 0; k < 12; k++) p.rect(k / 12, 0, 0.5 / 12, 1, '#98a1ab', 0.55, 0.9);
  },
};

export interface FacadeAtlas {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  ormMap: THREE.CanvasTexture;
  /** 칸 크기(픽셀) */
  cell: number;
  dispose(): void;
}

/** cell = 칸 한 변 픽셀(품질 설정: low 64 · medium 128 · high 256) */
export function createFacadeAtlas(cell: number, aniso: number): FacadeAtlas {
  const W = cell * ATLAS_COLS;
  const H = cell * ATLAS_ROWS;
  const mk = (): [HTMLCanvasElement, Ctx] => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return [c, c.getContext('2d', { willReadFrequently: true })!];
  };
  const [cc, c] = mk();
  const [, h] = mk();
  const [rc, r] = mk();
  FACADE_CELLS.forEach((name, i) => {
    const ox = (i % ATLAS_COLS) * cell;
    const oy = Math.floor(i / ATLAS_COLS) * cell;
    DRAW[name](painter({ c, h, r }, ox, oy, cell));
  });
  // 높이 → 법선(소벨, 칸 경계는 칸 안에서 감싸기)
  const hd = h.getImageData(0, 0, W, H).data;
  const [nc, n] = mk();
  const out = n.createImageData(W, H);
  const k = cell / 32; // 높이 대비 기울기 세기
  const at = (x: number, y: number, x0: number, y0: number): number => {
    const xx = x0 + ((((x - x0) % cell) + cell) % cell);
    const yy = y0 + ((((y - y0) % cell) + cell) % cell);
    return hd[(yy * W + xx) * 4] / 255;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = x - (x % cell);
      const y0 = y - (y % cell);
      const dx = at(x + 1, y, x0, y0) - at(x - 1, y, x0, y0);
      const dy = at(x, y + 1, x0, y0) - at(x, y - 1, x0, y0);
      // 캔버스 y 는 아래로, 텍스처 v 는 위로(flipY) — 접선 공간 +y 는 -dy
      let nx = -dx * k;
      let ny = dy * k;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * W + x) * 4;
      out.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out.data[o + 3] = 255;
    }
  n.putImageData(out, 0, 0);
  const tex = (cv: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  const map = tex(cc, true);
  const normalMap = tex(nc, false);
  const ormMap = tex(rc, false);
  return {
    map,
    normalMap,
    ormMap,
    cell,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      ormMap.dispose();
    },
  };
}

/**
 * MeshStandardMaterial 에 아틀라스를 붙인다. 기하에는 uv(모듈/층 단위)와 aCell(vec4: 본 칸 오프셋 xy, 1층 칸 오프셋 zw) 속성이 있어야 한다.
 */
export function applyFacadeAtlas(m: THREE.MeshStandardMaterial, a: FacadeAtlas, opts: { glass?: boolean } = {}): void {
  m.map = a.map;
  m.normalMap = a.normalMap;
  m.normalScale = new THREE.Vector2(1, 1);
  m.roughnessMap = a.ormMap;
  m.roughness = 1;
  if (opts.glass !== false) {
    m.metalnessMap = a.ormMap;
    m.metalness = 1;
  } else m.metalness = 0;
  const cellSize = new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS);
  const pad = 1.5 / a.cell;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.atlasCell = { value: cellSize };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aCell;\nvarying vec4 vCell;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = aCell;');
    const sample = (s: string, tex: string, uv: string): string => s.split(`texture2D( ${tex}, ${uv} )`).join(`atlasSample( ${tex}, ${uv} )`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vCell;
uniform vec2 atlasCell;
vec4 atlasSample( sampler2D t, vec2 uv ) {
  vec2 off = uv.y < 1.0 ? vCell.zw : vCell.xy;
  vec2 f = fract( uv ) * ${(1 - 2 * pad).toFixed(5)} + ${pad.toFixed(5)};
  vec2 g = uv * atlasCell;
  return textureGrad( t, off + f * atlasCell, dFdx( g ), dFdy( g ) );
}`,
      )
      .replace('#include <map_fragment>', sample(THREE.ShaderChunk.map_fragment, 'map', 'vMapUv'))
      .replace('#include <normal_fragment_maps>', sample(THREE.ShaderChunk.normal_fragment_maps, 'normalMap', 'vNormalMapUv'))
      .replace('#include <roughnessmap_fragment>', sample(THREE.ShaderChunk.roughnessmap_fragment, 'roughnessMap', 'vRoughnessMapUv'))
      .replace('#include <metalnessmap_fragment>', sample(THREE.ShaderChunk.metalnessmap_fragment, 'metalnessMap', 'vMetalnessMapUv'));
  };
  m.customProgramCacheKey = () => `facadeAtlas-${opts.glass !== false ? 'g' : 'm'}`;
  m.needsUpdate = true;
}
