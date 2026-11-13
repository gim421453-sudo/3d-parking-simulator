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
import type { MapData } from './types';

/** 새 맵은 MapData 파일을 만들고 여기에 추가하면 된다. */
import { MAP_ALLEY } from './mapAlley';
import { MAP_GARAGE } from './mapGarage';
export const MAPS: MapData[] = [MAP_LOT, MAP_UNDERGROUND, MAP_OUTDOOR, MAP_TOWER, MAP_GARAGE5, MAP_CARPARK3, MAP_MODLOT, MAP_SPIRAL, MAP_MECHPARK, MAP_MEGAPARK, MAP_GARAGE, MAP_ALLEY];
export const getMap = (id: string): MapData => MAPS.find((m) => m.id === id) ?? MAPS[0];
export type { MapData } from './types';
export { mapColliders } from './types';
