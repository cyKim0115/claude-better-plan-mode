# Agent SDK · 러너 규칙

## `lib/agent.ts` (플랜 생성 / revise)

- 플랜 단계는 **읽기 전용**이다: `allowedTools: ["Read", "Glob", "Grep"]`, `disallowedTools`에 `Write`/`Edit`/`Bash`/`WebFetch` 등. 이 경계를 넓히지 않는다 — 플랜 생성이 대상 리포를 수정하면 안 된다.
- `permissionMode: "default"`, `maxTurns` 상한을 유지한다.
- 모델 출력 파싱은 관대하게(`extractJson`: 코드펜스 → 첫 `{` ~ 마지막 `}`), 사용은 엄격하게(`Raw*` 인터페이스로 받아 정규화). 모델 응답을 그대로 `Plan`으로 캐스팅하지 않는다.
- id는 `newId()`로 생성한다. 모델이 준 id를 그대로 신뢰하지 않는다.

## `lib/runner.ts` (착수)

- 실행은 로컬 `claude` CLI를 `spawn`한다. **셸 문자열 보간으로 명령을 만들지 않는다** — 인자 배열로 넘긴다. 플랜 내용은 신뢰 입력이 아니다.
- 기본 권한은 `--permission-mode acceptEdits`. `--dangerously-skip-permissions`는 사용자가 UI에서 명시적으로 켤 때만 붙는다. 기본값으로 승격시키지 않는다.
- stream-json은 한 줄씩 파싱하고, 파싱 실패한 줄 때문에 런이 죽지 않게 한다.
- 로그는 5000줄에서 앞부분을 잘라낸다(메모리 상한). 이 캡을 제거하지 않는다.
- 런 종료 시 태스크 상태 반영 + `notifyRunComplete`를 fire-and-forget으로 호출한다.

## 프롬프트 조립

`buildPrompt`는 "선택된 작업만 수행, 계획의 다른 작업은 건드리지 말 것"이라는 경계를 명시한다. 부분 착수의 핵심 계약이므로 문구를 약화시키지 않는다.

## 보안

- 대상 프로젝트 경로(`workdir`)는 사용자가 준 임의 경로다. 이걸로 이 앱 자신의 파일을 쓰지 않는다.
- 이 앱은 인증이 없고 로컬 임의 코드 실행을 트리거한다. 공개 바인딩(`dev:lan`, ngrok)을 기본값으로 바꾸는 변경은 하지 않는다.
