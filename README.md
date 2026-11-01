# 🅿 3D 주차 시뮬레이터

브라우저와 Android에서 플레이하는 Three.js 기반 3D 주차 시뮬레이터입니다.
핵심 기능은 **실시간 3D 주차 센서**입니다. 센서 거리는 게임 물리 공간의 충돌체 기하 데이터를 레이캐스트해서 계산하며, 임의로 만든 값을 표시하지 않습니다.

> TypeScript + Vite + Three.js · 오프라인 싱글플레이 · 로그인/외부 API 없음 · 모든 모델/텍스처는 코드로 생성(저작권 이슈 없음)

<p align="center">
  <img src="docs/screenshots/32-assist-R.png" width="45%" alt="R: 후방카메라 + PDC 주차 보조">
  <img src="docs/screenshots/33-assist-D.png" width="45%" alt="D: 같은 화면, 전방카메라로 전환">
  <img src="docs/screenshots/34-assist-guides.png" width="45%" alt="조향 연동 주차 가이드라인">
  <img src="docs/screenshots/93-mobile-assist.png" width="45%" alt="모바일 가로 화면의 주차 보조">
</p>

## 빠른 실행 (Windows PowerShell)

```powershell
npm install
npm run dev        # http://localhost:5173
```

```powershell
npm run build      # 타입검사 + 프로덕션 빌드 → dist/
npm run preview    # 빌드 결과 확인
npm test           # 단위 테스트
```

필요 환경: Node.js 22+ (Capacitor 8 요구), Android 빌드는 JDK 21.

## 조작법

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| W / ↑ | 가속 | C | 카메라 변경 |
| S / ↓ | 브레이크 | M | 미니맵 (작게/크게/숨김) |
| A, D / ←, → | 좌/우 조향 | V | 주차 센서 화면 (작게/크게/숨김) |
| F | 전진 (D) | Q / E | 좌/우 방향지시등 |
| R | 후진 (R) | H | 비상등 |
| P | 주차 (P) | L | 전조등 |
| N | 중립 (N) | T | 차량 초기화 |
| Space | 주차 브레이크 | Esc | 일시정지 |

- 주행 중에는 반대 방향 기어(전진↔후진)와 P로 바꿀 수 없습니다. 2km/h 이하로 정차 후 변경하세요. P에서는 차가 움직이지 않습니다.
- 화면의 P/R/N/D 버튼, 방향지시등/비상등/전조등/주차브레이크 버튼은 키보드와 **같은 동작 경로**를 씁니다.
- 모바일(터치): 좌하단 ◀ ▶ 조향, 우하단 브레이크/가속, 가운데 계기판의 P/R/N/D 버튼. 멀티터치(가속 + 조향 동시) 지원.
- 마우스: 자유 시점에서 드래그 = 회전, 휠 = 줌. 센서 화면에서 드래그 = 회전, 휠/두 손가락 = 확대·축소, 더블클릭 = 시점 초기화.

## 구현된 기능

**주행**: 가속/제동/후진/조향 및 조향 복귀, P/R/N/D 기어(속도 조건으로 전환 제한), 주차 브레이크, 크리프, 전조등·브레이크등·후진등·좌우 방향지시등·비상등, 속도계/조향각 표시, 차량 3종(소형 해치백·중형 세단·SUV), 벽/기둥/콘/주차 차량 충돌, 맵 경계 이탈 방지, T로 초기화.

**카메라 6종**: 3인칭 추적 · 운전석 1인칭(대시보드/핸들) · 탑뷰 · 후방 · 전방 · 자유 시점.

**주차 보조 디스플레이 (v0.2)** — [상세 문서](docs/PDC_DISPLAY.md)
- **R 선택 → 후방카메라 + PDC 자동 표시**, **D 선택(저속) → 같은 화면에서 전방카메라로 전환**. 레이아웃과 우측 사이드 버튼 위치는 항상 고정.
- 카메라 영상은 게임 3D 장면의 실시간 렌더링, PDC 구역은 센서(충돌체 레이캐스트) 결과로만 점등. 조향 연동 동적 가이드라인.
- **일반 화면에는 거리(m) 숫자를 표시하지 않음**(방향·색·경고음 간격·단계만). 숫자는 설정의 디버그 모드에서만.
- D 유지 속도/P 종료 지연/자동 표시 on·off/PDC 색상 3종/카메라 갱신 FPS를 설정에서 변경. 서라운드뷰는 **아직 없음**(가짜 360° UI 없음).
- 조명: OFF/미등/하향/상향/AUTO + DRL + 실제 스포트라이트, AUTO Leveling(가속도 기반 근사). 오토 상향등은 미구현.

