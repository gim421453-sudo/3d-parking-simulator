# Blender → GLB 파이프라인 (준비 문서)

이번 업데이트에서는 **Blender 파이프라인을 문서로 준비**했고, 실제 Blender 모델은 만들지 않았습니다. 코드 쪽 GLB 로딩 경로(`carModel.ts#applyGlbVisual`)는 합성 GLB 로 단위 테스트(`tests/glb.test.ts`)했습니다.

## 1. 원본(.blend) 관리 정책
- 원본은 `art/` 디렉터리에 둡니다: `art/cars/<id>.blend`, `art/maps/<id>.blend`, `art/props/…`.
- `.blend` 는 바이너리라 diff 가 안 되므로 **Git LFS 사용을 권장**합니다. LFS 를 쓰지 않으면 파일 하나를 1~10MB 이하로 유지하고, 원본과 GLB 를 같은 커밋에 함께 올립니다.
- 텍스처 원본(PNG/EXR)은 `art/textures/` 에, **게임에 들어가는 것은 `public/models/` 의 GLB 만** 둡니다. (`art/` 는 앱/APK 에 포함하지 않음)
- 모든 에셋은 출처·라이선스를 `docs/ASSETS.md` 표에 기록합니다. 직접 제작한 것은 "자체 제작"으로 기록.

## 2. 좌표계·스케일·피벗 (프로젝트 규칙과 일치)
| 항목 | 규칙 |
|---|---|
| 단위 | **미터**, Blender Scene Units = Metric, Unit Scale 1.0 |
| 앞 방향 | 게임에서 **+Z 가 차량 앞**, +X 가 왼쪽, +Y 가 위 |
| Blender 축 | Blender 는 Z-up. glTF 내보내기에서 **"+Y Up" 옵션을 켜면** 자동 변환. 모델링 시 차량 앞을 Blender **-Y**(= glTF +Z) 로 두면 일치 |
| 원점(피벗) | 차량: **차체 중심의 지면 투영점**(바닥 y=0). 바퀴 노드는 **바퀴 회전 중심**이 노드 원점 |
| 스케일 | 적용(Apply All Transforms: Ctrl+A) 후 내보내기. 크기는 `VehicleSpec` 의 길이/폭/높이와 일치(±2%) |

## 3. 움직이는 부품 분리 (노드 이름 규약)
차량 GLB 는 하나의 메시가 아니라 **이름 있는 노드**로 구성합니다.

| 노드 이름 | 용도 | 비고 |
|---|---|---|
| `Body` (+ 하위 `Glass`, `Mirror_L/R`) | 차체/유리/미러 | 1인칭 카메라에서는 숨김 처리 대상 |
| `Wheel_FL` `Wheel_FR` `Wheel_RL` `Wheel_RR` | 바퀴 | 원점=회전 중심. 코드가 앞바퀴를 조향, 모든 바퀴를 회전(X축) |
| `Lamp_Head_L/R`, `Lamp_DRL_L/R`, `Lamp_Tail_L/R`, `Lamp_Brake_*`, `Lamp_Reverse_*`, `Lamp_Turn_*_*` | 램프 | **독립 재질**(발광 켜짐/꺼짐 제어용). 현재 로더는 바퀴만 연결 — 램프 연결은 후속 작업(`lighting.ts` 출력과 매핑) |
| `Cockpit` | 실내(대시/핸들) | 후속 작업 |

충돌체·센서·카메라 좌표는 GLB 에 넣지 않고 `VehicleSpec` 에서 정의합니다(엔진 독립, `export/vehicles.json` 로 내보냄).

## 4. glTF/GLB 내보내기 설정 (Blender → File → Export → glTF 2.0)
- Format: **glTF Binary (.glb)**
- Include: Selected Objects(필요 시), Custom Properties OFF
- Transform: **+Y Up** ON
- Geometry: Apply Modifiers ON, UVs ON, Normals ON, Tangents OFF(노멀맵 쓸 때만), Vertex Colors OFF
- Material: Export 활성, 이미지는 **WebP 또는 JPEG/PNG**, **Draco/Meshopt 압축은 현재 로더가 디코더를 포함하지 않으므로 OFF**(압축 도입 시 `DRACOLoader`/`MeshoptDecoder` 추가 필요)
- Animation: OFF (바퀴는 코드에서 회전)

## 5. 모바일 최적화 기준 (권장 예산)
| 항목 | 차량 1대 | 맵 1개 |
|---|---|---|
| 삼각형 | ≤ 30k (주차된 장애물 차량은 LOD ≤ 8k) | ≤ 150k (정적 병합) |
| 머티리얼 | ≤ 6 | 재질별 병합, 텍스처 아틀라스 |
| 텍스처 | 1024² 이하 (모바일 품질 프리셋은 512²) | 아틀라스 2048² 이하 |
| 드로우콜 | ≤ 20 | 반복 물체는 InstancedMesh |
- 그림자 맵 대신 블롭 그림자를 쓸 수 있도록 바닥 접지 면 단순 유지, 보이지 않는 면 삭제, 법선 일관성 점검.
- 검증: 로드 후 `renderer.info.render.triangles/calls` 확인, Android 실기기 FPS 측정(설정 → FPS 표시).

## 6. 검증 체크리스트
1. 앞이 +Z, 크기가 `VehicleSpec` 과 일치하는가 (3D 뷰에서 충돌 박스와 겹쳐 보기)
2. `Wheel_*` 4개가 있고 회전 중심이 맞는가 (게임에서 구름/조향 확인)
3. GLB 크기(MB), 삼각형 수, 머티리얼 수 기록
4. `docs/ASSETS.md` 에 출처/라이선스 기록
5. `npm test` (glb 로더 테스트) + 실제 화면 스크린샷
