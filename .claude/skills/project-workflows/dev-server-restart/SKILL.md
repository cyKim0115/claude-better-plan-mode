---
name: dev-server-restart
description: >-
  Type-check, build, and restart the Better Plan Mode dev server (port 3000) or
  the MCP-spawned board server (port 3123). Use when the user wants to verify a
  change in the running app, mentions 재시작 / 빌드 확인 / 서버 껐다 켜줘, or when a
  stale server is serving old code.
---

# 개발 서버 재시작 · 빌드 확인

## 원칙

- `npm run dev`를 **포그라운드로 실행하지 않는다**. 블로킹돼서 턴이 끝나지 않는다. 반드시 백그라운드로 띄운다.
- 단일 서버 프로세스 전제다 (`lib/runner.ts`의 인메모리 런 레지스트리). `next dev`와 `next start`를 동시에 띄우지 않는다.
- 서버를 재시작하면 **진행 중인 런 로그가 사라진다**. 실행 중인 런이 있으면 먼저 사용자에게 알린다.

## 가벼운 검증 (기본)

코드만 고쳤고 화면 확인이 필요 없으면 여기서 끝낸다.

```bash
npx tsc --noEmit
```

라우팅·번들까지 확인이 필요하면:

```bash
npm run build
```

## 재시작 절차

1. 무엇이 떠 있는지 확인한다.

```bash
netstat -ano | findstr ":3000 :3123"
```

2. 해당 PID를 종료한다 (`taskkill /PID <pid> /F`). 포트 3123은 MCP가 띄운 보드 서버다 — 죽이면 다음 툴 호출 때 다시 스폰된다.
3. 개발 서버를 **백그라운드로** 띄운다.

```bash
npm run dev
```

4. 뜰 때까지 기다린 뒤 확인한다.

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```

`200`이면 성공. 실패하면 백그라운드 출력에서 컴파일 에러를 읽어 사용자에게 전달한다.

## 화면 확인

UI 변경을 눈으로 확인해야 하면 `mcp__Claude_Browser__preview_start`로 `http://localhost:3000`을 연다. 스크린샷보다 `read_page`(접근성 트리)가 텍스트·구조 검증에 싸다.

## 에이전트 규칙

- 사용자가 "확인해줘 / 돌려봐"라고 하면 안내만 하지 말고 **직접 실행**한다.
- `npm install`은 `package.json` 의존성이 바뀐 경우에만 돌린다.
- 환경변수(`DISCORD_WEBHOOK_URL`, `PLANMODE_PORT` 등)를 확인해야 하면 `.env.local`의 **키 이름만** 언급하고 값은 출력하지 않는다.
