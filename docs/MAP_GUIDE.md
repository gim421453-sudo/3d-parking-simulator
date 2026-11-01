# 맵 추가 가이드

맵은 `src/maps/` 의 **순수 데이터(MapData)** 입니다. 렌더링(`mapBuilder.ts`), 충돌/센서(`types.ts#mapColliders`), 미니맵, 미션이 모두 같은 데이터를 읽습니다.

1. `src/maps/mapMine.ts` 를 만들고 `MapData` 를 export 합니다 (`mapLot.ts` 참고).
2. `src/maps/index.ts` 의 `MAPS` 배열에 추가합니다.
3. `npm test` — `tests/maps.test.ts` 가 자동으로 새 맵을 검사합니다: 시작 위치 충돌 없음, 목표 구획이 비어 있고 모든 차량이 규정 자세로 들어갈 수 있음, 장애물 차량끼리 겹침 없음, 충돌체 id 고유.

## 주요 필드

- `bounds`: 주행 가능 영역. 밖으로 나가면 충돌 처리. `perimeter()` 헬퍼로 외벽도 만드세요.
- `surfaces`: 바닥 면(`asphalt`/`concrete`/`grass`/`sidewalk`).
- `slots`: 주차 구획 `{x, z, w, l, dir}` — `dir` 은 "앞으로 주차할 때 차 앞이 향하는 heading". `slotRow()` 헬퍼는 한 줄 + 주차 차량을 만들어 줍니다(`empty` 인덱스는 비워둠).
- `paint`: 도색 사각형(주차선은 `slotPaint()`가 생성). 하나의 지오메트리로 병합되어 드로우콜 1회.
- `obstacles`: `tag`(wall/pillar/cone/barrier/building/lamp/tree/planter/curb/drum/car) + 형태(box/cyl) + `h`, `y0`.
  - **높이가 센서/충돌 동작을 결정**합니다: 센서 높이(0.55m)를 가로지르지 않는 물체(예: 15cm 연석)는 센서에 안 잡히고, 지상고(0.2m) 이하면 차체와도 충돌하지 않습니다.
- `missions`: `{id, name, kind, slotId, desc, parTimeSec, timeLimitSec, spawn?}` — `kind`: `perpendicular-front` / `perpendicular-reverse` / `parallel`.
- `env`: 실내(`indoor`, 천장 높이)/실외, 하늘색, 앰비언트. 실내는 `ceilingLights` 로 조명 배치.

## 좌표 규칙

월드는 x-z 평면이 지면. `heading 0` = +z 방향, 증가하면 왼쪽(반시계) 회전. 자세한 내용은 `src/core/math.ts` 상단 주석.
