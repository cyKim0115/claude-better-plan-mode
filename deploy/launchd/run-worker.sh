#!/bin/bash
# launchd가 실행하는 워커 진입점.
# launchd 에이전트는 PATH가 거의 비어 있어 node / claude / gh / git 을 못 찾는다 — 여기서 채운다.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

export HOME="${HOME:-$(eval echo ~"$(whoami)")}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# nvm / fnm / volta 사용자 대응
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env)" >/dev/null 2>&1 || true; fi
if [ -d "$HOME/.volta/bin" ]; then export PATH="$HOME/.volta/bin:$PATH"; fi

for bin in node claude git; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[run-worker] $bin 을 PATH에서 찾지 못했습니다. run-worker.sh의 PATH를 보강하세요." >&2
    exit 1
  fi
done
command -v gh >/dev/null 2>&1 || echo "[run-worker] 경고: gh 없음 — PR 모드가 실패합니다 (brew install gh && gh auth login)" >&2

# 상시 운영은 프로덕션 빌드로. 빌드가 없으면 한 번 만든다.
if [ "${PLANMODE_MODE:-start}" = "start" ] && [ ! -d .next ]; then
  echo "[run-worker] .next 없음 — npm run build 실행" >&2
  npm run build
fi

exec node mcp/worker.mjs
