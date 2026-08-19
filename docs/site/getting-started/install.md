---
description: Node 20+, Claude Code CLI 인증만 있으면 됩니다. npm install 후 dev 서버를 띄웁니다.
icon: download
---

# Install

{% stepper %}
{% step %}
### 요구 사항 확인

| 요구 | 확인 방법 |
|------|-----------|
| Node.js 20+ | `node -v` |
| Claude Code CLI 설치·로그인 | `claude --version` (PATH에 있어야 함) |

플랜 생성/수정(Agent SDK)과 태스크 실행(`claude -p`) 모두 Claude Code CLI 인증을 사용합니다. 대신 `ANTHROPIC_API_KEY` 환경변수로도 동작합니다.
{% endstep %}
{% step %}
### 클론 + 설치

```powershell
git clone <this-repo> claude-better-plan-mode
cd claude-better-plan-mode
npm install
```

{% endstep %}
{% step %}
### 실행

```powershell
npm run dev        # http://localhost:3000
```

프로덕션 모드로 쓰려면 `npm run build` 후 `npm run start`.
{% endstep %}
{% endstepper %}

{% hint style="warning" %}
단일 서버 프로세스 전제입니다 — `next dev` 또는 `next start` 하나만 띄우세요. 런 로그가 프로세스 메모리에 있어 여러 개 띄우면 로그가 갈립니다.
{% endhint %}

다음: [첫 플랜 만들기](first-plan.md) · [MCP로 필요할 때만 켜기](../integration/mcp.md)
