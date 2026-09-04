---
description: 이 PC를 원격 워커(서브 PC)로 만들어, 다른 PC의 Claude Code가 MCP로 작업을 시키고 결과를 PR·웹훅으로 받는 방법.
icon: server
---

# Remote worker

Better Plan Mode를 **원격 워커**로 띄우면, 다른 PC의 Claude Code가 이 PC에 작업을 제출하고 진행을 지켜보다가 PR과 Slack/Discord 알림으로 결과를 받습니다. Unity처럼 한 프로젝트에 에디터 인스턴스를 하나만 열 수 있는 환경을 "서브 PC"로 쓰고 싶을 때를 위한 구성입니다.

```
[메인 PC]  Claude Code ──MCP(HTTP)──▶ [서브 PC] mcp/worker.mjs ──▶ 보드 서버 /api/jobs
                ▲                                                     │
                │ job_status 폴링                                      ▼
            브라우저 ◀────────── 보드 /jobs/<id> (로그 스트림)     worktree → claude -p → 커밋
                                                                      → (Unity 검증) → push/PR
                                                                      → Slack/Discord 웹훅
```

## 잡이 흘러가는 순서

| 단계 | 하는 일 |
|------|---------|
| `worktree` | 메인 clone에서 `git worktree add -b agent/<id>` — 사람이 열어 둔 Unity 에디터와 폴더가 달라 락이 겹치지 않습니다 |
| `claude` | worktree 안에서 `claude -p` 실행 (`--model`, `--effort`는 제출 시 선택). 지시문 끝에 "커밋은 하되 push는 하지 말 것"이 자동으로 붙고, git add/commit은 승인 없이 허용됩니다 |
| `commit` | 세션이 커밋을 남기지 않았으면 워커가 대신 커밋합니다. 변경이 없으면 여기서 성공 종료 |
| `push` | `pr` 모드는 **검증 전에** 브랜치를 push합니다 — 검증이 오래 걸리거나 죽어도 작업물은 원격에 남습니다 |
| `verify` | `projects.json`에 `unityPath`가 있으면 `-batchmode -nographics -quit` 컴파일 검증. 결과(`passed/failed/timeout/skipped`)는 PR 본문·알림에 남습니다 |
| `pr` | `gh pr create`. 검증이 실패·시간 초과면 제목에 `[검증 …]`이 붙어 머지 전 확인을 요구합니다 · `direct` 모드: 검증 통과 시에만 기본 브랜치 위로 rebase 후 push |
| `cleanup` | 검증을 통과·생략한 성공 잡만 worktree 제거. 그 외에는 확인·재개할 수 있게 남겨 둡니다 |

같은 프로젝트의 잡은 **한 번에 하나만** 실행됩니다(프로젝트별 직렬 큐). 다른 프로젝트끼리는 동시에 돌 수 있습니다.

### 멈추지 않게 하는 장치

모든 외부 프로세스(claude, Unity, git, gh)에 워치독이 붙습니다 — 전체 상한과 "출력 없이 멈춤" 감지, 둘 다입니다. 걸리면 프로세스 트리를 죽이고 잡을 확정하며, 워크트리는 남깁니다. 실패·취소한 잡은 `job_resume`(보드의 "이어서 마무리")으로 커밋 단계부터 push·PR까지 이어서 끝낼 수 있고, Unity 검증 때문에 막혔으면 `skipVerify`로 건너뛸 수 있습니다. 기준 시간은 `.env.example`의 `WORKER_*_MIN` 항목을 보세요.

## 서브 PC 세팅

### 1. 설정 파일

```bash
cp .env.example .env.local          # WORKER_TOKEN 필수 — openssl rand -hex 24
cp config/projects.example.json config/projects.json
```

`projects.json` 키가 곧 원격에서 부르는 프로젝트 이름입니다.

| 필드 | 의미 |
|------|------|
| `path` | 메인 clone 절대경로 (worktree를 분기할 기준 리포) |
| `baseBranch` | `master` / `main` — worktree 시작점이자 PR base |
| `allowDirect` | 기본 허용. `false`면 `mode: "direct"` 제출을 거부 |
| `unityPath` | 있으면 배치모드 컴파일 검증 |
| `seedUnityLibrary` | `true`면 메인 clone의 `Library/`를 APFS clonefile로 복사해 첫 임포트를 건너뜁니다 (macOS) |
| `defaultModel` / `defaultEffort` | 이 프로젝트 잡의 기본 모델·추론 레벨. 제출 시 지정하면 그쪽이 우선 |
| `setupCommand` | worktree 생성 직후 실행할 셸 명령 (예: `npm install`) |

