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
- `allowDirect` — `direct` 모드(기본 브랜치 직푸시)를 쓰려면 `true`. 기본 `false` 권장
- `unityPath` — 있으면 push 전에 Unity 배치모드 컴파일 검증. **첫 임포트가 수 분 걸리므로 처음엔 줄을 지우고 시작**하세요

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

### 1-6. Unity 안에서 보내는 스크린샷·녹화 (MyUtil WebhookFeedback)

워커 완료 알림과는 별개 경로입니다. TeenipingTycoon 프로젝트 루트에:

```bash
mkdir -p /Users/cykim/repo/TeenipingTycoon/Secrets
echo "https://hooks.slack.com/services/..." > /Users/cykim/repo/TeenipingTycoon/Secrets/slack_webhook_url.txt
echo "Slack" > /Users/cykim/repo/TeenipingTycoon/Secrets/webhook_active_provider.txt
```

`Secrets/`가 `.gitignore`에 있는지 확인하세요.

### 1-7. Windows 메인 PC

```
claude mcp add --transport http mac-worker http://macmini-macmini:4000/mcp --header "Authorization: Bearer <WORKER_TOKEN>" -s user
```

`<WORKER_TOKEN>`은 Mac `.env.local`의 값. Parsec 클라이언트 설치, `http://macmini-macmini:3000/jobs` 북마크.

세팅 끝. 이후 Mac은 전원만 켜져 있으면 됩니다.

---

## 2. 사용 — Windows에서만

### 2-1. 지시

Claude Code를 아무 디렉터리에서나 열고:

> mac-worker로 TeenipingTycoon에 로비 팝업 닫기 버튼 추가시켜. PR 모드로.

Claude가 `job_submit`을 호출하고 **jobId와 보드 URL**을 돌려줍니다. 여기서 Windows 세션을 닫아도 작업은 Mac에서 계속 됩니다.

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
| 직접 봐야 한다 | Parsec으로 Mac 접속. **에이전트 worktree(`~/repo/_worktrees/…`)가 아니라 메인 clone을 여세요** — 같은 폴더는 Unity가 락을 겁니다 |
| 실패했다 | 보드에서 로그 확인. worktree는 남아 있으니 Parsec으로 들어가 이어서 고치거나, 새 잡으로 재시도 |
| 다음 잡 | 바로 제출해도 됩니다. 같은 프로젝트는 순서대로, 다른 프로젝트는 동시에 돕니다 |

일상 루프는 **지시 → Slack 알림 → PR 머지** 세 동작입니다.

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
| Windows에서 401 | 토큰 불일치. `claude mcp remove mac-worker` 후 다시 add |
| Windows에서 연결 거부 | Tailscale 양쪽 켜졌는지, `WORKER_BIND`가 `0.0.0.0`인지 |
| `worker_screenshot` 실패 | 화면 기록 권한 / GUI 세션 없음(SSH로 띄웠을 때). launchd로 다시 |
| PR 생성 실패, 브랜치는 push됨 | `gh auth login`. 브랜치는 이미 올라가 있으니 GitHub에서 수동 PR |
| direct rebase 실패 | 충돌. worktree가 남아 있으니 Parsec으로 들어가 해결 후 수동 push |
| Unity 검증 실패 | `data/jobs/<id>-unity.log` 확인. 검증을 끄려면 `projects.json`의 `unityPath` 삭제 |

### 남은 worktree 정리

실패·취소한 잡의 worktree는 `~/repo/_worktrees/`에 남습니다.

```bash
cd /Users/cykim/repo/TeenipingTycoon
git worktree list
git worktree remove --force ../_worktrees/TeenipingTycoon-xxxxxxxx
git branch -D agent/xxxxxxxx     # 브랜치도 지울 때
```
