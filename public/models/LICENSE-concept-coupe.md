# concept-coupe.glb — 출처/라이선스/변경 고지

- 모델: **Car Concept** — KhronosGroup/glTF-Sample-Assets `Models/CarConcept/glTF-Binary/CarConcept.glb`
  - https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept
- 원본 파일: 11,778,688 bytes, SHA-256 `c272098089d78c5cd9fd9f24ff50ee8acf8d932c55f2d55fc10adb6c8998966b`
- 저작자: Khronos Group(glTF 변환·최적화) — 기반 3D 모델 "Free Concept Car 004" 은 **Unity Fan 의 퍼블릭 도메인(CC0)** 모델
  (https://sketchfab.com/3d-models/free-concept-car-004-public-domain-cc0-4cba124633eb494eadc3bb0c4660ad7e)
- 라이선스: Khronos 가 만든 파일은 **CC-BY-4.0** (https://creativecommons.org/licenses/by/4.0/legalcode). 재배포·수정 허용, 저작자 표시 + 변경 고지 필요.
  - 이 라이선스는 로고/상표(Khronos 마크)를 포함하지 않는다(`LICENSE.md` 원문: "This license excludes logos and associated trademarks"). 변환본에서는 원본에 있던 실내(스티어링 엠블럼 포함)를 모두 제거했다.
- **BMW 원본이 아니다.** BMW M4 G82(Sketchfab)는 다운로드에 로그인/토큰이 필요해 확보하지 못했다(접근 제한을 우회하지 않음).

## 이 저장소에 포함된 변환본 (`concept-coupe.glb`, 3,156,712 bytes, SHA-256 `79a09c8bec4b53140d3d39becb0cc2d4e3e49921ec6da53888d0d566d32e7be4`)
변경 내역(CC-BY 4.0 의 "indicate if changes were made"): `scripts/prepare-car-glb.mjs`
1. 실내/엔진/와이퍼/번호판/후드 안쪽/차축 노드 제거 (게임이 자체 코크핏·한국형 번호판을 사용)
2. 루트의 Z-up 변환을 정점에 구워 Y-up 로 정리, 앞바퀴가 원본에서 약 30° 조향된 포즈였던 것을 직진으로 되돌림, 바퀴 노드를 `Wheel_FL/FR/RL/RR`(피벗 = 바퀴 중심)로 개명
3. 램프 재질을 `Lamp_Head`/`Lamp_Tail`/`Lamp_SigL`/`Lamp_SigR` 로 개명, 후미 방향지시등 메시를 좌/우로 분리
4. 유리의 transmission, 도장의 iridescence, material variants 확장 제거(모바일 성능)
5. 메시 단순화(meshoptimizer, 비율 0.45) — 약 21.3만 → 약 6.7만 삼각형, 텍스처 1024px 이하 WebP 로 변환
