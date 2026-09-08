# 원격 워커 R&D 핸드오프

이 문서는 "지금 어떻게 되어 있는가"가 아니라 **"왜 이렇게 됐는가"** 를 남깁니다.
설치·사용법은 [`docs/remote-worker-runbook.md`](remote-worker-runbook.md), 기술 상세는
[`docs/site/integration/worker.md`](site/integration/worker.md), 코드 규칙은 루트 `CLAUDE.md`를 보세요.

마지막 갱신: 2026-09-04

---

## 1. 무엇을 만들었나

Windows 메인 PC에서 지시하면 Mac mini가 전용 worktree를 만들고 `claude -p`를 돌려
커밋 → push/PR → Unity 검증 → Slack 알림까지 스스로 끝내는 원격 워커입니다.
메인 PC 세션은 지시를 넘기고 상태를 읽는 역할만 합니다.

원격이기 때문에 R&D의 기준선은 처음부터 하나였습니다 — **잡은 반드시 마무리되거나, 실패로 확정되거나, 이어서 끝낼 수 있어야 한다.**
"조용히 멈춰 있는 잡"은 원격에서 가장 나쁜 상태입니다. 아래 결정들은 대부분 이 한 문장에서 나왔습니다.

## 2. 사건 — 잡 `551325f5`

보드에서 `running · verify`로 멈춘 채 끝나지 않았고, 커밋은 됐는데 push도 PR도 없었습니다.

로그를 뜯어본 결과:

- 워커 세션이 `acceptEdits` 권한이라 `git commit`이 승인 대기에 걸렸고, 워커가 대신 커밋했습니다. **이건 설계된 폴백이라 문제가 아닙니다.**
- 진짜 멈춘 곳은 그다음 `verify` 단계의 Unity 배치모드였습니다. 새 worktree에는 `Library/`가 없어 전체 임포트를 하는데,
  수십 분이 걸리거나 아예 끝나지 않았고 **당시엔 어떤 상한도 없었습니다.**
- 그리고 push가 검증 *뒤*에 있어서, 이미 커밋된 작업물이 Mac 로컬에만 갇혔습니다.

## 3. 그래서 내린 결정

### 3-1. 모든 외부 프로세스에 워치독 (커밋 `7cf3541`)

`claude` · Unity · `git` · `gh` 어느 것도 상한 없이 스폰하지 않습니다. 전체 상한과 "N분간 출력 없음" 정지 감지를 함께 걸고,
걸리면 **프로세스 트리째** 종료한 뒤 잡을 확정합니다. Unity는 `-logFile -`로 stdout을 스트리밍해 진행 여부를 관측 가능하게 만들었습니다.
마지막 안전망으로, 프로세스도 활동도 없는 `running` 잡은 스위퍼가 15분 뒤 실패로 확정합니다.

기본값과 환경변수는 런북 2-5 표에 있습니다. **워치독 없는 스폰을 새로 추가하지 않는 것**이 이 설계의 전제입니다(`CLAUDE.md` 상시 규칙).

### 3-2. push 우선, 검증은 그 뒤

`pr` 모드는 커밋 직후 push하고 검증을 나중에 합니다. 검증이 죽어도 PR은 이미 올라가 있고 제목에 `[검증 시간 초과]`가 붙습니다.
원격 작업에서는 **원격 보존이 검증 통과보다 우선**이라는 판단입니다. `direct`(기본 브랜치 직푸시)는 되돌리기 비용이 크므로
검증을 통과해야만 push합니다.

이 순서는 바꾸지 않습니다.

### 3-3. `job_resume` — 실패는 종착점이 아니다

실패·취소한 잡은 worktree를 남기고, `resumeJob`이 커밋 단계부터 이어받아 push·PR까지 끝냅니다.
보드의 "이어서 마무리" 버튼, MCP의 `job_resume`, Slack 알림의 안내가 모두 같은 경로입니다.
검증이 문제였다면 `skipVerify`를 붙입니다.

### 3-4. 실행 선택지를 잡 제출 시점으로

`job_submit`에 `mode`(pr/direct) · `model` · `effort`(low~max) · `maxTurns`를 넣고, 프로젝트별 `defaultModel`·`defaultEffort`로 기본값을 둡니다.
`direct`는 `allowDirect: false`로만 잠기는 기본 허용으로 바꿨습니다.
워커 세션에는 `git add`/`commit`을 `--allowedTools`로 기본 허용해, 폴백에 기대지 않고 스스로 커밋하게 했습니다.

### 3-5. Unity 첫 임포트 회피

`seedUnityLibrary: true`면 메인 clone의 `Library/`를 APFS clonefile(`cp -c`)로 즉시 복사합니다.
2절의 근본 원인을 상한이 아니라 아예 없애는 쪽입니다. Unity 프로젝트에는 켜 두기를 권합니다.

