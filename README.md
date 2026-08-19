# Better Plan Mode

상호작용 가능한 웹 플랜 모드. 목표를 적으면 Claude가 실행 계획을 세우고, 계획표에 코멘트/첨언을 달아 반영시키고, 원하는 태스크만 체크해서 부분 착수까지 시키는 루프를 웹 UI로 돌립니다.

> 📖 설치·사용 가이드(스크린샷 포함)는 [`docs/site/`](docs/site/README.md)에 있습니다. GitBook 소스 루트는 `.gitbook.yaml`로 지정되어 있어 GitBook.com에 깃 연동하면 바로 사이트가 됩니다.

```
목표 입력 → 플랜 생성 (Agent SDK, 코드베이스 읽기 전용 탐색)
         → 계획표 보드에서 코멘트/첨언
         → [코멘트 반영] 버튼 → 플랜 revision 업데이트 (이력 보존)
         → 태스크 체크 → [선택 착수] → 로컬 claude CLI(-p) 스폰 → 로그 스트리밍
         → 태스크 상태 done/failed 반영 → 다시 코멘트 → 반복
```

## 요구 사항

- Node.js 20+
- Claude Code CLI 설치 및 로그인 (`claude` 명령이 PATH에 있어야 함)
  - 플랜 생성/수정(Agent SDK)과 태스크 실행(claude -p) 모두 이 인증을 사용합니다.
  - 또는 `ANTHROPIC_API_KEY` 환경변수로도 동작합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
```

첫 화면에서 목표와 **대상 프로젝트 경로**(claude가 작업할 리포의 절대경로)를 입력하고 "플랜 생성"을 누르면 됩니다. 생성은 코드베이스 크기에 따라 수 분 걸릴 수 있습니다.

## 사용법

- **코멘트**: 각 태스크 카드 아래 입력창(태스크 대상) 또는 "플랜 전체 코멘트"(계획 전반)에 첨언을 답니다.
- **코멘트 반영**: 하단 액션바의 반영 버튼을 누르면 미해결 코멘트 전부를 Claude가 읽고 계획을 수정합니다. 반영된 코멘트는 resolved 처리되고 revision 이력이 남습니다.
- **부분 착수**: 태스크 체크박스를 골라 "선택 착수"를 누르면 해당 태스크들의 실행 지시문을 조립해 `claude -p`(headless)가 대상 프로젝트에서 수행합니다. 로그가 실시간으로 보드에 흐르고, 종료 시 태스크 상태가 done/failed로 바뀝니다.
- **권한**: 기본은 `--permission-mode acceptEdits`(파일 편집 자동 허용). 체크박스로 `--dangerously-skip-permissions` 전환 가능 — 신뢰하는 리포에서만 쓰세요.

## MCP로 필요할 때만 켜기

서버를 상시 띄워둘 필요 없이, Claude Code 세션에서 플랜 툴이 호출될 때만 보드가 자동으로 켜지게 할 수 있습니다.

```bash
npm install   # @modelcontextprotocol/sdk 포함
claude mcp add planmode -- node C:\Users\cykim\repo\claude-better-plan-mode\mcp\server.mjs
```

이후 아무 프로젝트의 Claude Code 세션에서 "이 목표로 플랜 보드 만들어줘"라고 하면 Claude가 MCP 툴을 호출합니다:

| 툴 | 동작 |
|---|---|
| `plan_create` | (서버 자동 시작 후) 플랜 생성을 백그라운드로 시작하고 보드 URL 즉시 반환. `workdir` 생략 시 현재 세션의 프로젝트 디렉토리 대상 |
| `plan_status` | 생성 진행/태스크 상태/미반영 코멘트 요약 — 세션 안에서 코멘트를 읽고 이어서 작업 가능 |
| `plan_list` | 저장된 플랜 목록 |
| `board_open` | 보드 서버만 켜고 URL 반환 |
| `board_stop` | 이 MCP가 켠 서버 종료 |

수명 주기: 툴이 처음 호출될 때 `next dev`(기본, 포트 3123)를 스폰하고, **30분간 사용이 없으면 자동 종료**되며, Claude 세션이 끝나면 함께 정리됩니다. 이미 떠 있는 보드 서버가 있으면 재사용하고 종료 시 건드리지 않습니다.

환경변수: `PLANMODE_PORT`(기본 3123), `PLANMODE_MODE`(`dev`|`start` — `start`는 사전 `npm run build` 필요), `PLANMODE_IDLE_MINUTES`(기본 30, `0`=자동 종료 끔).

## 원격(다른 기기)에서 접근

```bash
npm run dev:lan    # 0.0.0.0 바인드
```

- 같은 네트워크: `http://<이-PC의-IP>:3000`
- 외부에서: Tailscale 같은 사설망 또는 `cloudflared tunnel`/`ngrok http 3000` 등의 터널 사용을 권장합니다. **인증이 없는 앱이므로 공인 인터넷에 그대로 노출하지 마세요** — 이 앱은 로컬에서 임의 코드 실행(claude CLI)을 트리거할 수 있습니다.

## 저장 위치 / 제약

- 플랜은 `data/plans/*.json`에 저장됩니다 (git-ignore됨). 백업/이동이 쉽습니다.
- 실행(run) 로그는 서버 프로세스 메모리에만 있습니다. 서버 재시작 시 과거 실행 로그는 사라집니다(플랜/태스크 상태는 유지).
- 단일 서버 프로세스 전제입니다 (`next dev` 또는 `next start` 하나만 띄우세요).

## 구조

```
lib/types.ts    플랜/태스크/코멘트/런 데이터 모델
lib/store.ts    data/ 디렉토리 JSON 파일 스토어
lib/agent.ts    Agent SDK로 플랜 생성·코멘트 반영(revise)
lib/runner.ts   claude -p 스폰, stream-json 파싱, 런 레지스트리
app/api/...     REST 엔드포인트 (plans, comments, revise, execute, runs)
components/PlanBoard.tsx  계획표 보드 UI (코멘트·반영·부분 착수·로그)
mcp/server.mjs  MCP 서버 — 온디맨드로 보드 서버 스폰, plan_create/plan_status 등 툴 제공
```