**3D 주차 센서 (핵심)**
- 센서 12개(앞 4 · 뒤 4 · 좌 2 · 우 2), 센서당 5° 간격 광선 부채꼴. 장애물 방향·거리(m)는 충돌체와의 레이캐스트로 계산.
- 차량 중심 3D 화면: 단계별 색(초록→노랑→주황→빨강), 감지된 히트 지점, 측정된 범위만 박스로 표시(미측정 형상은 확정하지 않음). 거리 숫자는 디버그에서만.
- 경고음: 가까울수록 간격이 짧아지고 위험 거리 이하에서 연속음. R에서는 후방+측면, D 저속(10km/h 미만)에서는 전방+측면이 대상.
- 센서/경고음 개별 ON/OFF, 최대 감지 거리·연속 경고 거리 설정.
- 미검출 영역 표시: 센서 범위 밖, **낮은 연석(55cm 미만)**, 천장 물체는 감지하지 못한다고 화면에 명시. 자차와 지면은 충돌체가 아니므로 감지되지 않음.
- 디버그 모드(설정, 개발자용): 감지 광선, 센서 방향 화살표, 센서별 거리(m 소수 3자리)·충돌 대상 id 표시.

**맵 3종 (데이터 기반)**: 기본 주차 연습장 · 지하 주차장(좁은 구획 2.3m, 기둥, 조명) · 야외 주차장(도로/건물/가로등/자유주행 구역). 미니맵에 내 차 위치·방향·목표 구획 표시.

**미션**: 전면 직각주차 · 후진 직각주차 · 평행주차(맵별 총 8개) + 자유주행. 판정은 차량 **네 모서리가 모두 구획 안**, 방향 오차(직각 ±10°, 평행 ±8°), 정차 1.5초 유지. 점수 = 기본 200 + 정확도 ≤500 + 시간 ≤300 − 충돌당 100. 결과 화면(별, 점수, 정확도, 시간, 충돌), 재시도/다음 미션, 최고 기록 저장.

**UI**: 한국어 메인 메뉴(시작/맵·미션/차량/설정/조작법), HUD(속도계, 기어, 조향, 주차브레이크, 방향지시등, 미니맵, 미션 상태, 센서 화면, 카메라 변경, 일시정지/재시작), 설정/기록은 localStorage에 저장.

**성능/모바일**: 해상도 스케일, 그림자 품질(끔/낮음/보통/높음), 텍스처 해상도(품질 프리셋), InstancedMesh(콘·드럼), 주차선 지오메트리 병합, 센서 3D 화면 갱신 FPS 조절, FPS/평균 FPS 표시, 터치 버튼 크기 조절, 낮은 화면(가로 모바일)용 컴팩트 HUD.

## 프로젝트 구조

```
src/
  core/      math(좌표 규칙), geometry(OBB/레이캐스트), storage, settings
  vehicle/   spec(충돌체·바퀴·카메라·센서 좌표 분리), physics, carModel(+GLB 교체)
  sensors/   sensorSystem(레이캐스트·경고 단계·경고음 간격), beeper, SensorView(3D 센서 화면)
  pdc/       pdcModel(구역/단계/팔레트), assistPolicy(R/D 표시 정책), guidelines(조향 경로), assistPanel(UI)
  mission/   parking(판정·점수·미션 진행)
  maps/      types, helpers, mapLot/mapUnderground/mapOutdoor (순수 데이터), mapBuilder(three), textures
  game/      Game(루프/충돌/통합), input, cameras
  ui/        hud, menu, minimap
tests/       vitest 단위 테스트
scripts/     e2e-smoke.cjs (Playwright 브라우저 통합 테스트)
android/     Capacitor Android 프로젝트
docs/        ASSETS / CAR_MODEL_GUIDE / MAP_GUIDE / ANDROID / TESTING
```

## 테스트

```powershell
npm run typecheck
npm test                      # 단위 테스트 104개
npm run export:data           # 엔진 독립 JSON(export/) — Unity 이식 대비
npm run build; node scripts/e2e-smoke.cjs   # 브라우저 통합 테스트 104개 (Playwright 필요)
```

결과와 미검증 항목은 [docs/TESTING.md](docs/TESTING.md) 참고.

## 배포

- **GitHub Pages**: `.github/workflows/pages.yml` (main 푸시 시 배포). 저장소 *Settings → Pages → Source = GitHub Actions* 로 한 번 설정해야 합니다. 설정 전에는 배포되지 않습니다.
- **Android APK**: `.github/workflows/android-apk.yml` 이 Android SDK 설정 → 웹 빌드 → `cap sync` → `assembleDebug` 후 APK를 Artifact로 올립니다. 자세한 내용과 서명/버전 관리: [docs/ANDROID.md](docs/ANDROID.md).

## 문서

- [주차 보조 디스플레이](docs/PDC_DISPLAY.md) · [에셋 출처/라이선스](docs/ASSETS.md) · [차량 GLB 교체 가이드](docs/CAR_MODEL_GUIDE.md) · [맵 추가 가이드](docs/MAP_GUIDE.md) · [Android](docs/ANDROID.md) · [테스트 결과](docs/TESTING.md) · [인수인계](HANDOFF.md)
