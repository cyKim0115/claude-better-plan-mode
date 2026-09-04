#!/bin/bash
# autopush를 macOS LaunchAgent로 등록/해제한다 (1분 주기).
#   bash deploy/autopush/install.sh          # 등록 + 즉시 1회 실행
#   bash deploy/autopush/install.sh remove
#   bash deploy/autopush/install.sh run      # 지금 한 번만 실행 (등록 없이)
set -euo pipefail

LABEL="com.cykim.autopush"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$REPO/deploy/autopush/$LABEL.plist.template"
TARGET="gui/$(id -u)"

case "${1:-install}" in
  install)
    [ -f "$REPO/config/autopush.txt" ] || { echo "config/autopush.txt 가 없습니다 (autopush.example.txt 복사 후 수정)"; exit 1; }
    mkdir -p "$PLIST_DIR" "$REPO/deploy/launchd/logs"
    sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" "$TEMPLATE" > "$PLIST"
    chmod +x "$REPO/deploy/autopush/autopush.sh"
    launchctl bootout "$TARGET" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "$TARGET" "$PLIST"
    launchctl kickstart -k "$TARGET/$LABEL"
    echo "등록 완료: $PLIST (1분 주기)"
    echo "로그: $REPO/deploy/launchd/logs/autopush.log"
    ;;
  remove)
    launchctl bootout "$TARGET" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "해제 완료"
    ;;
  run)
    bash "$REPO/deploy/autopush/autopush.sh"
    ;;
  *)
    echo "usage: $0 [install|remove|run]"; exit 1 ;;
esac