### 2. 빌드 후 기동

```bash
npm install && npm run build
npm run worker                      # 포그라운드 테스트
curl -s localhost:4000/health       # {"ok":true,"board":true}
```

워커는 보드 서버가 안 떠 있으면 직접 띄웁니다(`next start`, 포트 3000). launchd로 보드를 따로 관리하려면 `WORKER_SPAWN_BOARD=0`.

### 3. 상시 운영 (macOS launchd)

```bash
bash deploy/launchd/install.sh      # 등록 + 시작 (재부팅 후 자동 복구)
bash deploy/launchd/install.sh restart   # 코드 갱신 후
bash deploy/launchd/install.sh remove
```

{% hint style="warning" %}
**LaunchAgent(유저 세션)로 등록됩니다. LaunchDaemon으로 올리지 마세요.** 화면 캡처와 Unity 에디터는 GUI 세션이 필요합니다. 자동 로그인을 켜고, 시스템 설정 → 개인정보 보호 → 화면 기록에 Terminal(또는 node)을 허용하세요.
{% endhint %}

로그: `deploy/launchd/logs/worker.err.log`. `node`·`claude`·`gh`를 못 찾으면 `deploy/launchd/run-worker.sh`의 PATH를 보강하세요.

### 4. 그 외 필요한 것

* `claude` CLI 로그인 (worktree에서 `claude -p`가 돌아야 합니다)
* `gh auth login` (PR 모드)
* Unity 검증을 켰다면 Unity 라이선스 로그인 상태

## 메인 PC에서 붙기

```bash
claude mcp add --transport http mac-worker http://macmini-macmini:4000/mcp \
  --header "Authorization: Bearer <WORKER_TOKEN>" -s user
```

`macmini-macmini`는 Tailscale 이름이나 LAN IP입니다. Claude Desktop처럼 HTTP 헤더를 붙일 수 없는 호스트는 stdio 브리지 `mcp/worker-client.mjs`를 `WORKER_URL`·`WORKER_TOKEN` 환경변수와 함께 등록하세요. 붙인 뒤에는 `skills/remote-worker`를 `~/.claude/skills/`에 복사해 Claude가 워커 사용 흐름을 알게 합니다.

이후 어느 디렉터리에서든 Claude Code에 이렇게 말하면 됩니다.

> "mac-worker로 TeenipingTycoon에 로비 팝업 닫기 버튼 추가시켜. PR 모드로."

| 툴 | 동작 |
|----|------|
| `worker_projects` | 등록된 프로젝트 키 목록 |
| `job_submit` | 잡 제출 → `jobId`와 보드 URL 즉시 반환 (실행은 백그라운드). `mode`, `model`, `effort`, `maxTurns` 선택 |
| `job_status` | 상태·단계·검증 결과·PR 링크·오류·마지막 활동 시각 + 최근 로그 8줄 |
| `job_logs` | `since` 커서로 증분 로그 |
| `job_list` | 최근 잡 목록 |
| `job_cancel` | 대기/실행 중 잡 취소 (worktree는 남김) |
| `job_resume` | 실패·취소한 잡을 커밋 단계부터 이어서 push·PR까지 마무리. `skipVerify`로 검증 생략 가능 |
| `worker_screenshot` | 서브 PC 화면 캡처를 이미지로 반환 |

## 사용 중 확인하는 곳

* **보드** `http://macmini-macmini:3000/jobs` — 잡 목록과 실시간 로그. 직접 제출도 됩니다.
* **Slack / Discord** — 잡이 끝나면 결과·PR 링크·소요 시간이 갑니다. `.env.local`의 `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`.
* **직접 개입** — Parsec 등 원격 데스크톱으로 들어가면 됩니다. 단, 에이전트가 쓰는 worktree(`~/repo/_worktrees/…`)가 아니라 메인 clone을 여세요.

{% hint style="danger" %}
워커는 Bearer 토큰으로만 보호됩니다. 공인 인터넷에 직접 노출하지 말고 Tailscale 같은 사설망 안에서만 쓰세요. `WORKER_BIND`를 Tailscale IP로 좁힐 수 있습니다.
{% endhint %}

운영자용 단계별 체크리스트(macOS 설정·재시작·문제 해결)는 리포의 [`docs/remote-worker-runbook.md`](https://github.com/cyKim0115/claude-better-plan-mode/blob/master/docs/remote-worker-runbook.md)에 있습니다.

다음: [REST API](../reference/api.md)
