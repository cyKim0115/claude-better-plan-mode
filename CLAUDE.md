# Better Plan Mode

Next.js 15 (App Router) + React 19 + TypeScript. 웹 계획표 보드에서 Claude가 플랜을 세우고, 코멘트를 반영하고, 선택한 태스크만 로컬 `claude -p`로 착수시키는 앱이다.
사용자 안내 문서는 `README.md`와 `docs/site/`(GitBook 소스)에 있다.

## 구조

| 경로 | 역할 |
|---|---|
| `lib/types.ts` | Plan / PlanTask / PlanComment / Run 데이터 모델 (단일 소스) |
| `lib/store.ts` | `data/plans/*.json` 파일 스토어 |
| `lib/agent.ts` | Agent SDK로 플랜 생성·revise (읽기 전용 툴만) |
| `lib/runner.ts` | `claude -p` 스폰, stream-json 파싱, 인메모리 런 레지스트리 |
| `lib/stream-json.ts` | stream-json → 로그 항목 공용 변환기 (runner는 마커 처리 때문에 자체 포맷터 유지) |
| `lib/jobs.ts` | 원격 워커 잡 — `data/jobs/*.json` 저장, 프로젝트별 직렬 큐, worktree → claude -p → 커밋 → 검증 → push/PR |
| `lib/notify.ts` | Slack(Block Kit)·Discord 웹훅 알림 — 공급자 중립 `Notice` → `toSlack`/`toDiscord` (미설정 시 no-op) |
| `lib/screenshot.ts` | 워커 PC 화면 캡처 |
| `lib/tunnel.ts` | ngrok 공개 URL |
| `app/api/**` | REST 엔드포인트 (`jobs`, `screenshots` 포함) |
| `components/PlanBoard.tsx` | 보드 UI |
| `components/JobList.tsx`, `JobView.tsx` | 워커 잡 목록·상세 UI |
| `mcp/server.mjs` | MCP 서버(stdio) — 온디맨드 보드 서버 스폰, `plan_create` 등 툴 |
| `mcp/worker.mjs` | 원격 워커 MCP 서버(Streamable HTTP, Bearer 토큰) — 보드 `/api/jobs` 프록시 |
| `config/projects.json` | 워커가 다룰 프로젝트 목록 (gitignore, 예시는 `projects.example.json`) |
| `deploy/launchd/` | macOS LaunchAgent 등록 스크립트·템플릿 |

## 상시 규칙

**시크릿·로컬 데이터**: `.env.local`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `WORKER_TOKEN`, ngrok 토큰, `ANTHROPIC_API_KEY` 값을 읽거나 출력하거나 커밋하지 않는다. `data/`는 gitignore된 실사용자 플랜·잡 데이터, `config/projects.json`은 로컬 경로가 든 설정 — 예시가 필요하면 새 파일을 만들지 말고 구조만 `lib/types.ts`·`projects.example.json`에서 인용한다.

**워커 잡**: `lib/jobs.ts`는 셸 문자열 보간 없이 인자 배열로만 `git`/`gh`/`claude`를 스폰한다 (잡 제목·프롬프트는 신뢰 입력이 아니다). `direct` 모드는 `projects.json`의 `allowDirect: true`일 때만 열린다 — 기본값을 바꾸지 않는다. 잡 상태 전이(`queued → running → succeeded|failed|cancelled`)와 단계(`stage`)는 `runJob`이 소유한다. `mcp/worker.mjs`는 `WORKER_TOKEN` 없이는 기동을 거부한다 — 이 검사를 빼지 않는다.

**TypeScript**: `any` 금지 (`unknown` + 좁히기). 외부 경계(Agent 응답, MCP 인자, 요청 본문)는 파싱 후 검증한다 — `lib/agent.ts`의 `extractJson` + Raw* 인터페이스 패턴을 따른다. 서버 전용 모듈(`lib/store.ts`, `lib/runner.ts`)을 클라이언트 컴포넌트에서 import하지 않는다.

**상태**: 런 로그는 인메모리(`globalThis.__runs`)라 서버 재시작 시 사라진다 — 단일 서버 프로세스 전제를 깨는 코드를 넣지 않는다. 플랜 변경은 반드시 `savePlan`을 거치고 `updatedAt`을 갱신한다.

**알림**: 웹훅 호출은 fire-and-forget(`void notify...()`)이며 실패해도 본 흐름을 막지 않는다. 이 규칙을 깨고 `await`로 응답 경로를 막지 않는다. 새 알림은 공급자별 JSON을 직접 짜지 말고 `Notice`를 만들어 `sendNotice`에 넘긴다 — Slack 포맷 규칙은 `slack-webhook-message` 스킬.

**이모지**: 코드 주석·로그·커밋 메시지에는 쓰지 않는다. Slack·Discord 페이로드와 UI 문구는 예외(기존 `lib/notify.ts` 스타일 유지).

**문서 톤**: `README.md`·`docs/site/**`는 존댓말(`~합니다`, `~하세요`). 상세는 `readme-tone` 스킬.

**커밋**: 한국어. 이 저장소 히스토리는 `feat: 계획표 수정 완료 시 Discord 웹훅 알림` 형태(Conventional prefix 선택 + 한글 설명)다 — 기존 톤을 따른다. 절차·안전수칙은 `korean-git-commit` 스킬.

**`+커푸`**: 지시 끝에 `+커푸`가 있으면 작업 후 이번 변경만 스테이징 → 커밋 → `git push`까지 수행한다. force push·`--no-verify` 금지.

**개발 서버**: `npm run dev`는 절대 포그라운드로 실행하지 않는다 (블로킹). 확인이 필요하면 `dev-server-restart` 스킬을 따른다.

**라이브러리 API**: Next.js 15 / React 19 / `@anthropic-ai/claude-agent-sdk` / MCP SDK의 시그니처가 헷갈리면 추측하지 말고 context7 MCP로 문서를 조회한다.

## 조건부 규칙 — 해당 작업일 때만 읽을 것

- 플랜/태스크/코멘트/리비전 모델을 건드릴 때 → [plan-data-invariants](.claude/rules/plan-data-invariants.md)
- `lib/agent.ts`, `lib/runner.ts`, 실행 권한·프롬프트 조립을 건드릴 때 → [agent-and-runner](.claude/rules/agent-and-runner.md)

## 스킬

`.claude/skills/project-workflows/` — 커밋(`korean-git-commit`), 묶음 커밋(`grouped-git-commit`), 문서 톤(`readme-tone`), 개발 서버 재시작(`dev-server-restart`), Slack 웹훅 포맷(`slack-webhook-message`).
