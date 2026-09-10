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
                                                                      → (Unity 검증·화면 캡처) → push/PR
                                                                      → Slack/Discord 웹훅
```

## 잡이 흘러가는 순서

| 단계 | 하는 일 |
|------|---------|
| `worktree` | 메인 clone에서 `git worktree add -b agent/<id>` — 사람이 열어 둔 Unity 에디터와 폴더가 달라 락이 겹치지 않습니다 |
| `claude` | worktree 안에서 `claude -p` 실행 (`--model`, `--effort`는 제출 시 선택). 지시문 끝에 "커밋은 하되 push는 하지 말 것"이 자동으로 붙고, git add/commit은 승인 없이 허용됩니다 |
| `commit` | 세션이 커밋을 남기지 않았으면 워커가 대신 커밋합니다. 변경이 없으면 여기서 성공 종료 |
| `push` | `pr` 모드는 **검증 전에** 브랜치를 push합니다 — 검증이 오래 걸리거나 죽어도 작업물은 원격에 남습니다 |
| `verify` | `projects.json`에 `unityPath`가 있으면 `-batchmode -nographics -quit` 컴파일 검증. 판정은 종료 코드가 아니라 로그로 합니다 — 컴파일이 끝났는데 에디터가 종료되지 못해도 결과는 그대로 나옵니다. 결과(`passed/failed/timeout/skipped`)는 PR 본문·알림에 남습니다 |
| `capture` | 잡에 `capture`가 켜져 있을 때만 돕니다. 검증이 끝난 **같은 worktree**에서 GUI 에디터를 띄워 스크린샷·녹화를 남깁니다. 실패해도 잡은 실패하지 않고 사유만 남습니다 |
| `pr` | `gh pr create`. 검증이 실패·시간 초과면 제목에 `[검증 …]`이 붙어 머지 전 확인을 요구합니다 · `direct` 모드: 검증 통과 시에만 기본 브랜치 위로 rebase 후 push |
| `cleanup` | 검증을 통과·생략한 성공 잡만 worktree와 로컬 브랜치를 제거합니다. 그 외에는 확인·재개할 수 있게 남겨 두고, 보관 기한이 지나면 GC가 치웁니다 |

같은 프로젝트의 잡은 **한 번에 하나만** 실행됩니다(프로젝트별 직렬 큐). 다른 프로젝트끼리는 동시에 돌 수 있습니다.

### 잔여물이 쌓이지 않게 하는 장치

남긴 worktree와 `agent/*` 브랜치는 그대로 두면 계속 쌓입니다 — Unity 프로젝트는 worktree 하나가 수 GB입니다. 보드 서버가 기동 직후, 잡이 끝날 때마다, 그리고 `WORKER_GC_INTERVAL_MIN`(기본 60분)마다 한 번씩 정리를 돕니다.

| 대상 | 지우는 조건 |
|------|-------------|
| worktree (작업물이 원격에 올라감) | 잡이 끝나고 `WORKER_WORKTREE_TTL_HOURS`(기본 48시간) |
| worktree (커밋·push 안 된 변경이 남음) | 잡이 끝나고 `WORKER_WORKTREE_UNSAVED_TTL_HOURS`(기본 168시간). 커밋된 내용은 로컬 브랜치로 남습니다 |
| worktree (잡과 짝이 없는 고아 디렉터리) | 디렉터리 mtime 기준 기본 48시간 |
| 로컬 `agent/*` 브랜치 | worktree가 물고 있지 않고, 원격에 올라갔거나 base에 머지됐을 때 |
| 원격 `agent/*` 브랜치 | PR이 머지·클로즈됐거나 base에 이미 반영됐을 때 (`WORKER_REMOTE_CLEANUP=0`으로 끕니다) |

실행 중·대기 중인 잡의 worktree는 건드리지 않습니다. 무언가 지워지면 Slack·Discord로 요약이 갑니다. 보드 `/jobs`의 **워크트리 정리** 패널이나 `worker_cleanup` 툴로 현황을 보고 즉시 정리할 수도 있습니다. worktree가 정리된 잡은 **커밋부터 마무리**도 **이어서하기**도 할 수 없으니, 이어서 할 게 있으면 보관 기한 안에 하세요 (컨텍스트만 물려받는 **새 세션**은 그 뒤에도 됩니다).

### 멈추지 않게 하는 장치

모든 외부 프로세스(claude, Unity, git, gh)에 워치독이 붙습니다 — 전체 상한과 "출력 없이 멈춤" 감지, 둘 다입니다. 걸리면 프로세스 트리를 죽이고 잡을 확정하며, 워크트리는 남깁니다. 실패·취소한 잡은 `job_resume`(보드의 **커밋부터 마무리**)으로 커밋 단계부터 push·PR까지 이어서 끝낼 수 있고, Unity 검증 때문에 막혔으면 `skipVerify`로 건너뛸 수 있습니다. 기준 시간은 `.env.example`의 `WORKER_*_MIN` 항목을 보세요.

### 화면으로 확인하기

컴파일 검증은 `-batchmode -nographics`로 돌기 때문에 렌더링이 없습니다. 화면을 봐야 하는 작업이라면 잡에 `capture`를 켜세요. 검증이 끝난 뒤 **같은 worktree에서 에디터를 GUI로 한 번 더** 띄워 스크린샷과 녹화를 남깁니다. 직전 검증이 Library를 이미 만들어 둔 뒤라 이 단계는 대체로 1분 안에 끝납니다.

쓰려면 `projects.json`에 `captureMethod`가 있어야 합니다. 워커는 그 정적 메서드를 `-executeMethod`로 부르고, 대상 리포가 무엇을 어떻게 찍을지(씬·길이·해상도) 정합니다. 스크립트와의 약속은 이렇습니다.

| 항목 | 값 |
|------|-----|
| 산출물 폴더 | 환경변수 `AGENT_CAPTURE_OUT` (워커가 미리 만들어 둡니다) |
| 잡 id | 환경변수 `AGENT_CAPTURE_JOB` — 파일명 접두로 쓰세요 |
| 씬·길이 (선택) | `AGENT_CAPTURE_SCENE`, `AGENT_CAPTURE_SECONDS` |
| 끝났다는 신호 | 로그에 `AGENT_CAPTURE_DONE`, 실패면 `AGENT_CAPTURE_FAIL <사유>` |

산출물은 `data/jobs/<잡 id>-captures/`에 모입니다. worktree 밖이라 커밋을 더럽히지 않고, worktree가 정리된 뒤에도 남습니다. 잡 상세 화면에 이미지·동영상으로 뜨고, PR 본문과 웹훅에는 개수가 적힙니다.

캡처는 반드시 **에디터 안에서** 찍으세요. 워커 PC의 OS 화면 캡처(`worker_screenshot`)를 쓰면 그때 떠 있던 다른 창까지 함께 찍히고, 창이 가려지면 결과가 달라집니다.

{% hint style="info" %}
캡처가 도는 동안 워커 PC에 Unity 에디터 창이 하나 더 뜹니다. 그 PC를 함께 쓰고 있다면 방해가 될 수 있으니, 화면이 꼭 필요한 잡에만 켜세요.
{% endhint %}

### 대기 중인 잡 고치기

큐에 들어갔지만 아직 시작하지 않은(`queued`) 잡은 잡 상세의 **수정** 버튼(또는 잡 목록의 `수정` 링크)으로 지시문·제목·모드·모델·추론 레벨·**Unity 검증 생략**·**화면 캡처**를 바꿀 수 있습니다. 실행이 시작되면 서버가 수정을 거부하므로, 이미 돌기 시작한 잡은 취소한 뒤 다시 제출하거나 끝난 뒤 이어서 하세요.

Unity 검증이 계속 정지·실패하는 상황이면 이 화면에서 **Unity 검증 생략**을 켜 두는 것이 가장 빠릅니다. 잡별 설정이라 `job_submit`의 `skipVerify`로 제출 시점에 지정할 수도 있습니다. 검증을 생략하면 컴파일 확인은 세션 지시문에 맡기게 되므로, `direct` 모드와 함께 쓸 때는 특히 주의하세요.

### 끝난 잡을 이어서 하기

잡 상세(`/jobs/<id>`) 오른쪽 위 버튼으로 이어 갑니다. 셋은 서로 다른 일을 합니다.

| 버튼 | 하는 일 | 쓸 때 |
|------|---------|-------|
| **이어서하기** | 그 잡의 claude 세션을 그대로 재개해(`claude --resume`) 추가 지시를 수행합니다. worktree·브랜치·PR을 그대로 쓰므로 결과가 같은 PR에 쌓입니다 | 방금 한 작업을 더 다듬거나, 빠뜨린 부분을 마저 시킬 때 |
| **새 세션** | 이전 잡의 지시·세션 요약·PR 링크를 컨텍스트로 붙여 **새 잡**을 만듭니다. 대화는 물려받지 않습니다 | 컨텍스트는 참고하되 깨끗한 세션에서 다시 시작할 때, 또는 worktree가 이미 정리됐을 때 |
| **커밋부터 마무리** | claude를 다시 돌리지 않고 커밋 → push → 검증 → PR 단계만 다시 돕니다 (`job_resume`) | 작업물은 다 나왔는데 push·PR에서 실패했을 때 |

**이어서하기** 페이지에서는 기록 방식을 고릅니다. *이 잡에 이어붙이기*는 같은 잡 카드에 로그가 계속 쌓이고, *새 잡 카드로 분리*는 worktree·브랜치·PR·세션을 공유하는 새 잡을 만들어 지시별로 이력을 나눕니다. 세션 id가 기록되기 전에 돌던 잡은 worktree가 잡마다 고유하다는 점을 이용해 `claude --continue`로 그 디렉터리의 마지막 대화를 잇습니다.

**새 세션** 페이지에서는 코드 시작점을 고릅니다. *이전 브랜치 위*로 시작하면 이전 변경이 코드에 이미 들어 있는 상태에서 새 브랜치가 갈라져 나가고, *base에서 새로* 시작하면 코드는 깨끗한 상태로 두고 이전 작업은 프롬프트 컨텍스트로만 참조합니다.

{% hint style="warning" %}
*이전 브랜치 위*에서 시작하면서 직푸시 모드를 고르면 이전 브랜치의 커밋까지 기본 브랜치로 함께 올라갑니다. 이전 작업을 아직 머지하지 않았다면 PR 모드를 쓰세요.
{% endhint %}

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
| `allowDirect` | 기본 허용. `false`면 `mode: "direct"` 제출을 거부합니다. 보드 잡 화면(`/jobs`)과 새 세션 화면의 **직푸시 허용** 체크박스로 껐다 켤 수 있습니다 — 켤 때는 확인을 한 번 묻고, 이 필드만 파일에 다시 씁니다 |
| `unityPath` | 있으면 배치모드 컴파일 검증 |
| `captureMethod` | 있으면 화면 캡처를 쓸 수 있습니다. GUI 에디터에서 `-executeMethod`로 부를 정적 메서드 이름 (예: `AgentCaptureRun.Run`) |
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
| `job_submit` | 잡 제출 → `jobId`와 보드 URL 즉시 반환 (실행은 백그라운드). `mode`, `model`, `effort`, `maxTurns`, `skipVerify`, `capture` 선택 |
| `job_status` | 상태·단계·검증 결과·PR 링크·오류·마지막 활동 시각 + 최근 로그 8줄 |
| `job_logs` | `since` 커서로 증분 로그 |
| `job_list` | 최근 잡 목록 |
| `job_cancel` | 대기/실행 중 잡 취소 (worktree는 남김) |
| `job_resume` | 실패·취소한 잡을 커밋 단계부터 이어서 push·PR까지 마무리. `skipVerify`로 검증 생략 가능 |
| `worker_screenshot` | 서브 PC의 지금 화면을 이미지로 반환 (PC 상태 확인용 — 잡 산출물은 `capture`를 쓰세요) |
| `worker_cleanup` | 남은 worktree 현황 조회·즉시 정리 (`dryRun`, `force`) |

## 사용 중 확인하는 곳

* **보드** `http://macmini-macmini:3000/jobs` — 잡 목록과 실시간 로그. 직접 제출도 됩니다.
* **Slack / Discord** — 잡이 끝나면 결과·PR 링크·소요 시간이 갑니다. `.env.local`의 `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL`.
* **직접 개입** — Parsec 등 원격 데스크톱으로 들어가면 됩니다. 단, 에이전트가 쓰는 worktree(`~/repo/_worktrees/…`)가 아니라 메인 clone을 여세요.

{% hint style="danger" %}
워커는 Bearer 토큰으로만 보호됩니다. 공인 인터넷에 직접 노출하지 말고 Tailscale 같은 사설망 안에서만 쓰세요. `WORKER_BIND`를 Tailscale IP로 좁힐 수 있습니다.
{% endhint %}

운영자용 단계별 체크리스트(macOS 설정·재시작·문제 해결)는 리포의 [`docs/remote-worker-runbook.md`](https://github.com/cyKim0115/claude-better-plan-mode/blob/master/docs/remote-worker-runbook.md)에 있습니다.

다음: [REST API](../reference/api.md)
