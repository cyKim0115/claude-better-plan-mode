# Better Plan Mode

Next.js 15 (App Router) + React 19 + TypeScript. 웹 계획표 보드에서 Claude가 플랜을 세우고, 코멘트를 반영하고, 선택한 태스크만 로컬 `claude -p`로 착수시키는 앱이다.
사용자 안내 문서는 `README.md`와 `docs/site/`(GitBook 소스)에 있다.

## 구조

| 경로 | 역할 |
|---|---|
| `lib/types.ts` | Plan / PlanTask / PlanComment / Run 데이터 모델 (단일 소스) |
| `lib/store.ts` | `data/plans/*.json` 파일 스토어 |
| `lib/agent.ts` | Agent SDK로 플랜 생성·revise (읽기 전용 툴만, 모델·effort 선택) |
| `lib/plan-run.ts` | 착수 지시문 조립 + 진행 마커 → 태스크 상태 반영. 플랜 쓰기 직렬 큐 (runner·jobs 공용) |
| `lib/runner.ts` | 프로젝트 미지정 플랜의 착수 — `claude -p` 스폰, 인메모리 런 레지스트리 |
| `lib/stream-json.ts` | stream-json → 로그 항목 공용 변환기 (runner는 마커 처리 때문에 자체 포맷터 유지) |
| `lib/jobs.ts` | 원격 워커 잡 + 플랜 착수 — `data/jobs/*.json` 저장, 프로젝트별 직렬 큐, worktree → claude -p → 커밋 → 검증 → push/PR |
| `lib/proc.ts` | 외부 프로세스 실행 공용 유틸 — 프로세스 그룹 종료 + 워치독(상한·무출력 정지). jobs·worktree-gc 공용 |
| `lib/worktree-gc.ts` | 워커 잔여물 GC — 보관 기한 지난 worktree·로컬/원격 `agent/*` 브랜치 정리 정책 |
| `lib/notify.ts` | Slack(Block Kit)·Discord 웹훅 알림 — 공급자 중립 `Notice` → `toSlack`/`toDiscord` (미설정 시 no-op) |
| `lib/screenshot.ts` | 워커 PC 화면 캡처 |
| `lib/tunnel.ts` | ngrok 공개 URL |
| `app/api/**` | REST 엔드포인트 (`jobs`, `screenshots` 포함) |
| `components/PlanBoard.tsx` | 보드 UI |
| `components/JobList.tsx`, `JobView.tsx` | 워커 잡 목록·상세 UI |
| `components/JobFollowUpForm.tsx`, `JobNewSessionForm.tsx` | 이어서하기(세션 재개)·새 세션(컨텍스트 참조) 폼. 이전 잡 요약 타입은 `components/job-context.ts` |
| `components/WorktreePanel.tsx` | 남은 worktree 현황·즉시 정리 UI (`/api/worktrees`) |
| `mcp/server.mjs` | MCP 서버(stdio) — 온디맨드 보드 서버 스폰, `plan_create` 등 툴 |
| `mcp/worker.mjs` | 원격 워커 MCP 서버(Streamable HTTP, Bearer 토큰) — 보드 `/api/jobs` 프록시 |
| `mcp/worker-client.mjs` | 메인 PC용 stdio 브리지 — Claude Desktop처럼 HTTP 헤더를 못 붙이는 호스트가 worker.mjs에 붙는 경로 |
| `skills/` | 다른 기기에 설치하는 배포용 스킬 (`remote-worker`). 리포 작업 규칙은 `.claude/skills/` |
| `config/projects.json` | 워커가 다룰 프로젝트 목록 (gitignore, 예시는 `projects.example.json`) |
| `deploy/launchd/` | macOS LaunchAgent 등록 스크립트·템플릿 |
| `deploy/autopush/` | 미푸시 커밋을 Mac 키체인으로 push하는 LaunchAgent — 대상 리포의 `.git/logs/HEAD`를 WatchPaths로 감시해 커밋 직후 실행, 5분 주기는 안전망. 대상은 `config/autopush.txt`(gitignore, 고치면 install.sh 재실행) |

## 상시 규칙

