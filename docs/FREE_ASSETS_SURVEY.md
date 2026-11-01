# 무료 3D 에셋 조사 (v0.3, 간단 조사)

조사일: 2026-11-01. **이번 업데이트에서는 어떤 외부 에셋도 다운로드하거나 저장소에 넣지 않았습니다.** 아래는 "도입 후보"이며, 도입 전에 각 에셋 페이지에서 라이선스를 다시 확인하고 `docs/ASSETS.md` 표에 기록해야 합니다.

## 확인 수준 범례
- ✅ **직접 확인**: 공식 저장소/페이지의 라이선스 문구를 이 세션에서 직접 읽음
- ⚠️ **간접 확인**: 검색 결과/제3자 페이지의 설명만 확인 (공식 페이지 접속 불가) — 사용 전 반드시 재확인
- ❌ **미확인**: 후보 이름만 알고 있고 라이선스/파일을 확인하지 못함 — 사용 가능하다고 보고하지 않음

> 이 세션의 네트워크는 `github.com` 외 다수 도메인을 막고 있어 `kenney.nl`, `polyhaven.com` 에 접속하지 못했습니다. 해당 사이트를 허용해 주면 공식 페이지에서 다시 확인할 수 있습니다.

## 후보

| 분류 | 에셋 | 출처 URL | 라이선스 | 확인 | 형식 | 웹·모바일 적합성 / 성능 부담(추정) |
|---|---|---|---|---|---|---|
| 승용차 | **ToyCar** (Khronos glTF Sample Assets) | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar | **CC0 1.0** ("© 2020, Public. Creative Commons Zero v1.0 Universal") — Guido Odendahl, Eric Chadwick | ✅ 직접 | GLB (glTF-Binary) | 로더 검증용으로 적합. 장난감 차량이라 "현실적인 승용차" 요구에는 부적합. PBR 텍스처 포함(용량 미확인) |
| 승용차 | **CarConcept** (Khronos glTF Sample Assets) | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept | **CC BY 4.0** ("© 2024, Darmstadt Graphics Group GmbH", Eric Chadwick) — **저작자 표시 필요**. 원본은 Unity Fan 의 퍼블릭 도메인 모델을 최적화/변환한 것이라고 명시 | ✅ 직접 | glTF/GLB | 현실적인 컨셉카. 단일 메시라 바퀴 분리/조향/램프 개별 제어에는 Blender 작업 필요. 폴리 수/텍스처 용량은 미확인(모바일은 반드시 측정) |
| 승용차(저폴리) | **Kenney Car Kit** | https://kenney.nl/assets/car-kit (itch: https://kenney-assets.itch.io/car-kit) | CC0 (OpenGameArt 및 제3자 페이지의 설명) | ⚠️ 간접 | OBJ / FBX / glTF, 40개 이상 모델, zip 약 3.4MB (itch 설명) | 매우 가벼워 모바일에 적합. 스타일은 저폴리(만화풍) — "현실적인 승용차"가 아님. glb 파일이 zip 에 실제로 들어 있는지 미확인 |
| 도시/도로 | Kenney City Kit 계열 (Commercial/Suburban/Roads 등) | https://kenney.nl/assets | CC0 (Kenney 에셋 공통으로 알려져 있으나 이 세션에서 접속 실패) | ❌ 미확인 | 미확인 | 저폴리라 가볍지만 스타일이 현재 목표(현실적)와 다름 |
| 환경/소품 | Poly Haven 모델 | https://polyhaven.com/models | CC0 (사이트 공지로 알려져 있으나 이 세션에서 접속 실패) | ❌ 미확인 | glTF 등 | 사실적 소품(기둥/드럼통 등) 후보. 텍스처 해상도가 커서 모바일용 축소 필요 |
| 환경/차량 | Quaternius, Poly Pizza, Sketchfab(CC0/CC-BY 필터) | https://quaternius.com · https://poly.pizza · https://sketchfab.com | 모델마다 다름(CC0 / CC-BY / CC-BY-NC 혼재) | ❌ 미확인 | GLB 다수 | **모델 단위로** 라이선스(특히 NC=비상업, ND=변형금지)를 확인해야 함 |
| 지하/주차 구조물 | Fab "Underground Parking Lot – High-Detail 3D Environment" | https://www.fab.com/listings/ca7f3047-e82c-4024-a503-c945f1f9fb2b | 검색 스니펫에서 **라이선스/가격 확인 불가** | ❌ 미확인 | OBJ / FBX / GLB, 약 30만 정점 | **모바일 부적합**(정점 30만). 다층·램프 구조라 현재 엔진(단일 높이)에서도 사용 불가 |
| 정비소/2주식 리프트 | — | — | — | ❌ 후보 없음 | — | 무료 CC0/CC-BY 모델을 찾지 못함. 자체 제작(Blender) 권장 |
| 주차타워/나선형 경사로 | — | — | — | ❌ 후보 없음 | — | 무료 모델 확인 못함. 형상이 맵 설계에 종속되므로 어차피 자체 제작 권장 |

## 결론과 권장

1. **지금 당장 안전하게 쓸 수 있다고 확인된 것**: ToyCar(CC0)뿐이며 실제 용도는 GLB 로더 검증입니다. CarConcept 는 CC BY 4.0 이므로 크레딧(앱 내 크레딧 화면 또는 `docs/ASSETS.md`)을 넣으면 사용 가능하지만, 현재 차량 구조(바퀴/램프 분리)를 맞추려면 Blender 에서 노드를 분리해야 합니다.
2. **현실적인 승용차/지하 주차장은 무료 에셋만으로 요구 품질을 맞추기 어렵습니다.** 무료 후보는 대부분 저폴리(Kenney 계열)이거나 라이선스가 모델마다 다릅니다. 권장 경로: ① Blender 로 차량/구조물을 직접 제작(`docs/BLENDER_PIPELINE.md`), ② 필요하면 CC0/CC-BY 모델을 골라 라이선스 확인 후 `docs/ASSETS.md` 에 기록하고 Blender 로 부품 분리·경량화.
3. 정비소·2주식 리프트·주차타워·나선형 경사로는 **에셋 이전에 엔진 확장(다층 높이/경사 충돌)이 먼저**입니다 (`docs/MAP_ROADMAP.md`).
4. 맵 구조를 사용자가 확정하기 전에는 대규모 배치를 제작하지 않습니다.
