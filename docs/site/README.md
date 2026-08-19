---
description: 상호작용 가능한 웹 플랜 모드 — 목표를 적으면 Claude가 계획을 세우고, 코멘트로 다듬고, 원하는 태스크만 골라 실행합니다.
icon: house
---

# Better Plan Mode

Claude Code의 플랜 모드를 **웹 보드**로 확장한 앱입니다. 목표를 입력하면 Claude(Agent SDK)가 코드베이스를 읽기 전용으로 탐색해 실행 계획을 세우고, 계획표에 코멘트를 달아 반영시키고, 원하는 태스크만 체크해서 로컬 `claude` CLI로 부분 착수시키는 루프를 반복합니다.

```
목표 입력 → 플랜 생성 (Agent SDK, 읽기 전용 탐색)
         → 보드에서 코멘트/첨언
         → [코멘트 반영] → revision 업데이트 (이력 보존)
         → 태스크 체크 → [선택 착수] → claude -p 스폰 → 로그 스트리밍
         → done/failed 반영 → 다시 코멘트 → 반복
```

<table data-view="cards">
  <thead>
    <tr>
      <th></th>
      <th></th>
      <th data-hidden data-card-target data-type="content-ref"></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Getting started</td>
      <td>설치, 인증, 첫 플랜</td>
      <td>
        <a href="getting-started/install.md">install.md</a>
      </td>
    </tr>
    <tr>
      <td>Guide</td>
      <td>보드 구성, 코멘트·반영, 부분 착수</td>
      <td>
        <a href="guide/board.md">board.md</a>
      </td>
    </tr>
    <tr>
      <td>Integration</td>
      <td>MCP 온디맨드, 원격 접근</td>
      <td>
        <a href="integration/mcp.md">mcp.md</a>
      </td>
    </tr>
  </tbody>
</table>

## 한 줄로

| 단계 | 누가 | 무엇을 |
|------|------|--------|
| Plan | Agent SDK (`query()`) | 코드베이스 탐색 → phase/task 계획 생성 |
| Review | 사용자 | 태스크·플랜 전체에 코멘트 |
| Revise | Agent SDK | 미해결 코멘트 반영, revision 증가 |
| Execute | `claude -p` (headless) | 선택 태스크 실행, 로그 스트리밍 |
| Repeat | 사용자 | 상태 확인 → 다시 코멘트/착수 |

## 이 문서와 레포의 관계

| 용도 | 위치 |
|------|------|
| 사람용 가이드 (이 사이트) | `docs/site/` |
| 앱 코드 | `app/`, `components/`, `lib/` |
| MCP 서버 | `mcp/server.mjs` |

{% hint style="info" %}
GitBook에 올리는 소스는 `docs/site/`만입니다. 플랜 데이터(`data/plans/`)는 git-ignore됩니다.
{% endhint %}
