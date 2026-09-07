# 원격 워커 런북 — Mac을 서브 PC로 쓰기

메인 PC(Windows)의 Claude Code가 이 Mac에 작업을 시키고, 진행을 보고, PR·Slack 알림으로 결과를 받는 구성입니다.
**세팅은 Mac 앞에서 한 번**, 이후 **사용은 Windows에서만** 합니다.

기술 상세(툴 목록·잡 단계·설정 필드)는 [`docs/site/integration/worker.md`](site/integration/worker.md)에 있습니다. 이 문서는 "내가 실제로 뭘 눌러야 하는가"만 다룹니다.

```
[Windows] Claude Code ──MCP(HTTP:4000)──▶ [Mac] worker ──▶ worktree → claude -p → 커밋 → push/PR
              ▲                                                            │
     브라우저 http://macmini-macmini:3000/jobs  ◀── 로그 스트림          Slack 웹훅 ◀── 완료 알림
```

---

## 1. 세팅 — Mac에서 한 번

### 1-1. macOS

| 항목 | 방법 |
|---|---|
| 자동 로그인 | 시스템 설정 → 사용자 및 그룹 → 자동 로그인 ON (재부팅 후 GUI 세션이 있어야 Unity·스크린샷이 됩니다) |
| 잠자기 끄기 | `sudo pmset -a sleep 0 disablesleep 1` |
| 원격 로그인(SSH) | 시스템 설정 → 일반 → 공유 → 원격 로그인 ON |
| 화면 기록 권한 | 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록 → Terminal 허용 (워커 첫 캡처 때 팝업이 뜨면 허용) |
| Tailscale | 설치·로그인. 이후 주소는 `macmini-macmini` 같은 Tailscale 이름 하나로 통일 |
| Parsec (선택) | 사람이 원격 데스크톱으로 들어올 때용. 호스트 설치 |

### 1-2. 도구 확인

```bash
node -v        # 20 이상
claude --version && claude -p "hi"   # 로그인 상태
gh auth status                       # PR 생성용. 없으면 brew install gh && gh auth login
git config --global user.name        # 커밋 아이덴티티. 봇 계정으로 분리하려면 프로젝트별 git config
```

### 1-3. 워커 설정

```bash
cd ~/repo/claude-better-plan-mode
rm -rf node_modules && npm install

# 시크릿
cp .env.example .env.local                      # 이미 있으면 생략
echo "WORKER_TOKEN=$(openssl rand -hex 24)" >> .env.local
# .env.local 안에 SLACK_WEBHOOK_URL=https://hooks.slack.com/... 도 있어야 합니다

# 프로젝트 목록
cp config/projects.example.json config/projects.json
```

`config/projects.json`에서 확인할 것:

- `path` — Mac 안의 메인 clone 절대경로
- `baseBranch` — TeenipingTycoon은 `master`
- `allowDirect` — 기본 허용. `direct`(기본 브랜치 직푸시)를 막으려면 `false`
- `unityPath` — 있으면 Unity 배치모드 컴파일 검증. `pr` 모드는 **push를 먼저 하고** 검증하므로 검증이 오래 걸리거나 죽어도 작업물은 원격에 남고, PR 제목에 `[검증 실패/시간 초과]`가 붙습니다. `direct` 모드는 검증을 통과해야 push합니다
- `seedUnityLibrary` — `true`면 메인 clone의 `Library/`를 APFS clonefile(`cp -c`)로 worktree에 복사해 **첫 임포트(수십 분)를 건너뜁니다**. 에디터가 열린 채 복사해도 Unity가 어긋난 캐시는 다시 만듭니다
- `defaultModel` / `defaultEffort` — 이 프로젝트 잡의 기본 모델·추론 레벨. 제출할 때 지정하면 그쪽이 우선

### 1-4. 기동 테스트

```bash
npm run build && npm run worker
# 다른 터미널에서
curl -s localhost:4000/health        # {"ok":true,"board":true}
```

브라우저에서 `http://localhost:3000/jobs`가 열리면 Ctrl+C로 끄고 다음으로.

### 1-5. 상시 운영 등록

```bash
bash deploy/launchd/install.sh
```

재부팅·크래시 후 자동 복구됩니다. 로그: `deploy/launchd/logs/worker.err.log`

### 1-5b. 자동 푸시 (Cowork·샌드박스에서 만든 커밋 올리기)

Claude Desktop(Cowork) 세션은 Mac과 별개의 샌드박스라 GitHub 자격증명이 없어 커밋만 남기고 push는 못 합니다. 토큰을 어디 두는 대신, Mac에서 1분마다 미푸시 커밋을 감지해 키체인으로 push하는 LaunchAgent를 씁니다.

