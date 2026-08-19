# Claude Code Stop 훅: 파일을 수정한 턴이 끝날 때 프로젝트 규칙 준수 여부를 자동 후속 검토로 트리거한다.
# stdin: { session_id, transcript_path, hook_event_name, stop_hook_active }
# 출력: {} (무시) 또는 { decision: "block", reason: "<followup>" } (턴을 이어가며 메시지를 모델에 전달)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-EmptyResponse {
    Write-Output "{}"
    exit 0
}

function Test-TranscriptHasFileEdits {
    param([string]$TranscriptPath)

    if ([string]::IsNullOrWhiteSpace($TranscriptPath)) { return $false }
    if (-not (Test-Path -LiteralPath $TranscriptPath)) { return $false }

    $pattern = '"name"\s*:\s*"(Write|Edit|NotebookEdit)"'
    return Select-String -Path $TranscriptPath -Pattern $pattern -Quiet
}

function Get-FollowupMessage {
    @'
[규칙 준수 검사 - 자동 후속 검토]

이 메시지는 파일을 수정한 턴이 끝날 때 Stop 훅이 자동 실행한 것입니다. CLAUDE.md 상시 규칙과 `.claude/rules/` 조건부 규칙 준수 여부를 확인하세요.

## 수행할 작업

1. 이번 대화에서 수정·추가된 파일을 확인합니다 (`git status`, `git diff --stat`).
2. 변경 파일에 적용되는 규칙만 읽고 검사합니다. 무관한 규칙 파일은 열지 마세요.

## 체크리스트

- 시크릿: `.env.local` 값·웹훅 URL·API 키가 코드·로그·문서·커밋에 노출되지 않았는가
- 타입: `any` 사용 없음, 외부 경계(에이전트 응답·요청 본문·MCP 인자) 검증 있음
- 경계: 서버 전용 모듈(`lib/store.ts`, `lib/runner.ts`)을 클라이언트 컴포넌트에서 import하지 않았는가
- 데이터: 플랜 변경이 `savePlan` 경유 + `updatedAt` 갱신, 코멘트는 삭제가 아닌 resolved 처리
- 실행 경로: 읽기 전용 툴 제한(`lib/agent.ts`)·기본 권한 모드(`acceptEdits`)를 약화시키지 않았는가
- 알림: 웹훅 호출이 fire-and-forget이며 응답 경로를 막지 않는가
- 톤: `README.md`·`docs/site/**` 존댓말, 코드 주석·로그에 이모지 없음
- 범위: 요청 범위를 벗어난 변경·불필요한 방어 코드 없음

## 결과 보고

- 위반 없음이면 "규칙 준수 검사 완료: 위반 없음" 한 줄로 마무리하세요.
- 위반이 있으면 (규칙, 파일 경로, 설명)을 밝히고 즉시 수정한 뒤 고친 파일을 명시하세요.
'@
}

try {
    $stdin = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($stdin)) { Write-EmptyResponse }

    $hookInput = $stdin | ConvertFrom-Json

    if ($hookInput.stop_hook_active -eq $true) { Write-EmptyResponse }
    if (-not (Test-TranscriptHasFileEdits -TranscriptPath $hookInput.transcript_path)) { Write-EmptyResponse }

    $output = @{
        decision = "block"
        reason   = Get-FollowupMessage
    }
    Write-Output ($output | ConvertTo-Json -Compress)
    exit 0
}
catch {
    [Console]::Error.WriteLine("[rule-compliance-stop] failed: $_")
    Write-EmptyResponse
}
