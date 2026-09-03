#!/bin/bash
# 워커를 macOS LaunchAgent로 등록/해제한다.
#   bash deploy/launchd/install.sh          # 등록 + 시작
#   bash deploy/launchd/install.sh remove   # 해제
#   bash deploy/launchd/install.sh restart  # 재시작 (코드 갱신 후)
set -euo pipefail

LABEL="com.cykim.better-plan-worker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$REPO/deploy/launchd/$LABEL.plist.template"
TARGET="gui/$(id -u)"

case "${1:-install}" in
  install)
    [ -f "$REPO/.env.local" ] || { echo ".env.local 이 없습니다 (.env.example 참고, WORKER_TOKEN 필수)"; exit 1; }
    [ -f "$REPO/config/projects.json" ] || { echo "config/projects.json 이 없습니다 (projects.example.json 복사 후 수정)"; exit 1; }
    grep -q '^WORKER_TOKEN=.\{16,\}' "$REPO/.env.local" || { echo ".env.local 의 WORKER_TOKEN 이 비었거나 16자 미만입니다"; exit 1; }

    mkdir -p "$PLIST_DIR" "$REPO/deploy/launchd/logs"
    sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" "$TEMPLATE" > "$PLIST"
    chmod +x "$REPO/deploy/launchd/run-worker.sh"

    launchctl bootout "$TARGET" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "$TARGET" "$PLIST"
    launchctl kickstart -k "$TARGET/$LABEL"
    echo "등록 완료: $PLIST"
    echo "로그: $REPO/deploy/launchd/logs/worker.err.log"
    echo "상태: launchctl print $TARGET/$LABEL | head -20"
    ;;
  remove)
    launchctl bootout "$TARGET" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "해제 완료"
    ;;
  restart)
    launchctl kickstart -k "$TARGET/$LABEL"
    echo "재시작 완료"
    ;;
  *)
    echo "usage: $0 [install|remove|restart]"; exit 1 ;;
esac