```bash
cp config/autopush.example.txt config/autopush.txt   # 대상 리포 절대경로, 한 줄에 하나
bash deploy/autopush/install.sh                       # 등록. 로그: deploy/launchd/logs/autopush.log
```

규칙: upstream을 추적 중인 현재 브랜치만, fast-forward일 때만 push합니다. 원격이 앞서 있으면 보류 로그만 남기고, force push는 하지 않습니다. 리포별로 잠시 끄려면 `touch <리포>/.git/autopush-off`.

### 1-6. Unity 안에서 보내는 스크린샷·녹화 (MyUtil WebhookFeedback)

워커 완료 알림과는 별개 경로입니다. TeenipingTycoon 프로젝트 루트에:

```bash
mkdir -p /Users/cykim/repo/TeenipingTycoon/Secrets
echo "https://hooks.slack.com/services/..." > /Users/cykim/repo/TeenipingTycoon/Secrets/slack_webhook_url.txt
echo "Slack" > /Users/cykim/repo/TeenipingTycoon/Secrets/webhook_active_provider.txt
```

`Secrets/`가 `.gitignore`에 있는지 확인하세요.

### 1-7. Windows 메인 PC — MCP 연결

Windows에도 이 리포가 clone돼 있어야 합니다 (`C:\Users\cykim\repo\claude-better-plan-mode`, `npm install` 완료). `<WORKER_TOKEN>`은 Mac `.env.local`의 값입니다.

**Claude Code** — HTTP로 직접 붙습니다 (PowerShell):

```powershell
claude mcp add --transport http mac-worker http://macmini-macmini:4000/mcp --header "Authorization: Bearer <WORKER_TOKEN>" -s user
claude mcp list        # mac-worker: ... - ✓ Connected 가 보여야 합니다
```

`-s user`라 어느 폴더에서 열어도 보입니다. **이미 열려 있던 Claude Code 세션은 재시작**해야 툴이 잡힙니다.

**Claude Desktop** — 헤더를 못 붙이므로 stdio 브리지(`mcp/worker-client.mjs`)를 씁니다. `%APPDATA%\Claude\claude_desktop_config.json`에:

```json
{
  "mcpServers": {
    "mac-worker": {
      "command": "node",
      "args": ["C:\\Users\\cykim\\repo\\claude-better-plan-mode\\mcp\\worker-client.mjs"],
      "env": {
        "WORKER_URL": "http://macmini-macmini:4000/mcp",
        "WORKER_TOKEN": "<WORKER_TOKEN>"
      }
    }
  }
}
```

저장 후 Claude Desktop을 완전히 종료(트레이 아이콘 → Quit)했다가 다시 켭니다. 설정 → 개발자(Developer)에서 `mac-worker`가 running이면 됩니다.

Claude Code도 같은 브리지로 맞추고 싶으면:

```powershell
claude mcp add mac-worker -s user -e WORKER_URL=http://macmini-macmini:4000/mcp -e WORKER_TOKEN=<WORKER_TOKEN> -- node C:\Users\cykim\repo\claude-better-plan-mode\mcp\worker-client.mjs
```

### 1-8. Windows 메인 PC — 스킬 설치

툴이 붙어도 Claude가 "어떻게 쓰는지"는 모릅니다. `skills/remote-worker`를 설치하면 워커에 시키는 흐름(프로젝트 확인 → 모드 → 지시문 → 제출 후 대기하지 않기 → 상태 보고)을 알고 움직입니다.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force C:\Users\cykim\repo\claude-better-plan-mode\skills\remote-worker "$env:USERPROFILE\.claude\skills\"
```

Claude Desktop은 설정 → 스킬 → 추가에서 같은 폴더를 지정합니다. 상세: `skills/README.md`.

마지막으로 Parsec 클라이언트 설치, `http://macmini-macmini:3000/jobs` 북마크.

세팅 끝. 이후 Mac은 전원만 켜져 있으면 됩니다.

---

## 2. 사용 — Windows에서만

### 2-1. 지시

Claude Code를 아무 디렉터리에서나 열고:

> mac-worker로 TeenipingTycoon에 로비 팝업 닫기 버튼 추가시켜. PR 모드로.

Claude가 `job_submit`을 호출하고 **jobId와 보드 URL**을 돌려줍니다. 여기서 Windows 세션을 닫아도 작업은 Mac에서 계속 됩니다.

말로 고를 수 있는 것:

| 선택 | 말하는 법 | 생략하면 |
|---|---|---|
| PR / 직푸시 | "PR 모드로" · "master에 바로 올려" | PR |
| 모델 | "opus로" · "sonnet으로 빠르게" | 프로젝트 `defaultModel` → Mac 기본 |
| 추론 레벨 | "effort max로" · "깊게 생각해서" · "가볍게" | 프로젝트 `defaultEffort` → Mac 기본 |

