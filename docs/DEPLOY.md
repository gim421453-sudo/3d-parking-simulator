# 웹 플레이 / 배포 / GitHub Actions 정책

## 1. GitHub Actions 사용 정책 (사용량 최소화)

| 워크플로 | 트리거 | 비고 |
|---|---|---|
| `android-apk.yml` | **수동(workflow_dispatch)만** | push/PR 로 자동 실행하지 않음. 테스트 단계 없음(로컬에서 먼저 통과시킬 것). APK 30일, 실패 로그는 실패 시에만 7일 보관 |
| `pages.yml` | **수동만** | push 마다 배포하지 않음. artifact 3일 |
| `ci.yml` | 수동, 또는 기본 브랜치 대상 PR 이 **열릴 때/Ready for review** 로 바뀔 때 | 초안 PR·문서/스크린샷만 바뀐 PR 제외 |

- 모든 워크플로: `concurrency`(같은 그룹은 이전 실행 취소) + `timeout-minutes` + npm/Gradle 캐시.
- **일반 push 로는 어떤 워크플로도 실행되지 않습니다.** 워크플로 파일을 고치는 커밋에는 `[skip ci]` 를 붙여 연쇄 실행을 막았습니다.
- 검증은 로컬에서: `npm run typecheck && npm test && npm run build && node scripts/e2e-smoke.cjs && npm run verify:pages`.
- Actions 가 필요하면 **목적을 먼저 밝히고** 한 번만 실행합니다. (예: "실기기 테스트용 최신 APK" → `android-apk.yml` 수동 1회)
- 이미 성공한 APK 아티팩트(`parking-simulator-debug-apk-1`, `-2`)는 삭제하지 않았습니다. **보관 30일(2026-12-01경 만료)** 이므로 필요하면 그 전에 내려받으세요.

## 2. GitHub Pages 가능 여부 (확인 결과)

확인한 사실 (GitHub API/저장소 정보):
- 저장소 `gim421453-sudo/3d-parking-simulator`: **비공개(private)**, 소유자 유형 **개인(User)**, 기본 브랜치 `claude/compassionate-fermi-i6emhr`, `has_pages: false`(Pages 아직 꺼져 있음).
- **계정 요금제는 API 로 확인되지 않았습니다.**

알려진 조건 (GitHub 문서 기준 — 이 세션에서 문서를 직접 열어 확인하지는 못함, 설정 화면에서 재확인 필요):
- **비공개 저장소에서 Pages 를 쓰려면 GitHub Pro / Team / Enterprise 요금제가 필요**합니다. Free 개인 계정은 공개 저장소만 지원합니다.
- **Pages 사이트는 저장소가 비공개여도 URL 을 아는 누구나 접근**할 수 있습니다(Enterprise Cloud 의 접근 제어 기능 제외). 배포된 정적 파일과 클라이언트 JavaScript 도 누구나 내려받을 수 있습니다.
- `github-pages` 환경에 "배포 허용 브랜치" 규칙이 있으면 `feature/*` 브랜치에서의 배포가 거부될 수 있습니다.

→ **이번에는 Pages 배포를 실행하지 않았습니다.** 요금제 확인 전에 실행하면 Actions 를 소모하고 실패할 가능성이 높습니다. 허가 없이 저장소를 공개로 바꾸거나 새 공개 저장소를 만들지 않았습니다.

### 직접 확인하는 방법 (1분)
저장소 → Settings → Pages: "Build and deployment → Source" 를 선택할 수 있으면 지원되는 것이고, 업그레이드 안내가 나오면 현재 요금제에서는 비공개 저장소 Pages 가 지원되지 않는 것입니다.

### 배포 전 로컬 검증 (완료)
`npm run build && npm run verify:pages` — dist 를 `/3d-parking-simulator/` 하위 경로에서만 서빙해 Pages 와 같은 조건을 재현합니다.
확인 항목: 하위 경로 로드, JS/CSS 상대 경로, WebGL 렌더링(삼각형 수), 하위 경로의 localStorage 유지, base 밖 요청 없음, 요청 실패/콘솔 오류 없음.

## 3. 원본을 비공개로 유지하는 방법 (제안)

| 방법 | 장단점 |
|---|---|
| **A. 로컬 개발 서버로 휴대폰/다른 PC 에서 테스트** (추천, 무료·비공개) | PC: `npm run dev -- --host` → 같은 Wi-Fi 의 폰 브라우저에서 `http://<PC IP>:5173`. 인터넷에 올라가지 않음. 경고음은 첫 터치 이후 동작. 같은 네트워크에서만 접속 |
| B. APK (이미 가능) | Actions 수동 실행 1회 → 폰에 설치. 오프라인 실행. 2026-11-03 ADB 테스트에 사용 |
| C. 접근 제어가 있는 정적 호스팅 | Cloudflare Pages + Cloudflare Access, Netlify/Vercel 비밀번호 보호(유료 플랜 필요한 경우 있음) 등. 계정/비용은 사용자 결정이며 제가 임의로 만들지 않음 |
| D. Pages (요금제 확인 후) | Pro 이상이면 비공개 저장소로 가능하나 **사이트는 공개**됨 |
| E. 저장소를 공개로 전환 | **사용자 허가가 있어야만** 가능. 코드 공개 + Free 계정에서도 Pages 사용 가능. 저장소에 비밀은 없음(공개 디버그 키스토어만 포함 — 릴리스 키는 별도 관리) |

## 4. 로컬 테스트 방법 (Windows PowerShell)

```powershell
npm install
npm run dev                 # http://localhost:5173
npm run dev -- --host       # 같은 Wi-Fi 의 폰에서 접속 (방화벽에서 5173 허용 필요할 수 있음)
npm run build; npm run preview
npm run verify:pages        # Pages 하위 경로 조건 재현 검증 (Playwright 필요)
```
