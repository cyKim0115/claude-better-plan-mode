---
name: grouped-git-commit
description: >-
  Groups related working-tree changes into coherent commits (one or more).
  Use when the user asks for 전체 커밋, 전부 커밋, 단계별 커밋, 비슷한 변경끼리 커밋,
  or to commit a mixed working tree without dumping everything into one commit.
---

# Grouped Git Commit

워킹트리에 섞인 변경을 **비슷한 변경끼리** 묶어 커밋한다. 메시지 형식·`+커푸`는 `korean-git-commit`을 따른다.

핵심은 **관련성으로 묶는 것**이다. 무조건 2개 이상으로 나눌 필요는 없다 — 한 덩어리면 1커밋으로 끝낸다.

## 「전체」의미

「전체 커밋」은 **남은 관련 변경을 빠짐없이** 올리라는 뜻이지, A·B·C 기능을 **한 커밋에** 몰아넣으라는 뜻이 아니다. `git status`의 모든 파일을 그대로 올리라는 뜻도 아니다.

A, B, C가 구현돼 있으면 A만 스테이징해서 커밋 → B → C 순으로 반복한다.

## 절차

1. `git status` / `git diff --stat` / `git log -N --oneline`을 병렬 확인한다. 이어서 전체 `git diff`를 돌리지 않는다.
2. 변경을 **관심사 클러스터**로 나눈다.
3. 클러스터가 하나면 단일 커밋. 둘 이상이면 **의존 순**으로 각각 스테이징·커밋한다.
4. 각 단위는 해당 파일만 경로로 스테이징한다 (`git add path1 path2` — 인터랙티브 `add -p`/`add -i` 금지).
5. 전부 끝난 뒤 `git status`로 남은 파일(의도적 제외분)을 짧게 보고한다.

이미 부분 스테이징돼 있으면 `git restore --staged`로 정리한 뒤 다시 묶는다.

## 이 저장소의 클러스터

같은 커밋에 묶기

| 함께 | 예 |
|---|---|
| 한 기능의 타입 + 스토어 + API + UI | `lib/types.ts` + `app/api/**` + `components/PlanBoard.tsx` |
| 실행 경로 한 세트 | `lib/runner.ts` + `app/api/plans/[id]/execute` |
| 문서 한 세트 | `README.md` + `docs/site/**` + `SUMMARY.md` |

쪼개기

| 분리 | 예 |
|---|---|
| 런타임 로직 vs 문서 | `lib/**` vs `docs/site/**` |
| 앱 vs MCP 서버 | `app/`·`lib/` vs `mcp/server.mjs` |
| 기능 vs 설정/의존성 | 기능 코드 vs `package.json`·`tsconfig.json`·`.claude/**` |
| 알림/부가 기능 vs 코어 플랜 로직 | `lib/notify.ts`·`lib/tunnel.ts` vs `lib/agent.ts`·`store.ts` |

애매하면 **리뷰어가 한 문장으로 설명할 수 있는지**로 판단한다. 한 문장이면 합치고, 두 문장 이상이면 나눈다.

## 기본 제외

- `.env.local` 등 시크릿 (gitignore돼 있어도 강제 추가 금지)
- `data/` 실사용 플랜 데이터
- `.next/`, `node_modules/` 산출물
- 이번 요청과 무관한 워킹트리 잔여 변경

## 커밋 순서 (쪼갤 때)

1. 타입 / 데이터 모델
2. 스토어 · 도메인 로직 (`lib/**`)
3. API 라우트
4. UI (`components/**`, `app/**`)
5. MCP 서버
6. 문서 · 설정

## 안티패턴

- 「전체」요청인데 A·B·C를 한 커밋에 몰아넣기
- 한 관심사인데 억지로 여러 커밋으로 쪼개기
- 메시지에 여러 영역을 `및`으로 나열해 혼합 커밋 숨기기
- 문장형 종결(`~한다` 등) 사용
- 클러스터링하려고 lockfile·산출물 본문 diff를 컨텍스트에 올리기
