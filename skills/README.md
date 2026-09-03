# 배포용 스킬

이 폴더의 스킬은 **이 리포를 쓰는 다른 기기**에 설치하는 것입니다. 리포 자체의 작업 규칙은 `.claude/skills/`에 따로 있습니다.

| 스킬 | 누가 쓰나 |
|---|---|
| `remote-worker` | 메인 PC의 Claude Code / Claude Desktop — 서브 PC 워커(`mac-worker` MCP)에 작업을 시키는 방법 |

## 설치

### Claude Code (유저 전역)

```bash
# macOS / Linux
mkdir -p ~/.claude/skills && cp -r skills/remote-worker ~/.claude/skills/

# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force skills\remote-worker "$env:USERPROFILE\.claude\skills\"
```

특정 프로젝트에서만 쓰려면 그 프로젝트의 `.claude/skills/`에 복사합니다.

### Claude Desktop

설정 → 스킬(Skills) → 추가에서 `skills/remote-worker` 폴더를 지정합니다. 또는 폴더를 zip으로 묶고 확장자를 `.skill`로 바꿔 드래그해도 됩니다.

## 스킬만으로는 안 됩니다

스킬은 "어떻게 쓰는가"만 알려줍니다. 툴 자체는 MCP로 연결해야 합니다 — `docs/remote-worker-runbook.md`의 **1-7. 메인 PC** 절을 보세요.
