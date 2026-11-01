# Unity 확장 검토 (설계 메모, 이번 업데이트에서 이식 없음)

**Three.js/TypeScript 코드는 Unity C# 으로 자동 이전되지 않습니다.** Unity 판은 별도 프로젝트로 다시 구현해야 하며, 이 저장소는 "데이터와 에셋을 재사용할 수 있게" 준비하는 데까지만 합니다. 현재 `npm run export:data` 가 `export/*.json` 을 생성합니다.

## 구분

| 구분 | 내용 | 재사용 |
|---|---|---|
| ✅ **그대로 이식 가능한 데이터** | `vehicles.json`(제원·카메라 앵커·센서 12개 위치/방향/FOV), `map-*.json`(바닥/주차구획/장애물 충돌체/미션), `parking-rules.json`(판정 조건), `sensors-and-pdc.json`(경고 단계·경고음 규칙·팔레트), `lighting-and-ui-state.json`(조명 모드 규칙·UI 상태 정의), `schema.json`(좌표 규칙) | JSON 로더(C# `JsonUtility`/Newtonsoft)만 작성 |
| ✅ **재사용 가능한 3D 에셋** | Blender → GLB (`docs/BLENDER_PIPELINE.md`). Unity 는 glTF 를 기본 지원하지 않아 glTFast 패키지 등이 필요 | 노드 이름 규약(`Wheel_*`, `Lamp_*`) 유지 |
| 🔧 **Unity 에서 다시 구현해야 하는 것** | 차량 물리(`vehicle/physics.ts` 의 자전거 모델 — 수식은 문서로 이식 가능), 충돌(OBB/원기둥 → Unity Collider/자체 구현), **센서 레이캐스트**(단일 높이 수평 광선 → `Physics.Raycast`), 주차 판정(`mission/parking.ts` — 순수 수학이라 C# 포팅 쉬움), 카메라 리그, **주차 보조 디스플레이 UI**(DOM/SVG/Canvas → uGUI/UI Toolkit), 입력/터치, 저장(localStorage → PlayerPrefs/JSON) | 로직은 순수 함수로 분리되어 있어 포팅 난이도 낮음 |
| ❌ **재사용 불가** | Three.js 렌더링 코드, DOM/CSS UI, WebAudio | — |

## 좌표계 주의
- 이 프로젝트: 오른손 좌표계, y-up, `heading 0 = +z`, heading 증가 = **왼쪽(반시계)** 회전, 차량 로컬 +x = 왼쪽.
- Unity: **왼손** 좌표계, y-up, +x = 오른쪽. 이식 시 x 부호 반전(또는 heading 부호 반전)이 필요 — `export/schema.json` 의 규칙 기준으로 변환 계층을 한 곳에 두세요.

## 시험 이식 제안 (별도 프로젝트)
1. Unity 프로젝트 생성 → `export/vehicles.json` 의 sedan 1대 + `export/map-lot.json` 의 1개 맵만 불러온다.
2. GLB 차량 1대(바퀴 노드 포함) + 평면 주차장(지오메트리는 데이터에서 박스로 생성)을 표시한다.
3. 센서 12개 레이캐스트와 PDC 단계 계산을 C# 로 포팅하고, 같은 입력에서 TypeScript 테스트(`tests/sensors.test.ts`)와 같은 값이 나오는지 비교한다.
4. 여기까지 성공하면 물리/UI/카메라 이식 범위를 결정한다.
