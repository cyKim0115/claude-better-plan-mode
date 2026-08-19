---
description: 코드 구조, 데이터 저장 위치, 알려진 제약.
icon: sitemap
---

# Architecture & storage

## 구조

```
lib/types.ts    플랜/태스크/코멘트/런 데이터 모델
lib/store.ts    data/ 디렉토리 JSON 파일 스토어
lib/agent.ts    Agent SDK로 플랜 생성·코멘트 반영(revise)
lib/runner.ts   claude -p 스폰, stream-json 파싱, 런 레지스트리
app/api/...     REST 엔드포인트 (plans, comments, revise, execute, runs)
components/PlanBoard.tsx  계획표 보드 UI
mcp/server.mjs  MCP 서버 — 온디맨드 보드 스폰, plan_create 등 툴
```

## 설계 결정

| 항목 | 선택 | 이유 |
|------|------|------|
| 플랜 생성 | Agent SDK `query()`, 읽기 전용 툴(Read/Glob/Grep)만 허용 | 계획 단계에서 코드 변경 방지 |
| 실행 | `claude -p --output-format stream-json`, 프롬프트는 stdin | Windows 인용 문제 회피 |
| UI 갱신 | 폴링 (3초/1.5초) | SSE 없이 단순하게 |
| revise | 기존 task id 유지, `done`/`failed` 보존 | 완료 작업 되돌림 방지 |

## 저장 위치

| 데이터 | 위치 | 수명 |
|--------|------|------|
| 플랜 | `data/plans/*.json` (git-ignore) | 영구 — 백업/이동 쉬움 |
| run 로그 | 서버 프로세스 메모리 | 서버 재시작 시 소멸 |

## 제약

- 단일 서버 프로세스 전제 (`next dev` 또는 `next start` 하나만).
- 인증 없음 — [Remote access](../integration/remote.md)의 보안 주의 참조.
- 서버 재시작 시 과거 run 로그는 사라지지만 플랜/태스크 상태는 유지됩니다.
