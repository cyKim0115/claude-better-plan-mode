---
name: korean-git-commit
description: >-
  Draft Korean git commit messages in this repo's style and commit/push when the
  user ends a request with +커푸. Use when committing, drafting a commit message,
  or seeing 커밋 / 푸시 / +커푸.
---

# Korean Git Commit

상시 규칙 요약은 `CLAUDE.md`. 여기는 절차·안전수칙이다.

## 형식

```text
{prefix}: {구체적 변경 내용}
```

- 한국어 한 줄 제목. Conventional prefix(`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`)는 선택이지만 이 저장소 히스토리가 쓰고 있으니 맞춘다.
- prefix를 생략하면 `{영역} - {내용}` 형태로 쓴다 (`문서 - 설치 가이드 스크린샷 갱신`).
- 영역/스코프 후보: `보드`, `플랜`, `러너`, `MCP`, `API`, `웹훅`, `문서`, `설정`, `타입`.
- 명사/동사구로 끝낸다: `추가`, `수정`, `정리`, `반영`, `구현`.
- **금지**: `~한다`, `~합니다`, `~됩니다` 같은 문장형 종결. `git log`의 문장형 커밋을 따라하지 않는다.
- 영어만으로 된 메시지 금지 (고유명사·API·파일명은 영문 가능).

## 안전 절차

1. `git status` / `git diff --stat` / `git log -15 --oneline`을 **병렬**로 확인한다. 전체 `git diff`는 기본 금지 — 아래 Cheap inspect.
2. `.env.local`, ngrok 토큰, 웹훅 URL 등 시크릿은 스테이징하지 않는다. `data/`는 gitignore지만 강제 추가하지 않는다.
3. 이번 작업 관련 파일만 stage 후 커밋한다.
4. 커밋 후 `git status`로 확인하고, 의도적으로 남긴 변경이 있으면 한 줄로 보고한다.
5. 사용자가 요청하지 않았고 `+커푸`도 없으면 push하지 않는다.
6. `--force` push, `--no-verify` 금지 (사용자가 명시하지 않는 한). git config 변경 금지.

## Cheap inspect (토큰)

비용은 `git` 실행이 아니라 **diff 본문을 컨텍스트에 올리는 것**에서 난다.

| 읽기 | 언제 |
|---|---|
| `git status` + `git diff --stat` + `git log -15 --oneline` | **기본.** 대부분 이걸로 충분 |
| `git diff -- path` (경로 한정) | stat만으로 메시지가 모호할 때 |
| `package-lock.json` 등 생성물 본문 | 열지 않는다. `--stat`으로 끝낸다 |

금지: 확인용으로 lockfile·빌드 산출물 본문 diff를 올리기, `git log`/`status`만 보려고 서브에이전트를 띄우기.

## `+커푸` (커밋 + 푸시)

지시 **끝**에 `+커푸`가 있으면 작업을 마친 뒤:

1. 이번 작업 변경만 확인·스테이징
2. 위 형식으로 커밋
3. `git push` (필요 시 `-u origin HEAD`). **force push 금지**
4. 커밋 해시·푸시 결과를 짧게 안내

## Windows (PowerShell) 메시지

```powershell
git commit -m @'
feat: 구체적 변경 내용

본문이 있으면 여기에
'@
```

닫는 `'@`는 반드시 열 0에 둔다.

## 예시

Good
- `feat: 계획표 수정 완료 시 Discord 웹훅 알림`
- `fix: 런 로그 5000줄 초과 시 앞부분 잘림 처리`
- `문서 - 설치 가이드 스크린샷 갱신`

Bad
- `계획표 수정 시 웹훅을 보내도록 한다.`
- `Add webhook notification`
- `WIP`

## 혼합 워킹트리

관심사가 섞여 있거나 「전체 커밋」「단계별 커밋」이면 `grouped-git-commit`을 먼저 따른다.
