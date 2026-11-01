# AGENTS.md — 3D 주차 시뮬레이터 (Codex / Claude 공용 작업 안내)

작업을 시작하기 전에 `HANDOFF.md`(현재 상태·남은 일·알려진 버그)를 먼저 읽고, 끝나면 `HANDOFF.md`와 이 파일을 함께 갱신하세요.

## 프로젝트 한눈에

- TypeScript + Vite + Three.js. 웹(GitHub Pages)과 Android(Capacitor)를 같은 코드로 지원.
- 핵심 가치: **실시간 3D 주차 센서**. 센서 거리는 반드시 충돌체 기하 데이터(`Collider`)의 레이캐스트 결과여야 하며 임의 값 금지.
- 외부 에셋 없음(모든 모델/텍스처는 코드 생성). 외부 에셋을 추가하면 `docs/ASSETS.md` 표에 출처/라이선스를 기록.
- 외부 유료 API/로그인 없음, 오프라인 동작.

## 명령어 (Windows PowerShell 기준)

```powershell
npm install
npm run dev          # 개발 서버
npm run typecheck    # tsc --noEmit
npm test             # vitest 단위 테스트
npm run export:data  # 엔진 독립 JSON 내보내기 (export/)
npm run build        # 타입검사 + 빌드 → dist/
node scripts/e2e-smoke.cjs   # 브라우저 통합 테스트 (Playwright 필요, dist 필요)
npm run cap:sync     # 웹 빌드 후 Android 프로젝트 동기화
```

변경 후 최소 `npm run typecheck && npm test && npm run build` 를 통과시킬 것. 동작/UI를 바꿨다면 e2e 도 실행.

## 코드 규칙 (어기면 버그가 나는 것들)

1. **좌표 규칙** (`src/core/math.ts` 상단): `heading 0` = +z 방향, 증가하면 왼쪽 회전. 차량 로컬 +x = 왼쪽, +z = 앞. `localToWorld`/`worldToLocal` 만 사용해서 변환할 것.
2. **차량 상태 (x,z)는 뒷축 중심**, 충돌 OBB 중심은 `centerOf()`. 센서/카메라/미션은 차체 중심 pose 를 쓴다.
3. 시각 모델 / 충돌체 / 바퀴 / 카메라 / 센서 좌표는 **분리**되어 있다 (`VehicleSpec`). 시각 모델을 바꿔도 충돌·센서·판정이 변하면 안 된다.
4. 맵은 순수 데이터(`src/maps/*.ts`). 렌더링·충돌·센서·미니맵·미션이 같은 데이터를 읽는다. 새 맵은 `MAPS`에 추가하면 `tests/maps.test.ts` 가 자동 검증.
5. 센서 높이(0.55m) 기준: 높이 구간에 들어오지 않는 물체(낮은 연석, 천장 물체)는 **감지 안 됨이 정상**. 차체 충돌은 지상고(0.2m) 기준. 둘은 의도적으로 다르다.
6. 충돌 처리: 스텝(1/120s) 후 겹치면 이전 자세로 복원 + 속도 0. 관통 방지는 작은 스텝에 의존하므로 얇은 벽(<0.3m)은 만들지 말 것.
7. 키보드와 화면 버튼은 같은 `Action` 경로(`Game.onAction`)를 통해야 한다. 새 기능은 `Action` 에 추가하고 양쪽에서 연결.
8. 설정/기록은 `core/settings.ts` 를 통해서만 저장(예외 안전). 새 설정은 `sanitizeSettings` 범위 보정까지 추가.
9. 테스트에서 "시간"이 아니라 "게임 상태"를 기다릴 것 (소프트웨어 WebGL 은 느려 게임 시간이 실시간보다 느리게 흐른다).
10. 비밀(키스토어, 비밀번호)은 커밋 금지. 공개 디버그 키스토어(`android/app/debug.keystore`)만 예외.
11. **일반 화면에 거리(m) 숫자를 표시하지 말 것.** 거리는 내부 계산 전용이고 숫자는 `sensorDebug` 에서만 DOM 에 넣는다. `PdcState` 에 거리 필드를 추가하지 말 것 (`tests/pdc.test.ts`, e2e 가 검사).
12. 주차 보조 패널(`#parking-assist`)의 DOM/사이드 버튼은 **고정**이다. 카메라/기어/PDC 상태 변화는 내용만 갱신하고 요소를 재생성하거나 위치를 바꾸지 말 것. 서라운드뷰를 구현하기 전에는 360° 관련 UI/영상을 만들지 말 것.
13. 주차 보조 표시 규칙은 `pdc/assistPolicy.ts`(순수 로직)에만 둔다. Game 은 결과(`assistOut`)만 소비한다. 규칙을 바꾸면 `tests/pdc.test.ts` 와 `docs/PDC_DISPLAY.md` 표를 함께 수정.
14. 조명 규칙은 `vehicle/lighting.ts`(순수 로직). AUTO Leveling 은 가속도 기반 근사이며 실제 피치 물리가 아니다 — 이름/문서에서 구분할 것. 구현하지 않은 기능(오토 상향등, AFS)을 완성된 것처럼 표시하지 말 것.
15. 엔진 독립 데이터(`npm run export:data` → `export/*.json`)는 Unity 이식 대비용이다. 제원/센서/맵 형식을 바꾸면 export 스크립트도 확인.

## 디렉터리

`src/core`(수학/기하/저장/설정) · `src/vehicle`(spec/physics/carModel) · `src/sensors`(센서/경고음/3D 센서 화면) · `src/pdc`(주차 보조 디스플레이: 모델/정책/가이드라인/패널) · `src/mission`(판정/점수) · `src/maps`(맵 데이터+빌더) · `src/game`(루프/입력/카메라) · `src/ui`(HUD/메뉴/미니맵) · `tests` · `scripts` · `android` · `docs`

## 변경 이력 (최근 순)

- v0.2.0-dev (`feature/pdc-display-v2`): 주차 보조 디스플레이(후방/전방카메라 + PDC 탑뷰 + 고정 사이드 버튼 + 동적 가이드라인), R/D 자동 전환 정책, 일반 화면 거리 숫자 제거(디버그 전용), 조명 모드(OFF/미등/하향/상향/AUTO)·DRL·AUTO Leveling(근사), 전방 카메라 모드, 벡터 아이콘 HUD, 엔진 독립 데이터 export. 자세한 내용은 `docs/PDC_DISPLAY.md`.
- v0.1.0: 최초 플레이 가능 버전. 웹 게임 전체(주행/카메라5/센서/미션8/맵3/UI/설정·기록), Capacitor Android 프로젝트 + APK 워크플로(Actions에서 첫 실행 필요), Pages 워크플로, 단위 테스트 65개, 브라우저 E2E.
