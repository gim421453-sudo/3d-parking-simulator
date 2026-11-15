# 에셋 출처 및 이용 조건

## 현재 상태 (v0.1.0)

**외부 에셋을 사용하지 않습니다.** 모든 3D 모델과 텍스처는 이 저장소의 코드로 생성됩니다.

| 항목 | 생성 방식 | 위치 | 라이선스 |
|---|---|---|---|
| 승용차 3종 (차체/유리/바퀴/등화/콕핏) | 코드로 생성한 지오메트리 (사이드 프로파일 압출 + 박스/실린더) | `src/vehicle/carModel.ts` | 프로젝트 자체 코드 |
| 주차장 3종 (바닥, 주차선, 벽, 기둥, 콘, 건물, 가로등, 나무) | 코드로 생성 | `src/maps/mapBuilder.ts`, `src/maps/*.ts` | 프로젝트 자체 코드 |
| 텍스처 (아스팔트, 콘크리트, 잔디, 창문 외벽, 줄무늬, 그림자) | Canvas 2D로 생성 | `src/maps/textures.ts` | 프로젝트 자체 코드 |
| 경고음 | WebAudio 오실레이터(사각파 1100Hz) | `src/sensors/beeper.ts` | 프로젝트 자체 코드 |
| 아이콘/글꼴 | 시스템 글꼴, 이모지/SVG 인라인 | `index.html`, `src/style.css` | 해당 없음 |

> 무료 에셋 후보 조사 결과: [FREE_ASSETS_SURVEY.md](FREE_ASSETS_SURVEY.md) (아직 도입한 에셋 없음)

## 외부 GLB/glTF 에셋을 추가할 때

사용자가 직접 모델링하지 않아도 되도록 CC0/CC-BY 등 **재배포가 허용된** 무료 에셋을 쓸 수 있게 구조를 열어두었습니다.
에셋을 추가하기 전에 **반드시 해당 에셋 페이지에서 라이선스 조건을 직접 확인**하고, 아래 표에 기록하세요. (저는 특정 에셋의 라이선스를 대신 보증할 수 없습니다.)

| 파일 | 이름 | 제작자 | 출처 URL | 라이선스 | 저작자 표시 필요 | 수정 여부 | 추가일 |
|---|---|---|---|---|---|---|---|
| public/models/sedan-test.glb | 시험용 세단 | 이 프로젝트(자체 생성) | - | 프로젝트 자체 | 불필요 | - | v0.4 |
| public/models/concept-coupe.glb | Car Concept (컨셉 스포츠 쿠페) | Khronos Group (기반 모델 "Free Concept Car 004": Unity Fan, CC0) | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept | **CC-BY-4.0** (원본 CC0 기반, 로고/상표 제외) | **필요** (앱 크레딧·이 표·`public/models/LICENSE-concept-coupe.md`) | 있음 — 실내 제거·바퀴 재구성·램프 재질 개명·단순화(`scripts/prepare-car-glb.mjs`) | v0.5.0 |

| src/maps/data/goejeong.json | 괴정동(부산 사하구) 괴정역 중심 1km 도로·건물·주차장·녹지·도로망 | **OpenStreetMap contributors** | https://www.openstreetmap.org/copyright (API `map?bbox=128.985881,35.095079,128.997299,35.104421`, 2026-11-14) | **ODbL 1.0** (파생 데이터베이스 — 같은 라이선스로 공유) | **필요** — 맵 설명·미니맵에 "© OpenStreetMap contributors" 표시, `src/maps/data/LICENSE-OSM.md` | 있음 — 투영(미터)·잘라내기·차량 도로 등급만 추출(`scripts/osm-import.ts`), `gen:1` 건물은 절차 생성(실제 아님) | v0.6.0 |
| public/maps/saha/ (tiles, roadnet.json, manifest.json) | 부산 사하구 전체(법정동 8개) 도로·차로 태그·건물(구멍)·주차장·경계·토지피복·회전 제한 | **OpenStreetMap contributors** | https://www.openstreetmap.org/copyright (API `/map` 0.02° 격자 40회 + relation/full, 2026-11-15) | **ODbL 1.0** (파생 데이터베이스 — 같은 라이선스로 공유) | **필요** — 맵 설명·미니맵에 출처 표시, `public/maps/saha/LICENSE.md` | 있음 — EPSG:5186 투영·경계 클리핑·조밀화·차로 추정(플래그)·타일 분할(`scripts/saha/build.ts`), 생성 건물 없음 | v0.6.2 |
| public/maps/saha/field.bin | 사하구 지형 높이(20m 격자)·토지피복 | **Copernicus DEM GLO-30** (© DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA) | https://copernicus-dem-30m.s3.amazonaws.com (N34/N35 E128/E129) | Copernicus DEM 라이선스(무료·재배포 허용·출처 표기) | **필요** — 맵 설명·미니맵, `LICENSE.md` | 있음 — DSM → 열림(100m)·평활로 **추정 지표면**, 기준고 이동, 바다 낮춤 | v0.6.2 |
