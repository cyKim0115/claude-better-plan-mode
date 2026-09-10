---
description: 보드 UI가 사용하는 REST 엔드포인트. 스크립트나 다른 클라이언트에서 그대로 쓸 수 있습니다.
icon: code
---

# REST API

Base: `http://localhost:3000` (또는 MCP 스폰 시 `:3123`)

## Plans

| Method · Path | Body | 반환 |
|---------------|------|------|
| `GET /api/plans` | — | 플랜 요약 목록 (`id`, `title`, `goal`, `workdir`, `project`, `revision`, `taskCount`, `doneCount`) |
| `POST /api/plans` | `{ goal, project?, workdir?, model?, effort?, async? }` | `project`는 `config/projects.json` 키 — 주면 `workdir`는 그 경로로 채워지고 착수 시 PR/직푸시를 쓸 수 있다. `model`·`effort`는 계획 에이전트용. `async: true`면 스텁(`generating: true`) 즉시 반환 후 백그라운드 생성 |
| `GET /api/plans/:id` | — | `{ plan, runs, jobs }` — run은 `logLength`만, job은 상태·모드·PR 링크 요약 |
| `PATCH /api/plans/:id` | `{ taskStatus?: { taskId, status }, workdir?, project? }` | 갱신된 플랜. `project`에 빈 문자열을 주면 연결 해제 |
| `DELETE /api/plans/:id` | — | `{ ok: true }` |

## Comments & revise

| Method · Path | Body | 반환 |
|---------------|------|------|
| `POST /api/plans/:id/comments` | `{ taskId, text }` (`taskId: null` = 플랜 전체) | 갱신된 플랜 |
| `DELETE /api/plans/:id/comments?commentId=<id>` | — | 갱신된 플랜 |
| `POST /api/plans/:id/revise` | — | 미해결 코멘트 전부 반영된 플랜 (revision +1) |

## Execute & runs

| Method · Path | Body | 반환 |
|---------------|------|------|
| `POST /api/plans/:id/execute` | `{ taskIds: string[], mode?, model?, effort?, maxTurns?, skipPermissions? }` | 프로젝트가 지정된 플랜이면 `{ kind: "job", jobId, mode }`, 아니면 `{ kind: "run", runId }`. `mode`(`pr`\|`direct`)는 프로젝트가 지정된 플랜에서만 |
| `GET /api/runs/:id?since=<n>` | — | `{ status, log, logLength }` — `since` 이후 로그만 (폴링용) |

{% hint style="info" %}
run 조회가 404면 서버 재시작으로 인메모리 기록이 사라진 경우입니다. UI는 이를 `expired`로 표시합니다.
{% endhint %}

## Worker jobs

프로젝트(`config/projects.json`)가 등록돼 있어야 합니다.

| Method · Path | Body | 반환 |
|---------------|------|------|
| `GET /api/jobs` | — | `{ projects, efforts, jobs }` — 등록된 프로젝트 요약과 잡 목록 |
| `POST /api/jobs` | `{ project, prompt, title?, mode?, model?, effort?, maxTurns?, skipPermissions?, skipVerify?, parentJobId?, startFrom? }` | `{ id, status, branch }`. `parentJobId`를 주면 그 잡의 지시·세션 요약이 컨텍스트로 붙고, `startFrom: "parent"`면 그 잡 브랜치 위에서 worktree를 시작합니다 (기본 `"base"`) |
| `GET /api/jobs/:id?since=<n>` | — | 잡 메타 + `since` 이후 로그 (폴링용) |
| `PATCH /api/jobs/:id` | `{ title?, prompt?, mode?, model?, effort?, maxTurns?, skipVerify?, skipPermissions? }` | 아직 시작하지 않은(`queued`) 잡의 제출 옵션 수정. `model`·`effort`에 빈 문자열을 주면 기본값으로 되돌립니다. 실행이 시작된 잡은 거부 |
| `POST /api/jobs/:id/cancel` | — | 대기·실행 중인 잡 취소 (worktree는 남김) |
| `POST /api/jobs/:id/resume` | `{ skipVerify? }` | claude 없이 커밋 단계부터 push·PR까지 마무리 |
| `POST /api/jobs/:id/follow-up` | `{ prompt, asNewJob?, title?, model?, effort?, maxTurns?, skipVerify? }` | 그 잡의 claude 세션을 재개해 추가 지시를 수행합니다. `asNewJob: true`면 worktree·브랜치·PR·세션을 공유하는 새 잡을 만들어 그 id를 돌려줍니다 |
| `PATCH /api/projects/:key` | `{ allowDirect }` | 프로젝트의 직푸시 허용 여부를 바꿉니다 (`config/projects.json`에서 이 필드만 갱신) |
| `GET /api/worktrees?size=1` | — | 남은 worktree 현황 (dry run 스캔, `size=1`이면 용량까지) |
| `POST /api/worktrees` | `{ force?, includeUnsaved?, measure? }` | 즉시 정리 — `force`는 보관 기한 무시, `includeUnsaved`는 저장 안 된 변경이 남은 것까지 |

{% hint style="info" %}
`follow-up`은 worktree가 남아 있는, 끝난 잡에만 됩니다. 정리된 잡은 `POST /api/jobs`에 `parentJobId`를 주는 새 세션으로 이어 가세요.
{% endhint %}

## 상태 값

| 대상 | 값 |
|------|-----|
| Task | `pending` `queued` `running` `done` `failed` `skipped` |
| Run | `starting` `running` `succeeded` `failed` `cancelled` |
| Job | `queued` `running` `succeeded` `failed` `cancelled` (단계: `queued` `worktree` `claude` `commit` `verify` `push` `pr` `cleanup` `done`) |

다음: [Architecture & storage](architecture.md)
