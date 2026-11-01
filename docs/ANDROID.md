# Android (Capacitor)

앱 ID `io.github.parkingsim.app` · 가로 고정(`sensorLandscape`) · 전체화면 몰입 모드 · 플레이 중 화면 꺼짐 방지.
게임 리소스는 모두 앱에 포함되고(`dist` → `assets/public`) 인터넷 없이 실행됩니다. 설정/기록은 WebView localStorage(앱 내부 저장소)에 저장됩니다.

## 현재 검증 상태 (솔직한 기록)

| 항목 | 상태 |
|---|---|
| Capacitor Android 프로젝트 생성 (`cap add android`) | ✅ 생성됨 (`android/`) |
| `cap sync` 로 웹 빌드 동기화 | ✅ 로컬에서 실행됨 |
| **`assembleDebug` APK 빌드** | ❌ **로컬 미실행** — 개발 세션의 네트워크가 `dl.google.com`(Android SDK/AGP)을 차단. GitHub Actions에서 첫 실행 후 확인 필요 |
| 실제 휴대폰 설치/실행 | ❌ **미검증** (가상 모바일 뷰포트 + 터치 이벤트 에뮬레이션으로 웹 UI만 검증) |
| Android WebView GPU 성능 | ❌ **미측정** |

## APK 자동 빌드 (GitHub Actions)

`.github/workflows/android-apk.yml`: Node 22 + JDK 21 + `android-actions/setup-android` → `npm test` → `npm run build` → `npx cap sync android` → `./gradlew assembleDebug`.
- APK는 Actions 실행 화면의 **Artifacts → `parking-simulator-debug-apk-<번호>`** 에서 받습니다.
- 실패 시 `android-build-logs-<번호>` 아티팩트(전체 gradle `--stacktrace --info` 로그 + 리포트)로 원인을 확인합니다.
- `main`, `claude/**` 푸시, PR, 수동 실행(workflow_dispatch)에서 동작합니다.

## 로컬 빌드 (Windows PowerShell, Android Studio/SDK 설치 시)

```powershell
npm install
npm run build
npx cap sync android
cd android
.\gradlew.bat assembleDebug
# 결과: android\app\build\outputs\apk\debug\app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

## 버전 코드와 앱 서명 (기존 데이터 보존)

안드로이드는 **같은 서명키 + 더 큰 versionCode** 일 때만 기존 설치를 지우지 않고 업데이트합니다. 서명이 바뀌면 삭제 후 재설치해야 하며 저장된 기록이 사라집니다.

- **versionCode**: CI가 `-PversionCode=${{ github.run_number }}` 로 매 실행 증가시킵니다. 로컬 기본값은 1. 수동으로 올리려면 `-PversionCode=123 -PversionName=0.2.0`.
- **디버그 APK 서명**: 저장소에 포함된 **공개 디버그 키스토어** `android/app/debug.keystore` (비밀번호 `android`, alias `androiddebugkey`)로 항상 같은 키로 서명됩니다. 테스트 배포용이며 비밀이 아닙니다(누구나 같은 키로 서명 가능 → 스토어/실사용 배포에 쓰지 마세요).
- **릴리스 서명 (스토어 배포 시)**: 비공개 키스토어를 만들고 **절대 커밋하지 마세요**(`.gitignore`에 `*.keystore` 제외 규칙).
  1. `keytool -genkeypair -v -keystore release.keystore -alias parksim -keyalg RSA -keysize 2048 -validity 10000`
  2. 키스토어를 base64로 변환해 GitHub Secrets에 등록: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
  3. 워크플로에서 base64를 복원해 `ANDROID_KEYSTORE_PATH` 환경변수로 지정하면 `android/app/build.gradle` 의 `release` 서명 설정이 활성화됩니다 (`assembleRelease`).
  4. **키스토어 파일과 비밀번호를 안전한 곳에 백업**하세요. 분실하면 같은 앱으로 업데이트할 수 없습니다.

## 설계 메모

- 화면 비율: HUD는 `max-height: 480px` 일 때 컴팩트 레이아웃, 터치 버튼은 78dp 이상(설정에서 70~150% 조절), 안전영역(`safe-area-inset`) 반영.
- GPU 부담 완화: 설정의 렌더링 해상도/그림자/센서 화면 FPS. 기본 "보통" 프리셋. 터치 기기에서 FPS가 낮으면 "낮음" 프리셋을 쓰세요.
- 경고음(WebAudio)은 첫 터치 이후 활성화됩니다(게임 시작 버튼에서 초기화).
