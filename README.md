# Better Plan Mode

상호작용 가능한 웹 플랜 모드. 목표를 적으면 Claude가 실행 계획을 세우고, 계획표에 코멘트/첨언을 달아 반영시키고, 원하는 태스크만 체크해서 부분 착수까지 시키는 루프를 웹 UI로 돌립니다.

**📖 문서 사이트: https://cykim.gitbook.io/claude-better-plan**

스크린샷과 함께 보는 설치·사용 가이드입니다. 아래는 빠른 요약이고, 자세한 내용은 문서 사이트를 보세요.

| | |
|---|---|
| [설치](https://cykim.gitbook.io/claude-better-plan/getting-started/install) | Node·Claude CLI 준비부터 첫 실행까지 |
| [첫 플랜 만들기](https://cykim.gitbook.io/claude-better-plan/getting-started/first-plan) | 목표 입력 → 플랜 생성 흐름 |
| [보드 둘러보기](https://cykim.gitbook.io/claude-better-plan/guide/board) | 계획표 화면 구성 |
| [코멘트와 반영](https://cykim.gitbook.io/claude-better-plan/guide/comments) | 첨언 → revision 루프 |
| [부분 착수](https://cykim.gitbook.io/claude-better-plan/guide/execute) | 선택한 태스크만 실행 |
| [MCP 연동](https://cykim.gitbook.io/claude-better-plan/integration/mcp) | 필요할 때만 보드 켜기 |
| [원격 접근](https://cykim.gitbook.io/claude-better-plan/integration/remote) | 다른 기기에서 보기 |
| [원격 워커](https://cykim.gitbook.io/claude-better-plan/integration/worker) | 이 PC를 서브 PC로 — 다른 PC의 Claude가 MCP로 작업 제출·PR·웹훅 |
| [REST API](https://cykim.gitbook.io/claude-better-plan/reference/api) · [아키텍처](https://cykim.gitbook.io/claude-better-plan/reference/architecture) | 내부 구조 |

문서 원본은 [`docs/site/`](docs/site/README.md)에 있고, `.gitbook.yaml`을 통해 GitBook과 Git Sync로 연결되어 있습니다 — 이 리포에 머지되면 사이트에 반영됩니다.

```
목표 입력 → 플랜 생성 (Agent SDK, 코드베이스 읽기 전용 탐색)
         → 계획표 보드에서 코멘트/첨언
         → [코멘트 반영] 버튼 → 플랜 revision 업데이트 (이력 보존)
         → 태스크 체크 → [선택 착수] → 로컬 claude CLI(-p) 스폰 → 로그 스트리밍
         → 태스크 상태 done/failed 반영 → 다시 코멘트 → 반복
```

## 요구 사항

- Node.js 20+
- Claude Code CLI 설치 및 로그인 (`claude` 명령이 PATH에 있어야 함)
  - 플랜 생성/수정(Agent SDK)과 태스크 실행(claude -p) 모두 이 인증을 사용합니다.
  - 또는 `ANTHROPIC_API_KEY` 환경변수로도 동작합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
```

첫 화면에서 목표와 **대상 프로젝트**를 고르고 "플랜 생성"을 누르면 됩니다. 생성은 코드베이스 크기에 따라 수 분 걸릴 수 있습니다.

프로젝트 드롭다운은 `config/projects.json`(워커 잡과 같은 파일)에서 옵니다. 프로젝트를 고른 플랜은 착수할 때 **PR 생성 / 기본 브랜치 직푸시**를 선택할 수 있고, 등록하지 않은 리포는 "직접 경로 입력"으로 절대경로를 적으면 됩니다(이 경우 실행만 하고 커밋·push는 하지 않습니다). 계획을 세우는 모델·추론 레벨도 여기서 고를 수 있습니다.

## 사용법

- **코멘트**: 각 태스크 카드 아래 입력창(태스크 대상) 또는 "플랜 전체 코멘트"(계획 전반)에 첨언을 답니다.
- **코멘트 반영**: 하단 액션바의 반영 버튼을 누르면 미해결 코멘트 전부를 Claude가 읽고 계획을 수정합니다. 반영된 코멘트는 resolved 처리되고 revision 이력이 남습니다.
- **부분 착수**: 태스크 체크박스를 골라 "선택 착수"를 누르면 해당 태스크들의 실행 지시문을 조립해 `claude -p`(headless)가 수행합니다. 로그가 실시간으로 보드에 흐릅니다.
- **착수 옵션**: 액션바에서 **PR 생성 / 직푸시**, 모델, 추론 레벨(effort), 권한 확인 생략을 고른 뒤 착수합니다. 프로젝트가 지정된 플랜은 워커 잡 파이프라인을 타므로 전용 worktree에서 실행 → 커밋 → push/PR까지 끝나고, 메인 작업 트리와 현재 브랜치는 건드리지 않습니다. PR 링크는 실행 패널에 뜹니다.
- **진행 현황**: 착수하면 첫 태스크만 running이 되고 나머지는 queued로 대기합니다. Claude가 태스크를 하나 끝낼 때마다 그 태스크만 done/failed로 바뀌며, 오른쪽 진행 현황 패널에서 진행률과 현재 작업을 볼 수 있습니다.
- **권한**: 기본은 `--permission-mode acceptEdits`(파일 편집 자동 허용). 체크박스로 `--dangerously-skip-permissions` 전환 가능 — 신뢰하는 리포에서만 쓰세요.

## MCP로 필요할 때만 켜기

서버를 상시 띄워둘 필요 없이, Claude Code 세션에서 플랜 툴이 호출될 때만 보드가 자동으로 켜지게 할 수 있습니다.

```bash
npm install   # @modelcontextprotocol/sdk 포함
claude mcp add planmode -- node C:\Users\cykim\repo\claude-better-plan-mode\mcp\server.mjs
```

이후 아무 프로젝트의 Claude Code 세션에서 "이 목표로 플랜 보드 만들어줘"라고 하면 Claude가 MCP 툴을 호출합니다:

| 툴 | 동작 |
|---|---|
| `plan_create` | (서버 자동 시작 후) 플랜 생성을 백그라운드로 시작하고 보드 URL 즉시 반환. `project`(projects.json 키)를 주면 착수 시 PR/직푸시 선택 가능, 없으면 `workdir`(생략 시 현재 세션 디렉토리) 대상. `model`·`effort`로 계획 에이전트 조절 |
| `plan_status` | 생성 진행/태스크 상태/미반영 코멘트 요약 — 세션 안에서 코멘트를 읽고 이어서 작업 가능 |
| `plan_list` | 저장된 플랜 목록 |
| `board_open` | 보드 서버만 켜고 URL 반환 |
| `board_stop` | 이 MCP가 켠 서버 종료 |

수명 주기: 툴이 처음 호출될 때 `next dev`(기본, 포트 3123)를 스폰하고, **30분간 사용이 없으면 자동 종료**되며, Claude 세션이 끝나면 함께 정리됩니다. 이미 떠 있는 보드 서버가 있으면 재사용하고 종료 시 건드리지 않습니다.

환경변수: `PLANMODE_PORT`(기본 3123), `PLANMODE_MODE`(`dev`|`start` — `start`는 사전 `npm run build` 필요), `PLANMODE_IDLE_MINUTES`(기본 30, `0`=자동 종료 끔).

## 원격(다른 기기)에서 접근

```bash
npm run dev:lan    # 0.0.0.0 바인드
```

- 같은 네트워크: `http://<이-PC의-IP>:3000`
- 외부에서: Tailscale 같은 사설망 또는 `cloudflared tunnel`/`ngrok http 3000` 등의 터널 사용을 권장합니다. **인증이 없는 앱이므로 공인 인터넷에 그대로 노출하지 마세요** — 이 앱은 로컬에서 임의 코드 실행(claude CLI)을 트리거할 수 있습니다.

## 원격 워커 — 이 PC를 서브 PC로

다른 PC의 Claude Code가 **HTTP MCP**로 이 PC에 작업을 제출하면, worktree를 파서 `claude -p`를 돌리고 커밋 → (Unity 컴파일 검증) → PR 생성 또는 기본 브랜치 직푸시까지 끝낸 뒤 Slack/Discord로 알립니다. Unity처럼 프로젝트당 에디터 인스턴스가 하나뿐인 환경을 위한 구성입니다.

```bash
cp .env.example .env.local                          # WORKER_TOKEN 필수 (openssl rand -hex 24), SLACK_WEBHOOK_URL
cp config/projects.example.json config/projects.json  # 프로젝트 키 → 경로·기본 브랜치·direct 허용 여부
npm run build && npm run worker                     # 포트 4000. 보드(3000)는 자동으로 띄웁니다
bash deploy/launchd/install.sh                      # macOS 상시 운영 (LaunchAgent, 재부팅 후 자동 복구)
```

등록한 뒤의 상태 확인·종료·재시작은 아래 [운영 스크립트](#운영-스크립트-macos-전용)를 쓰세요.

메인 PC에서는 한 줄로 붙습니다.

```bash
claude mcp add --transport http mac-worker http://macmini-macmini:4000/mcp --header "Authorization: Bearer <WORKER_TOKEN>" -s user
```

Claude Desktop처럼 헤더를 못 붙이는 호스트는 stdio 브리지 `mcp/worker-client.mjs`(`WORKER_URL`, `WORKER_TOKEN` env)를 등록하면 됩니다. 메인 PC의 Claude가 워커를 어떻게 써야 하는지는 `skills/remote-worker`를 `~/.claude/skills/`에 복사해 알려줍니다.

툴: `worker_projects` · `job_submit`(즉시 jobId 반환, `mode`/`model`/`effort` 선택) · `job_status` · `job_logs` · `job_list` · `job_cancel` · `job_resume`(실패한 잡을 push·PR까지 이어서 마무리) · `worker_screenshot` · `worker_cleanup`. 모든 외부 프로세스에 워치독이 붙어 조용히 멈추는 잡이 없고, `pr` 모드는 검증 전에 push해 작업물을 먼저 원격에 남깁니다. 확인용으로 남긴 worktree와 머지된 `agent/*` 브랜치는 보관 기한(기본 48시간)이 지나면 자동으로 정리돼 로컬·원격에 잔여물이 쌓이지 않습니다. 진행 상황은 보드 `/jobs`에서도 볼 수 있습니다. 자세한 설정·운영은 [원격 워커 문서](https://cykim.gitbook.io/claude-better-plan/integration/worker)와 `docs/remote-worker-runbook.md`를 보세요.

## 운영 스크립트 (macOS 전용)

`deploy/` 아래의 스크립트는 **macOS에서만 동작합니다**. launchd(LaunchAgent)와 `launchctl`, 키체인에 기대고 있어서 Windows·Linux에서는 쓸 수 없습니다. 다른 OS에서는 `npm run worker`로 직접 띄우거나(포트 4000, 보드도 함께 켜집니다) 그 OS의 서비스 관리자를 쓰세요.

| 스크립트 | 용도 |
|---|---|
| `deploy/worker.sh` | 워커·보드 상태 확인과 시작·종료·재시작·재빌드 |
| `deploy/launchd/install.sh` | 워커 LaunchAgent 등록·해제 (`install` / `remove` / `restart`) |
| `deploy/autopush/install.sh` | 커밋 자동 push LaunchAgent 등록 (아래 「커밋 자동 push」 참고) |

`deploy/launchd/run-worker.sh`와 `deploy/autopush/autopush.sh`는 launchd가 부르는 내부 진입점이라 직접 실행하지 않습니다.

### 워커·보드 제어

LaunchAgent를 등록한 뒤에는 이 스크립트 하나로 다룹니다.

```bash
./deploy/worker.sh              # 상태
./deploy/worker.sh start        # 기동
./deploy/worker.sh stop         # 종료
./deploy/worker.sh restart      # 재시작
./deploy/worker.sh rebuild      # npm run build 후 재시작
./deploy/worker.sh logs 100     # 최근 100줄부터 로그 따라가기
```

상태는 이렇게 나옵니다.

```
launchd    : running (pid 29294)
워커 MCP   : :4000 pid 29294 {"ok":true,"board":true}
보드       : :3000 pid 29319 HTTP 200 /jobs
진행 중 잡 : 0
```

알아 두면 좋은 점이 몇 가지 있습니다.

- LaunchAgent에 KeepAlive가 걸려 있어 `kill`로는 멈추지 않고 10초 뒤 다시 뜹니다. 종료는 `stop`을 쓰세요.
- `stop`·`restart`·`rebuild`는 진행 중이거나 대기 중인 잡이 있으면 멈추고 알려 줍니다. 그래도 내려야 하면 `--force`를 붙이세요.
- 코드를 고쳤으면 `rebuild`를 쓰세요. 빌드만 하고 재시작을 건너뛰면 실행 중인 서버가 옛 청크를 가리켜 보드가 `ChunkLoadError`로 열리지 않습니다.
- 포트는 `.env.local`의 `PLANMODE_PORT`·`WORKER_PORT`를 따릅니다.

## 저장 위치 / 제약

- 플랜은 `data/plans/*.json`, 워커 잡은 `data/jobs/*.json`에 저장됩니다 (git-ignore됨). 백업/이동이 쉽습니다.
- 프로젝트가 지정된 플랜의 착수는 잡으로 저장돼 재시작 후에도 남습니다. 경로만 지정된 플랜의 실행(run) 로그는 서버 프로세스 메모리에만 있어 재시작 시 사라집니다(플랜/태스크 상태는 유지).
- 단일 서버 프로세스 전제입니다 (`next dev` 또는 `next start` 하나만 띄우세요).

## 구조

```
lib/types.ts    플랜/태스크/코멘트/런 데이터 모델
lib/store.ts    data/ 디렉토리 JSON 파일 스토어
lib/agent.ts    Agent SDK로 플랜 생성·코멘트 반영(revise)
lib/plan-run.ts 착수 지시문 조립 + 진행 마커 → 태스크 상태 반영 (runner·jobs 공용)
lib/runner.ts   경로만 지정된 플랜의 착수 — claude -p 스폰, 런 레지스트리(인메모리)
lib/jobs.ts     원격 워커 잡 — 프로젝트별 큐, worktree → claude -p → 커밋 → 검증 → push/PR
lib/proc.ts     외부 프로세스 실행 공용 유틸 (프로세스 그룹 종료 + 워치독)
lib/worktree-gc.ts  남은 worktree·agent 브랜치 자동 정리(GC)
lib/notify.ts   Slack(Block Kit)·Discord 웹훅 알림 (공급자 중립 Notice)
lib/screenshot.ts  워커 PC 화면 캡처 (macOS screencapture / Windows PowerShell)
app/api/...     REST 엔드포인트 (plans, comments, revise, execute, runs, jobs, screenshots)
components/PlanBoard.tsx  계획표 보드 UI (코멘트·반영·부분 착수·로그)
components/JobList.tsx · JobView.tsx  워커 잡 목록·상세(로그 스트림)
mcp/server.mjs  MCP 서버(stdio) — 온디맨드로 보드 서버 스폰, plan_create/plan_status 등 툴 제공
mcp/worker.mjs  원격 워커 MCP 서버(Streamable HTTP + Bearer) — job_submit/status/logs/cancel, worker_screenshot
deploy/worker.sh  워커·보드 제어 (상태·시작·종료·재시작·재빌드, macOS 전용)
deploy/launchd/ macOS LaunchAgent 등록 스크립트·템플릿
deploy/autopush/ 미푸시 커밋 자동 push — 리포의 .git/logs/HEAD를 감시해 커밋 직후 밀어 올림
```

## 커밋 자동 push (선택)

샌드박스 세션처럼 자격증명이 없는 환경에서 커밋만 남는 경우, Mac 키체인을 쓰는 LaunchAgent가 대신 push합니다. 대상 리포의 `.git/logs/HEAD`를 감시하므로 **커밋한 직후** 올라가고, 이벤트를 놓쳤을 때를 대비해 5분 주기 안전망이 함께 돕니다.

```bash
cp config/autopush.example.txt config/autopush.txt   # 대상 리포 절대경로 목록
bash deploy/autopush/install.sh                      # 등록 (목록을 고치면 다시 실행)
```

upstream을 추적하는 브랜치만, fast-forward일 때만 밉니다. force push는 하지 않으며, 리포별로 잠시 끄려면 `touch .git/autopush-off`.
