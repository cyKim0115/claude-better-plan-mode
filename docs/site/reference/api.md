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

## 상태 값

| 대상 | 값 |
|------|-----|
| Task | `pending` `queued` `running` `done` `failed` `skipped` |
| Run | `starting` `running` `succeeded` `failed` `cancelled` |

다음: [Architecture & storage](architecture.md)
