---
description: 태스크를 체크해 선택 착수하면 로컬 claude CLI가 대상 프로젝트에서 실행하고 로그가 보드에 흐릅니다.
icon: play
---

# Partial execution

{% stepper %}
{% step %}
### 태스크 선택

실행할 태스크의 체크박스를 고릅니다. `pending`/`failed`만 선택 가능하고, 선행 태스크가 있으면 순서를 참고하세요.
{% endstep %}
{% step %}
### 착수

**선택한 N개 태스크 착수 ▶**를 누르면 선택 태스크들의 실행 지시문을 조립해 대상 프로젝트(workdir)에서 `claude -p`(headless)가 수행합니다.

<figure><img src="../images/run-log.png" alt="실행 로그"><figcaption>실행 패널 — 실시간 로그 스트리밍</figcaption></figure>
{% endstep %}
{% step %}
### 진행 상황 확인

착수하면 첫 태스크만 `running`이 되고 나머지는 `queued`로 대기합니다. Claude가 태스크를 하나 끝낼 때마다 그 태스크만 `done`(또는 `failed`)으로 바뀌고 다음 태스크가 `running`으로 넘어갑니다.

오른쪽 **진행 현황** 패널에서 완료 개수·진행률 막대·현재 작업 중인 태스크를 한눈에 볼 수 있습니다.
{% endstep %}
{% step %}
### 결과 반영

run이 끝나면 남은 태스크 상태가 `done`/`failed`로 확정됩니다. 실패한 태스크는 다시 체크해 재착수하거나, 코멘트로 계획을 고친 뒤 재시도합니다.
{% endstep %}
{% endstepper %}

## 진행 현황 패널

| 요소 | 의미 |
|------|------|
| 진행률 막대 | 초록 = 완료, 빨강 = 실패 비율 |
| `N / M 완료` | 확정된 태스크 수와 진행률 |
| 경과 시간 | 착수부터 지금까지 (끝난 run은 총 소요 시간) |
| 태스크 목록 | `✓` 완료 · 스피너 진행 중 · `·` 대기 · `✕` 실패 |

{% hint style="info" %}
Claude는 태스크를 마칠 때마다 진행 마커를 출력하고, 보드는 그 마커를 읽어 상태를 갱신합니다. 마커가 빠지더라도 run이 끝나는 시점에 남은 태스크가 일괄 확정되므로 상태가 `running`에 머무르지 않습니다.
{% endhint %}

## 권한 모드

| 모드 | 플래그 | 언제 |
|------|--------|------|
| 기본 | `--permission-mode acceptEdits` | 파일 편집 자동 허용 (기본값) |
| 생략 | `--dangerously-skip-permissions` | 액션바 체크박스로 전환 |

{% hint style="warning" %}
`--dangerously-skip-permissions`는 모든 권한 확인을 건너뜁니다. **신뢰하는 리포에서만** 쓰세요.
{% endhint %}

{% hint style="info" %}
run 로그는 서버 프로세스 메모리에만 있습니다. 서버를 재시작하면 과거 로그는 `expired`로 표시됩니다 (태스크 상태는 유지).
{% endhint %}

다음: [MCP on-demand](../integration/mcp.md) · [REST API](../reference/api.md)
