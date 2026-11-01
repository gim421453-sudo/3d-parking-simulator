import * as THREE from 'three';

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

function makeCanvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, aniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

function speckle(g: CanvasRenderingContext2D, s: number, base: string, n: number, light: string, dark: string, seed: number): void {
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < n; i++) {
    g.fillStyle = r() > 0.5 ? light : dark;
    g.globalAlpha = 0.08 + r() * 0.18;
    const p = 1 + Math.floor(r() * (s / 128 + 1));
    g.fillRect(r() * s, r() * s, p, p);
  }
  g.globalAlpha = 1;
}

/** 텍스처 해상도(size)는 품질 설정으로 낮출 수 있다. 모두 코드로 생성하므로 외부 리소스/저작권 문제가 없다. */
export interface TextureSet {
  asphalt: THREE.CanvasTexture;
  concrete: THREE.CanvasTexture;
  grass: THREE.CanvasTexture;
  facade: THREE.CanvasTexture;
  stripes: THREE.CanvasTexture;
  blob: THREE.CanvasTexture;
}

export function createTextures(size: number, aniso: number): TextureSet {
  const asphalt = makeCanvas(size, (g, s) => speckle(g, s, '#3b3e43', s * 6, '#8a8d92', '#14161a', 11), aniso);
  const concrete = makeCanvas(size, (g, s) => {
    speckle(g, s, '#7b7d80', s * 4, '#b4b6b8', '#4a4c50', 23);
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, s, s);
  }, aniso);
  const grass = makeCanvas(size, (g, s) => speckle(g, s, '#4f8a3d', s * 8, '#79b05a', '#2f5f26', 37), aniso);
  const facade = makeCanvas(size, (g, s) => {
    g.fillStyle = '#c9c3b6';
    g.fillRect(0, 0, s, s);
    const cols = 4;
    const rows = 4;
    const cw = s / cols;
    const rh = s / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        g.fillStyle = (x + y) % 3 === 0 ? '#3d5670' : '#25384c';
        g.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.6);
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.18);
      }
    }
  }, aniso);
  const stripes = makeCanvas(Math.min(size, 128), (g, s) => {
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#d6322a';
    for (let i = -2; i < 6; i++) {
      g.beginPath();
      g.moveTo(i * (s / 2), s);
      g.lineTo(i * (s / 2) + s / 4, s);
      g.lineTo(i * (s / 2) + s / 4 + s / 2, 0);
      g.lineTo(i * (s / 2) + s / 2, 0);
      g.closePath();
      g.fill();
    }
  }, 1);
  const blob = makeCanvas(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, 1);
  blob.wrapS = blob.wrapT = THREE.ClampToEdgeWrapping;
  return { asphalt, concrete, grass, facade, stripes, blob };
}
