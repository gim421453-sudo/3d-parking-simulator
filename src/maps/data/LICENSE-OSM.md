# 지도 데이터 출처 / 라이선스

`goejeong.json` (괴정동, 부산 사하구 — 괴정역 중심 1km × 1km)

- 출처: **© OpenStreetMap contributors** — https://www.openstreetmap.org/copyright
- 라이선스: **Open Database License (ODbL) 1.0** — https://opendatacommons.org/licenses/odbl/1-0/
- 내려받은 날: 2026-11-14, OSM API `map?bbox=128.985881,35.095079,128.997299,35.104421`
- 변환: `scripts/osm-import.ts` (중심 35.09975 N, 128.99159 E, 반폭 500m, `--fill`)
  - 도로(차량 통행 등급), 건물 다각형/층수, 주차장·녹지·물 면, 도로망 그래프만 추출·투영(+x 동, +z 남, 미터)
  - **`gen: 1` 건물은 OSM 에 건물이 등록되지 않은 블록을 채운 절차 생성 건물이며 실제 건물이 아니다.**
  - 층수/높이가 없는 건물은 종류별 기본값(아파트 15층 등)으로 추정했다. 고도(언덕)는 반영하지 않았다(평면).

이 파일은 OSM 데이터베이스에서 파생된 데이터베이스이므로 ODbL 1.0 을 따른다(같은 라이선스로 공유, 출처 표시).
게임 화면(맵 설명/미니맵)에도 "© OpenStreetMap contributors" 를 표시한다.
