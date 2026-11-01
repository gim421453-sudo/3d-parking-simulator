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
npm test             # vitest 단위 테스트 (65개)
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

## 디렉터리

`src/core`(수학/기하/저장/설정) · `src/vehicle`(spec/physics/carModel) · `src/sensors`(센서/경고음/3D 센서 화면) · `src/mission`(판정/점수) · `src/maps`(맵 데이터+빌더) · `src/game`(루프/입력/카메라) · `src/ui`(HUD/메뉴/미니맵) · `tests` · `scripts` · `android` · `docs`

## 변경 이력 (최근 순)

- v0.1.0: 최초 플레이 가능 버전. 웹 게임 전체(주행/카메라5/센서/미션8/맵3/UI/설정·기록), Capacitor Android 프로젝트 + APK 워크플로(Actions에서 첫 실행 필요), Pages 워크플로, 단위 테스트 65개, 브라우저 E2E.
