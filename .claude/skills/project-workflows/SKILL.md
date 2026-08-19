---
name: project-workflows
description: >-
  Index for this project's shared workflows: Korean git commits, +커푸 commit+push,
  grouped/stepwise commits, README·docs tone, and dev server rebuild/restart.
  Use when committing, drafting commit messages, pushing, 전체 커밋, splitting mixed
  working-tree changes, editing README or docs/site, or restarting the board server.
---

# Project Workflows

- `korean-git-commit` — 한글 커밋 메시지 · 커밋/푸시 절차 · `+커푸`
- `grouped-git-commit` — 관심사별 묶음 커밋 · 「전체」커밋의 의미
- `readme-tone` — README·`docs/site/**` 존댓말 톤
- `dev-server-restart` — 타입 체크 · 빌드 · 개발/보드 서버 재시작

## Routing

| 요청 | 스킬 |
|---|---|
| 커밋 / 커밋 메시지 / 푸시 / `+커푸` | `korean-git-commit` |
| 전체 커밋 / 전부 커밋 / 단계별 커밋 / 비슷한 것끼리 / 혼합 워킹트리 | `grouped-git-commit` |
| README / 사용 안내 / GitBook 문서 / 존댓말 톤 | `readme-tone` |
| 빌드 확인 / 서버 재시작 / 3000·3123 포트 정리 / 화면 확인 | `dev-server-restart` |