## 4. 메인 PC 연결 — 왜 브리지가 따로 있나

Claude Code는 HTTP MCP에 `Authorization` 헤더를 붙일 수 있어 `http://<host>:4000/mcp`에 직결합니다.
**Claude Desktop / Cowork는 헤더를 못 붙입니다.** 그래서 stdio 브리지 `mcp/worker-client.mjs`를 두고,
`WORKER_URL`·`WORKER_TOKEN`을 `env`로 받아 대신 붙입니다.

브리지는 워커가 꺼졌거나 토큰이 틀리면 `worker_unreachable` 툴 하나만 노출합니다 — 툴이 아예 안 보이는 것과
"연결이 안 된다"를 구분하기 위해서입니다.

자주 나온 오해 두 가지:

- **보드(3000)가 열린다고 MCP(4000)가 붙은 것은 아닙니다.** 다른 포트입니다.
- **등록 후 호스트 앱을 완전히 재시작해야** 툴이 잡힙니다. 등록 전에 열어 둔 세션은 계속 툴을 못 봅니다.

절차는 런북 1-7 · 1-8절에 있습니다.

## 5. 플랜 착수를 잡 파이프라인에 합류

플랜에 `project`가 있으면 착수가 워커 잡 파이프라인을 그대로 탑니다 — worktree, 워치독, push/PR, 검증, 알림, `job_resume`까지
전부 공유합니다. 지시문 조립과 진행 마커(`[[TASK_DONE:...]]` → 태스크 상태) 처리는 `lib/plan-run.ts`로 분리해
두 실행 경로(`runner` · `jobs`)가 복제 없이 씁니다.

PR/직푸시·모델·effort·권한 확인 생략 선택은 **계획표 액션바(착수 시점)** 에 둡니다. 플랜 생성 시점으로 옮기지 않습니다 —
계획을 세운 뒤 어떻게 올릴지가 바뀌는 일이 잦기 때문입니다. 프로젝트를 안 고른 레거시 플랜은 경로만 입력해 실행하는
기존 경로로 가고, 그때는 PR/직푸시 셀렉트가 잠깁니다.

## 6. autopush — PAT를 쓰지 않기로 한 이유

Cowork 샌드박스는 Mac과 별개의 Linux 환경이라 macOS 키체인·`gh auth`를 보지 못합니다. 그래서 샌드박스에서 만든 커밋을
push할 수단이 없었습니다.

처음엔 fine-grained PAT를 리포의 `.git/github-token`에 두고 credential helper로 읽는 안을 검토했습니다.
동작은 하지만 **토큰이 디스크에 평문으로 남습니다.** 결국 "Mac이 대신 올린다"로 뒤집었고, 발급했던 PAT는 폐기했습니다.

`deploy/autopush/`는 각 리포의 `.git/logs/HEAD`를 `WatchPaths`로 감시해 커밋 직후 push하는 LaunchAgent입니다.
처음엔 `StartInterval 60`이었는데, 커밋 감지 방식으로 바꾸고 5분 주기는 안전망으로만 남겼습니다.
upstream 추적 브랜치 + fast-forward일 때만 올리고, force는 금지, rebase/merge 중이거나 원격이 앞서면 보류 로그만 남깁니다.
대상 목록은 `config/autopush.txt`이고, **목록을 고치면 `install.sh`를 다시 돌려야** WatchPaths가 갱신됩니다.

## 7. Cowork 샌드박스에서 안 되는 것

이 리포를 Cowork로 작업할 때 반복해서 부딪힌 것들입니다.

| 제약 | 우회 |
|---|---|
| 키체인·`gh auth` 접근 불가 → 직접 push 불가 | autopush (6절) |
| `launchctl` 사용 불가 | LaunchAgent 설치·재시작은 Mac 터미널에서 직접 |
| 마운트 파일시스템이 `unlink`를 막아 git이 `index.lock`을 못 지움 | `rename`으로 우회됩니다. 경고가 남아도 커밋 자체는 정상 |
| `next build`가 마운트 fs에서 시간 초과 | `tsc --noEmit`까지만 확인하고, `npm run build`는 Mac에서 |

## 8. 사람이 직접 해야 하는 것

샌드박스가 못 하는 일이라 매번 사용자에게 넘어갑니다.

```bash
cd ~/repo/claude-better-plan-mode
git push                                                  # autopush 등록 전이라면
npm run build && bash deploy/launchd/install.sh restart    # 워커 코드 변경 반영
bash deploy/autopush/install.sh                            # autopush 최초 설치 / 대상 목록 변경 시
```

- `config/projects.json`에 Unity 프로젝트라면 `"seedUnityLibrary": true`
- Windows 메인 PC: `git pull` 후 `skills/remote-worker`를 `~/.claude/skills/`로 재복사 (스킬이 바뀔 때마다)
