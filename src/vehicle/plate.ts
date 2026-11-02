import * as THREE from 'three';

/** 한국형 승용차 번호판(2006~ 흰색 바탕, 520×110mm) 규격. 번호는 가상이며 소유자와 무관하다. */
export const KR_PLATE = { widthM: 0.52, heightM: 0.11, canvasW: 1040, canvasH: 220 };

/** "123가 4567" 형태(숫자2~3 + 한글 1자 + 숫자4) 검사 */
export function isValidKrPlate(text: string): boolean {
  return /^\d{2,3}[가-힣]\s?\d{4}$/.test(text.trim());
}

/** 번호판 텍스처를 그린다. 교체하려면 같은 함수로 다시 그려 material.map 에 넣는다. */
export function drawKrPlate(canvas: HTMLCanvasElement, text: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#e9ecee';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#2a2f33';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  // 좌측 파란 띠(국가 표기 영역은 상표/국장 문제를 피하려 비움)
  ctx.fillStyle = '#1d4fa3';
  ctx.fillRect(14, 14, 84, h - 28);
  ctx.fillStyle = '#e9ecee';
  ctx.font = `700 34px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('KR', 56, h / 2 + 12);
  ctx.fillStyle = '#16191c';
  ctx.font = `800 ${Math.round(h * 0.62)}px "Noto Sans KR","Malgun Gothic",sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 98 + (w - 98) / 2, h / 2 + 6, w - 130);
}

export function makeKrPlateMaterial(text: string): THREE.MeshStandardMaterial {
  const c = document.createElement('canvas');
  c.width = KR_PLATE.canvasW;
  c.height = KR_PLATE.canvasH;
  drawKrPlate(c, text);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 });
  m.name = 'Plate_KR';
  return m;
}
