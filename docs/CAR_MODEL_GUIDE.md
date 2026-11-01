# 차량 GLB 모델 교체 가이드

시각 모델(보이는 차체), **실제 충돌체**, 바퀴, 카메라, 센서 좌표는 서로 **분리**되어 있습니다. GLB를 바꿔도 충돌/센서/판정은 변하지 않습니다.

| 요소 | 정의 위치 | GLB 교체 시 |
|---|---|---|
| 시각 차체 | `carModel.ts` (또는 GLB) | 교체됨 |
| 충돌체 (OBB: length × width) | `VehicleSpec.length/width` | 그대로 (실제 판정 기준) |
| 바퀴 위치/반지름 | `VehicleSpec.wheelbase/trackWidth/wheelRadius` | GLB 바퀴 노드가 있으면 회전/조향만 연결 |
| 카메라 앵커 | `VehicleSpec.driverEye`, `rearCam` | 그대로 |
| 센서 좌표 | `VehicleSpec.sensors` (`defaultSensorLayout`) | 그대로 |

## GLB 제작 규칙

- 단위: **미터**. 원점: 차체 중심의 지면 투영점. **앞 = +Z, 왼쪽 = +X, 위 = +Y**.
- 크기는 `VehicleSpec`의 길이/폭/높이와 거의 같게 만드세요(다르면 충돌체와 모양이 어긋남). `scale` 로 보정 가능.
- 바퀴 노드 이름: `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR` (노드의 원점이 바퀴 회전 중심). 이름이 있으면 주행 시 구르고, 앞바퀴는 조향됩니다. 없으면 바퀴는 정적으로 표시됩니다.
- 압축(Draco/Meshopt/KTX2)은 현재 디코더를 포함하지 않았으므로 **비압축 GLB**를 쓰세요.
- 파일은 `public/models/` 에 넣으면 앱(웹/APK)에 포함되어 오프라인에서도 로드됩니다.

## 사양 등록

`src/vehicle/spec.ts` 의 `make({...})` 로 만든 차량에서 `visual` 을 바꿉니다.

```ts
{
  ...make({ id: 'mycar', name: '내 차', /* 길이/폭/높이/휠베이스 등 */ }),
  visual: { kind: 'glb', body: 'sedan', url: './models/mycar.glb', scale: 1, offset: { x: 0, y: 0, z: 0 }, rotY: 0 },
}
```
그리고 `VEHICLES` 배열에 추가하면 차량 선택 화면에 나타납니다. GLB 로드에 실패하면 자동으로 기본(코드 생성) 모델이 유지됩니다.

## 검증 상태

로더/노드 바인딩 로직은 코드로 만든 최소 GLB로 단위 테스트(`tests/glb.test.ts`)했습니다. **실제 상용급 차량 GLB로는 아직 시험하지 않았습니다.** 첫 모델을 넣을 때 방향(앞 +Z), 스케일, 바퀴 이름을 확인하세요.