보드 `http://macmini-macmini:3000/jobs`의 제출 폼에도 같은 선택지가 있습니다.

### 2-2. 진행 확인

| 방법 | 언제 |
|---|---|
| 보드 `http://macmini-macmini:3000/jobs/<id>` | 로그를 실시간으로 보고 싶을 때 |
| Claude에 "job 상태 봐줘" | 요약만 필요할 때 (`job_status`) |
| Claude에 "Mac 화면 보여줘" | Unity 에디터가 어떤 상태인지 (`worker_screenshot`) |
| Slack 채널 | 그냥 기다릴 때 — 끝나면 알림이 옵니다 |

### 2-3. 완료

Slack에 결과·PR 링크·소요 시간이 옵니다.

- **PR 모드** → GitHub에서 PR 리뷰 → 머지
- **direct 모드** → 이미 master에 반영됨. Windows에서 `git pull`

### 2-4. 개입

| 상황 | 방법 |
|---|---|
| 방향이 틀렸다 | "job 취소하고 이렇게 다시" → `job_cancel` + 재제출 |
| 멈춘 것 같다 | `job_status`의 "마지막 활동 N분 전" 확인. 워치독이 알아서 죽이고 확정합니다(claude 20분 무응답 / Unity 10분 무출력). 급하면 `job_cancel` |
| 실패·취소됐는데 변경은 살리고 싶다 | "job 마저 끝내" → `job_resume`. worktree 그대로 커밋 → push → 검증 → PR을 이어서 합니다. 검증 때문에 막혔으면 "검증 없이" → `skipVerify` |
| 직접 봐야 한다 | Parsec으로 Mac 접속. **에이전트 worktree(`~/repo/_worktrees/…`)가 아니라 메인 clone을 여세요** — 같은 폴더는 Unity가 락을 겁니다 |
| 다음 잡 | 바로 제출해도 됩니다. 같은 프로젝트는 순서대로, 다른 프로젝트는 동시에 돕니다 |

보드의 잡 상세 화면에도 **취소 / 이어서 마무리 / 검증 없이 마무리** 버튼이 있습니다.

일상 루프는 **지시 → Slack 알림 → PR 머지** 세 동작입니다.

### 2-5. 워커가 스스로 지키는 것

원격이라 "조용히 멈춘 잡"이 없도록 아래가 자동으로 돕니다. 시간은 `.env.local`에서 조절합니다.

| 감시 | 기본 | 걸리면 |
|---|---|---|
| claude 세션 무응답 | 20분 (`WORKER_CLAUDE_STALL_MIN`) | 세션 종료. 변경이 있으면 pr 모드로 원격 보존 |
| claude 세션 상한 | 90분 (`WORKER_CLAUDE_TIMEOUT_MIN`) | 위와 같음 |
| Unity 로그 무출력 | 10분 (`WORKER_UNITY_STALL_MIN`) | Unity 종료. pr 모드는 PR에 `[검증 시간 초과]` 표시, direct는 실패 |
| Unity 상한 | 45분 (`WORKER_UNITY_TIMEOUT_MIN`) | 위와 같음 |
| git / gh 한 번 | 10분 (`WORKER_GIT_TIMEOUT_MIN`) | 실패 확정 (브랜치가 이미 push됐으면 그 사실을 오류에 남김) |
| 프로세스도 활동도 없음 | 15분 (`WORKER_SWEEP_STALL_MIN`) | 스위퍼가 실패 확정 |

실패로 확정된 잡은 항상 worktree가 남고, Slack 알림에 "이어서 마무리" 안내가 붙습니다.

### 2-6. 잔여물 정리 (자동)

남긴 worktree와 `agent/*` 브랜치는 그대로 두면 계속 쌓입니다 (Unity 프로젝트는 worktree 하나가 수 GB입니다).
보드 서버가 기동 직후, 잡이 끝날 때마다, 그리고 한 시간마다 한 번씩 아래 기준으로 치웁니다.

| 대상 | 지우는 조건 |
|---|---|
| worktree (작업물이 원격에 올라감) | 잡이 끝나고 48시간 (`WORKER_WORKTREE_TTL_HOURS`) |
| worktree (커밋·push 안 된 변경이 남음) | 잡이 끝나고 168시간 (`WORKER_WORKTREE_UNSAVED_TTL_HOURS`). 커밋된 내용은 로컬 브랜치로 남습니다 |
| worktree (잡과 짝이 없는 고아 디렉터리) | 디렉터리 mtime 기준 48시간 |
| 로컬 `agent/*` 브랜치 | worktree가 물고 있지 않고, 원격에 올라갔거나 base에 머지됨 |
| 원격 `agent/*` 브랜치 | PR이 머지·클로즈됐거나 base에 이미 반영됨 (`WORKER_REMOTE_CLEANUP=0`으로 끔) |