**시크릿·로컬 데이터**: `.env.local`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `WORKER_TOKEN`, ngrok 토큰, `ANTHROPIC_API_KEY` 값을 읽거나 출력하거나 커밋하지 않는다. `data/`는 gitignore된 실사용자 플랜·잡 데이터, `config/projects.json`은 로컬 경로가 든 설정 — 예시가 필요하면 새 파일을 만들지 말고 구조만 `lib/types.ts`·`projects.example.json`에서 인용한다.

**플랜 착수**: 플랜에 `project`(projects.json 키)가 있으면 착수는 잡 파이프라인을 탄다(`submitJob({ planId, taskIds })`) — 실행 지시문은 worktree·브랜치가 정해진 뒤 `buildPlanJobPrompt`가 조립하고, 진행 마커는 `lib/plan-run.ts`가 플랜에 반영한다. `project`가 없는 레거시 플랜만 `lib/runner.ts`로 간다. 두 경로 모두 지시문·마커 로직을 각자 복제하지 말고 `lib/plan-run.ts`를 쓴다. PR/직푸시 선택은 계획표 액션바(착수 시점)에 있다 — 플랜 생성 시점으로 옮기지 않는다.

**워커 잡**: `lib/jobs.ts`는 셸 문자열 보간 없이 인자 배열로만 `git`/`gh`/`claude`를 스폰한다 (잡 제목·프롬프트는 신뢰 입력이 아니다). 모든 외부 프로세스는 `lib/proc.ts`의 `spawnWatched`(상한 + 무출력 정지 워치독, 프로세스 그룹 종료)를 거친다 — 여기를 우회하는 스폰을 추가하지 않는다. `pr` 모드는 **커밋 직후 push, 검증은 그 뒤**다(원격 보존이 우선) — 순서를 바꾸지 않는다. `direct` 모드는 `projects.json`의 `allowDirect: false`로만 잠긴다(기본 허용) — 이 값은 보드의 직푸시 허용 체크박스(`PATCH /api/projects/:key` → `setProjectAllowDirect`)로 바꾼다. 앱이 `config/projects.json`에 쓰는 경로는 이 함수 하나뿐이고 `allowDirect` 외의 필드는 쓰지 않는다 — 경로·Unity 설정을 API로 열지 않는다. 잡 상태 전이(`queued → running → succeeded|failed|cancelled`)와 단계(`stage`)는 `runJob`이 소유하고, 실패·취소한 잡은 worktree를 남겨 `resumeJob`이 커밋 단계부터 이어 간다. `mcp/worker.mjs`는 `WORKER_TOKEN` 없이는 기동을 거부한다 — 이 검사를 빼지 않는다.

**잡 이어가기**: 세 경로를 섞지 않는다. `resumeJob`은 claude를 다시 돌리지 않고 커밋 단계부터(보드: "커밋부터 마무리"), `followUpJob`은 같은 worktree에서 세션을 재개해 추가 지시를 수행하고(보드: "이어서하기"), 이전 잡을 컨텍스트로만 참조하는 새 세션은 `submitJob({ parentJobId, startFrom })`이다. 세션 id는 `lib/stream-json.ts`가 stream-json에서 뽑아 `job.sessionId`에 남기며, 이어서하기는 `--resume`(id가 없으면 그 worktree의 `--continue`)를 쓴다 — 이 폴백을 없애면 세션 id 이전 잡을 못 잇는다. 이어서하기를 새 잡 카드로 분리하면 worktree·브랜치·PR·세션을 **공유**하므로, GC의 활성 잡 보호(`lib/worktree-gc.ts`의 경로별 대표 잡 선택)와 worktree 삭제 표시(`markWorktreeRemoved`의 공유 잡 전파)를 함께 유지한다.

**잔여물 정리**: 잡이 일부러 남긴 worktree·브랜치는 `lib/worktree-gc.ts`가 보관 기한이 지나면 반드시 치운다 (기동 직후·잡 종료 후·`WORKER_GC_INTERVAL_MIN` 주기). 실행 중·대기 중 잡의 worktree, 그리고 커밋·push 안 된 변경이 남은 worktree의 짧은 기한 삭제는 금지다 — 이 두 안전장치를 빼지 않는다. worktree를 지웠으면 잡의 `worktreeRemovedAt`을 남겨 `job_resume`이 헛돌지 않게 한다. 원격 브랜치는 PR이 머지·클로즈됐거나 base에 반영된 `agent/*`만 지운다.

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
