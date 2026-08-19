# 플랜 데이터 불변식

`lib/types.ts`가 유일한 모델 소스다. API·UI·MCP·에이전트 프롬프트가 모두 이 타입을 공유한다.

## 스토어

- 읽기/쓰기는 항상 `lib/store.ts`를 거친다. `data/plans/`에 직접 `fs` 접근하지 않는다.
- `planPath`의 id 화이트리스트(`/^[a-z0-9-]+$/i`)를 우회하지 않는다 — 경로 조작 방어다.
- 손상된 JSON은 `listPlans`에서 조용히 건너뛴다. 이 관대함을 유지한다(한 파일 때문에 목록 전체가 죽지 않게).
- 쓰기 전 `updatedAt`을 갱신한다. 목록 정렬이 `updatedAt` 기준이다.

## 리비전 / 코멘트

- `revise`는 이력을 남기는 연산이다: `revision` 증가 → `history`에 `RevisionEntry`(요약 + 반영한 코멘트 id) 추가 → 해당 코멘트를 `resolved: true` + `resolvedInRevision`으로 표시.
- 코멘트를 삭제해서 "반영 완료"를 표현하지 않는다. resolved 플래그로만 표현한다.
- `taskId: null`은 플랜 전체 코멘트다. 태스크 코멘트와 같은 배열에 산다 — 필터링 로직을 각자 만들지 말고 한 곳에서 공유한다.

## 태스크 상태

`pending → queued → running → done | failed | skipped`.

- 상태 전이는 실행 경로(`lib/runner.ts`)가 소유한다. UI나 revise가 임의로 `done`을 쓰지 않는다.
- `dependsOn`은 힌트다(강제 게이팅 아님). 게이팅을 넣으려면 부분 착수 UX와 함께 설계한다.
- 새 상태 값을 추가하면 `TaskStatus`, 보드 배지, 웹훅 요약(`lib/notify.ts`)까지 함께 갱신한다.

## 백그라운드 생성

`generating: true` + `generateError`는 MCP `plan_create` 같은 비동기 생성 경로용이다. 생성 완료 시 두 필드를 정리한다. 보드는 이 플래그로 진행 중 화면을 그린다.
