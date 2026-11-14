import { MAP_CARPARK3 } from './mapCarpark3';
import { MAP_GARAGE5 } from './mapGarage5';
import { MAP_LOT } from './mapLot';
import { MAP_MECHPARK } from './mapMechPark';
import { MAP_MEGAPARK } from './mapMegaPark';
import { MAP_MODLOT } from './mapModLot';
import { MAP_OUTDOOR } from './mapOutdoor';
import { MAP_SPIRAL } from './mapSpiral';
import { MAP_TOWER } from './mapTower';
import { MAP_UNDERGROUND } from './mapUnderground';
import { withMechAnnex, type AnnexOpts } from './mechAnnex';
import type { MapData } from './types';

/** 새 맵은 MapData 파일을 만들고 여기에 추가하면 된다. */
import { MAP_ALLEY } from './mapAlley';
import { MAP_CITYTEST } from './mapCityTest';
import { MAP_GARAGE } from './mapGarage';
import { MAP_GOEJEONG } from './mapGoejeong';
/** 원본 맵(부속 구역을 붙이기 전) — megapark 합성과 배치 탐색 스크립트가 쓴다 */
export const BASE_MAPS: MapData[] = [MAP_LOT, MAP_UNDERGROUND, MAP_OUTDOOR, MAP_TOWER, MAP_GARAGE5, MAP_CARPARK3, MAP_MODLOT, MAP_SPIRAL, MAP_MECHPARK, MAP_MEGAPARK, MAP_GARAGE, MAP_ALLEY, MAP_CITYTEST, MAP_GOEJEONG];
/**
 * 맵 옆에 붙이는 기계식 주차 부속 구역 (v0.5.5, 임시 배치): 시설을 놓을 자리가 없던 맵은 외벽에 문을 내고 바로 옆 마당에 시설을 둔다.
 * 문 위치는 scripts/find-annex-sites.ts 로 찾은 값(문 자리에 벽만 있음 · 직선 진입로가 비어 있음 · 시작 위치에서 경로가 있음)이다.
 */
export const MECH_ANNEX: Record<string, AnnexOpts> = {
  lot: { id: 'lot-mech', name: '연습장 옆 기계식 타워 (6층)', side: 'west', at: 16, floors: 6 },
  underground: { id: 'ug-mech', name: '지하주차장 옆 기계식 홀 (4층)', side: 'east', at: 1, floors: 4 },
  tower: { id: 'tw-mech', name: '주차타워 옆 기계식 타워 (6층)', side: 'west', at: 6, floors: 6 },
  garage5: { id: 'g5-mech', name: '5층 주차장 옆 기계식 타워 (8층)', side: 'west', at: 0, floors: 8 },
  carpark3: { id: 'c3-mech', name: '3층 주차장 옆 기계식 타워 (6층)', side: 'west', at: -11, floors: 6 },
  modlot: { id: 'ml-mech', name: '정밀 연습장 옆 기계식 타워 (6층)', side: 'west', at: 6, floors: 6 },
  spiral: { id: 'sp-mech', name: '나선 주차장 옆 기계식 타워 (6층)', side: 'east', at: -8, floors: 6 },
  garage: { id: 'gar-mech', name: '정비소 옆 기계식 타워 (4층)', side: 'west', at: -14, floors: 4 },
  alley: { id: 'al-mech', name: '골목 끝 기계식 타워 (6층)', side: 'west', at: -19, floors: 6 },
};
export const MAPS: MapData[] = BASE_MAPS.map((m) => (MECH_ANNEX[m.id] ? withMechAnnex(m, MECH_ANNEX[m.id]) : m));
export const getMap = (id: string): MapData => MAPS.find((m) => m.id === id) ?? MAPS[0];
export type { MapData } from './types';
export { mapColliders } from './types';
