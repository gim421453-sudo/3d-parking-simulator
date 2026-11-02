import { MAP_LOT } from './mapLot';
import { MAP_OUTDOOR } from './mapOutdoor';
import { MAP_TOWER } from './mapTower';
import { MAP_UNDERGROUND } from './mapUnderground';
import type { MapData } from './types';

/** 새 맵은 MapData 파일을 만들고 여기에 추가하면 된다. */
export const MAPS: MapData[] = [MAP_LOT, MAP_UNDERGROUND, MAP_OUTDOOR, MAP_TOWER];
export const getMap = (id: string): MapData => MAPS.find((m) => m.id === id) ?? MAPS[0];
export type { MapData } from './types';
export { mapColliders } from './types';
