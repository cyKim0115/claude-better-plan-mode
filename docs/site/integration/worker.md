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
| `claude` | worktree 안에서 `claude -p` 실행. 지시문 끝에 "커밋은 하되 push는 하지 말 것"이 자동으로 붙습니다 |
| `commit` | 세션이 커밋을 남기지 않았으면 워커가 대신 커밋합니다. 변경이 없으면 여기서 성공 종료 |
| `verify` | `projects.json`에 `unityPath`가 있으면 `-batchmode -nographics -quit` 컴파일 검증 (선택) |
| `push` / `pr` | `pr` 모드: 브랜치 push + `gh pr create` · `direct` 모드: 기본 브랜치 위로 rebase 후 push |
| `cleanup` | 성공 시 worktree 제거. 실패·취소 시에는 확인할 수 있게 남겨 둡니다 |

같은 프로젝트의 잡은 **한 번에 하나만** 실행됩니다(프로젝트별 직렬 큐). 다른 프로젝트끼리는 동시에 돌 수 있습니다.

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
| `allowDirect` | `true`일 때만 `mode: "direct"` 허용. 기본 `false` |
| `unityPath` | 있으면 push 전에 배치모드 컴파일 검증. 첫 임포트는 수 분 걸립니다 |
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

`macmini-macmini`는 Tailscale 이름이나 LAN IP입니다. 이후 어느 디렉터리에서든 Claude Code에 이렇게 말하면 됩니다.

> "mac-worker로 TeenipingTycoon에 로비 팝업 닫기 버튼 추가시켜. PR 모드로."

| 툴 | 동작 |
|----|------|
| `worker_projects` | 등록된 프로젝트 키 목록 |
| `job_submit` | 잡 제출 → `jobId`와 보드 URL 즉시 반환 (실행은 백그라운드) |
| `job_status` | 상태·단계·PR 링크·오류 + 최근 로그 8줄 |
| `job_logs` | `since` 커서로 증분 로그 |
| `job_list` | 최근 잡 목록 |
| `job_cancel` | 대기/실행 중 잡 취소 (worktree는 남김) |
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