실행 중·대기 중인 잡의 worktree는 건드리지 않습니다. 무언가 지워지면 Slack·Discord로 요약이 갑니다.
`WORKER_KEEP_WORKTREE=1`이면 자동 정리도 멈추고, 보드/`worker_cleanup`에서 직접 요청할 때만 지웁니다.
주기는 `WORKER_GC_INTERVAL_MIN`(기본 60분)입니다.

worktree가 정리된 잡은 `job_resume`으로 이어서 마무리할 수 없습니다 — 새 잡으로 제출하세요.
그 전에 이어서 할 게 있으면 기한(위 표) 안에 하면 됩니다.

---

## 3. 다시 켜기 · 문제 해결

### launchd로 등록했다면

아무것도 안 해도 됩니다. 확인만:

```bash
curl -s localhost:4000/health
```

```bash
bash deploy/launchd/install.sh restart   # 코드 수정·npm run build 후
bash deploy/launchd/install.sh remove    # 끄기
bash deploy/launchd/install.sh           # 다시 등록
```

### 포그라운드로 쓴다면

```bash
cd ~/repo/claude-better-plan-mode && npm run worker
```

### 안 뜰 때 — `deploy/launchd/logs/worker.err.log`부터

| 증상 | 원인 → 조치 |
|---|---|
| `WORKER_TOKEN이 없거나 너무 짧습니다` | `.env.local`에 16자 이상 토큰 |
| `node/claude 을 PATH에서 찾지 못했습니다` | `deploy/launchd/run-worker.sh`의 PATH에 설치 경로 추가 |
| 보드가 120초 내에 응답하지 않음 | `npm run build`가 안 됐거나 3000 포트 점유 (`lsof -i :3000`) |
| Claude가 mac-worker를 모른다 | `claude mcp list`에 없음 → 1-7 다시. 있는데 못 쓰면 세션 재시작. 툴은 보이는데 엉뚱하게 쓰면 1-8 스킬 미설치 |
| Windows에서 401 / `worker_unreachable`만 보임 | 토큰 불일치. `claude mcp remove mac-worker` 후 다시 add (Desktop은 config의 `WORKER_TOKEN` 수정 후 완전 재시작) |
| Windows에서 연결 거부 | Tailscale 양쪽 켜졌는지, `WORKER_BIND`가 `0.0.0.0`인지, 브라우저에서 보드가 열리는지 |
| `worker_screenshot` 실패 | 화면 기록 권한 / GUI 세션 없음(SSH로 띄웠을 때). launchd로 다시 |
| PR 생성 실패, 브랜치는 push됨 | `gh auth login`. 브랜치는 이미 올라가 있으니 GitHub에서 수동 PR |
| direct rebase 실패 | 충돌. worktree가 남아 있으니 Parsec으로 들어가 해결 후 `job_resume` |
| Unity 검증 실패·시간 초과 | `data/jobs/<id>-unity.log` 확인. pr 모드면 PR은 이미 올라가 있음. 검증을 끄려면 `projects.json`의 `unityPath` 삭제, 첫 임포트가 원인이면 `seedUnityLibrary: true` |
| 워커 세션이 커밋을 못 함 (`requires approval`) | 기본 `--allowedTools`에 git add/commit이 들어 있어 보통 안 생김. 생겨도 워커가 대신 커밋함. 다른 명령이 막히면 `WORKER_CLAUDE_ALLOWED_TOOLS`에 추가 |
| `running`인데 오래 멈춤 | 2-5의 워치독이 처리. 바로 정리하려면 `job_cancel` → `job_resume` |

### 남은 worktree 정리

**보통은 아무것도 안 해도 됩니다.** 워커가 보관 기한이 지난 잔여물을 알아서 치웁니다 (2-6 참고).
급하게 용량을 비우거나 상태를 보고 싶을 때만 아래를 씁니다.

- 보드 `/jobs` 화면 위쪽 **워크트리 정리** 패널 — 현황·용량 확인, "기한 지난 것 정리", "지금 전부 정리".
- 메인 PC의 Claude에게: `worker_cleanup` 툴 (`dryRun: true`로 목록만 볼 수 있습니다).
- 손으로 할 때:

```bash
cd /Users/cykim/repo/TeenipingTycoon
git worktree list
git worktree remove --force ../_worktrees/TeenipingTycoon-xxxxxxxx
git branch -D agent/xxxxxxxx     # 브랜치도 지울 때
```
