/**
 * Copernicus DEM GLO-30 (1 arcsec COG GeoTIFF) 읽기 + 위경도 쌍선형 표본.
 * 출처: Copernicus DEM — © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA. All rights reserved.
 * (GLO-30 공개 라이선스: 무료 사용·재배포 허용, 출처 표기 필요 — docs/ASSETS.md)
 * 주의: GLO-30 은 표면 모델(DSM)이라 건물·수목 높이가 일부 섞인다 → build.ts 에서 열림 연산 + 평활로 지표면(DTM)을 **추정**한다.
 */
import * as fs from 'node:fs';
import { fromArrayBuffer } from 'geotiff';

export interface DemWin {
  lon0: number; // 왼쪽 위 픽셀 중심 경도
  lat0: number; // 왼쪽 위 픽셀 중심 위도
  dlon: number;
  dlat: number; // 양수(아래로 갈수록 위도 감소)
  w: number;
  h: number;
  data: Float32Array;
}

export async function loadDem(files: string[], bb: { w: number; s: number; e: number; n: number }): Promise<DemWin[]> {
  const out: DemWin[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution(); // ry 음수
    const W = img.getWidth();
    const H = img.getHeight();
    const px0 = Math.max(0, Math.floor((bb.w - ox) / rx) - 2);
    const px1 = Math.min(W, Math.ceil((bb.e - ox) / rx) + 2);
    const py0 = Math.max(0, Math.floor((bb.n - oy) / ry) - 2);
    const py1 = Math.min(H, Math.ceil((bb.s - oy) / ry) + 2);
    if (px1 <= px0 || py1 <= py0) continue;
    const r = (await img.readRasters({ window: [px0, py0, px1, py1], samples: [0] })) as unknown as Float32Array[];
    out.push({ lon0: ox + (px0 + 0.5) * rx, lat0: oy + (py0 + 0.5) * ry, dlon: rx, dlat: -ry, w: px1 - px0, h: py1 - py0, data: Float32Array.from(r[0]) });
  }
  return out;
}

/** 위경도 쌍선형 표본(m). 범위 밖이면 NaN */
export function sampleDem(wins: DemWin[], lat: number, lon: number): number {
  for (const d of wins) {
    const fx = (lon - d.lon0) / d.dlon;
    const fy = (d.lat0 - lat) / d.dlat;
    if (fx < -1 || fy < -1 || fx > d.w || fy > d.h) continue;
    // 타일 이음매(경도 129.0° 등): 이웃 타일의 픽셀 중심 사이에 떨어지는 점은 가장자리 픽셀로 고정(빈 값 → 0 → 바다로 오인되던 문제)
    const cx = Math.max(0, Math.min(d.w - 1, fx));
    const cy = Math.max(0, Math.min(d.h - 1, fy));
    return bil(d, cx, cy);
  }
  return NaN;
}
function bil(d: DemWin, fx: number, fy: number): number {
  {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(d.w - 1, x0 + 1);
    const y1 = Math.min(d.h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v = (x: number, y: number) => d.data[y * d.w + x];
    return v(x0, y0) * (1 - tx) * (1 - ty) + v(x1, y0) * tx * (1 - ty) + v(x0, y1) * (1 - tx) * ty + v(x1, y1) * tx * ty;
  }
}
