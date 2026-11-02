# 차량 GLB 공통 계약 (Codex / Blender 작업용)

게임 로더(`attachGlbScene`, `src/vehicle/carModel.ts`)가 읽는 규칙. 어기면 바퀴/램프/화면이 연결되지 않는다.

## 좌표/단위
- 단위 m, glTF 좌표(Y-up). 게임 로컬 좌표: **+z = 차량 앞, +x = 차량 왼쪽**, 원점 = 차체 중심의 지면 투영점.
- 차량 길이/폭/높이는 `VehicleSpec` 값과 ±2% 이내로 맞출 것(충돌체·센서는 spec 이 기준이며 모델이 바뀌어도 변하지 않는다).
- 스케일 1, 회전/이동 적용(Apply All Transforms) 후 내보내기.

## 로더 연동 현황 (정직한 구분)
- **현재 로더가 실제로 읽는 것**: `Wheel_FL/FR/RL/RR` 노드, `Lamp_*` 재질(점등 연동).
- **아직 로더 미연동(다음 구현 단계 필요)**: `Body` 숨김 처리, `SteeringWheel` 회전, `Cabin_Center/Cluster` 화면 텍스처, `Mirror_*` 렌더 텍스처, `Plate_*` 번호판 교체, 도어. 지금은 절차 모델의 코크핏/미러/번호판만 동작한다. GLB 실내 연결은 Codex 가 노드를 만든 뒤 Claude 가 로더에 연결한다.

## 노드 이름 (정확히 일치)
| 노드 | 용도 |
|---|---|
| `Body` | 차체 루트(1인칭에서 숨김 대상) |
| `Wheel_FL` `Wheel_FR` `Wheel_RL` `Wheel_RR` | 바퀴. 피벗 = 바퀴 축 중심. 회전 축 = 로컬 X. 앞 바퀴는 조향용 부모 피벗 + 자식 롤러로 분리 |
| `SteeringWheel` | 핸들 (피벗 = 조향축, 회전 ±) |
| `Cabin_Center` | 센터 디스플레이 평면 (UV 0–1 전체가 화면, 게임이 캔버스 텍스처를 입힘) |
| `Cabin_Cluster` | 계기판 디스플레이 평면 (동일) |
| `Mirror_L` `Mirror_R` `Mirror_Room` | 미러 유리 평면 (게임이 실시간 렌더 텍스처를 입힘, 법선=반사면 바깥쪽) |
| `Plate_Front` `Plate_Rear` | 번호판 평면/박스 (교체 가능, 520×110 mm) |
| `Door_*` (선택) | 문 |

## 재질 이름 (램프 점등 연동)
`Lamp_Head`, `Lamp_DRL`, `Lamp_Tail`, `Lamp_Rev`, `Lamp_SigL`, `Lamp_SigR` — 이 이름의 재질에 emissive 를 게임이 제어. 램프 메시마다 재질을 분리할 것.
`Plate_KR` — 번호판 재질(게임이 한국형 번호 텍스처로 교체 가능).

## 모바일 목표 (Android WebView)
- 외관 ≤ 60k 삼각형(LOD0), 실내 ≤ 40k, 총 GLB ≤ 12 MB (텍스처 포함), 텍스처 ≤ 2048², 재질 ≤ 24개.
- 드로우콜: 병합 가능한 메시는 재질별로 병합.
- 내보내기: glTF Binary(.glb), Draco/Meshopt 는 로더 설정 추가 전까지 **사용 금지**, 텍스처 JPEG/PNG.

## 검증 방법
1. `public/models/<name>.glb` 로 넣고 `VEHICLE_EXTRAS` 에 `visual: { kind:'glb', url }` 로 등록(`sedan-glb` 참고).
2. `node scripts/e2e-smoke.cjs` 의 GLB 항목(바퀴 4/조향 피벗 2/램프 연결)과 같은 조건 확인.
3. `window.__perfStats()` 로 드로우콜/삼각형 확인(실기기 FPS 아님).
4. 라이선스가 확인되지 않은 파일은 **공개 저장소에 커밋 금지**. `docs/ASSETS.md` 표 기록 필수.
