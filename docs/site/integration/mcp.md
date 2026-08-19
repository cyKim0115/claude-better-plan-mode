---
description: 서버를 상시 띄우지 않고, Claude Code 세션에서 플랜 툴이 호출될 때만 보드를 자동으로 켭니다.
icon: plug
---

# MCP on-demand

{% stepper %}
{% step %}
### 등록

```powershell
npm install   # @modelcontextprotocol/sdk 포함
claude mcp add planmode -- node C:\path\to\claude-better-plan-mode\mcp\server.mjs
```

{% endstep %}
{% step %}
### 사용

아무 프로젝트의 Claude Code 세션에서:

> "이 목표로 플랜 보드 만들어줘"

Claude가 `plan_create`를 호출하면 보드 서버가 자동으로 켜지고 URL이 반환됩니다. `workdir`를 생략하면 현재 세션의 프로젝트 디렉토리가 대상입니다.
{% endstep %}
{% endstepper %}

## 툴

| 툴 | 동작 |
|---|---|
| `plan_create` | (서버 자동 시작 후) 플랜 생성을 백그라운드로 시작, 보드 URL 즉시 반환 |
| `plan_status` | 생성 진행/태스크 상태/미반영 코멘트 요약 — 세션에서 코멘트 읽고 이어서 작업 |
| `plan_list` | 저장된 플랜 목록 |
| `board_open` | 보드 서버만 켜고 URL 반환 |
| `board_stop` | 이 MCP가 켠 서버 종료 |

## 수명 주기

- 툴 첫 호출 시 `next dev`(기본 포트 3123)를 스폰
- **30분간 미사용 시 자동 종료**, Claude 세션 종료 시 함께 정리
- 이미 떠 있는 보드 서버는 재사용만 하고 종료하지 않음

## 환경변수

| 변수 | 기본 | 의미 |
|------|------|------|
| `PLANMODE_PORT` | `3123` | 보드 포트 |
| `PLANMODE_MODE` | `dev` | `dev` \| `start` (`start`는 사전 `npm run build` 필요) |
| `PLANMODE_IDLE_MINUTES` | `30` | 유휴 자동 종료 (0 = 끔) |

다음: [Remote access](remote.md)
