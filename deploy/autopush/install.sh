#!/bin/bash
# autopush를 macOS LaunchAgent로 등록/해제한다.
# 대상 리포의 .git/logs/HEAD(커밋할 때마다 갱신)를 감시해 커밋 직후 push하고,
# 이벤트를 놓친 경우를 위해 5분 주기 안전망을 함께 돌린다.
#
#   bash deploy/autopush/install.sh          # 등록 + 즉시 1회 실행
#   bash deploy/autopush/install.sh remove
#   bash deploy/autopush/install.sh run      # 지금 한 번만 실행 (등록 없이)
#
# config/autopush.txt를 고쳤으면 다시 install 해야 감시 목록이 반영된다.
set -euo pipefail

LABEL="com.cykim.autopush"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$REPO/deploy/autopush/$LABEL.plist.template"
LIST="$REPO/config/autopush.txt"
TARGET="gui/$(id -u)"

# config/autopush.txt의 각 리포에 대해 감시할 파일 경로를 plist 조각으로 만든다.
# .git/logs/HEAD  — 커밋·체크아웃 등 HEAD 이동 (reflog)
# .git/refs/heads — 브랜치 ref 갱신 (reflog가 꺼져 있는 리포 대비)
watch_paths() {
  while IFS= read -r repo; do
    repo="${repo%%#*}"; repo="$(echo "$repo" | xargs)"
    [ -z "$repo" ] && continue
    [ -d "$repo/.git" ] || { echo "경고: .git 없음 — 감시 제외: $repo" >&2; continue; }
    printf '    <string>%s/.git/logs/HEAD</string>\n' "$repo"
    printf '    <string>%s/.git/refs/heads</string>\n' "$repo"
  done < "$LIST"
}

case "${1:-install}" in
  install)
    [ -f "$LIST" ] || { echo "config/autopush.txt 가 없습니다 (autopush.example.txt 복사 후 수정)"; exit 1; }
    paths="$(watch_paths)"
    [ -n "$paths" ] || { echo "감시할 리포가 없습니다 — config/autopush.txt를 확인하세요"; exit 1; }
    mkdir -p "$PLIST_DIR" "$REPO/deploy/launchd/logs"
    # __WATCHPATHS__ 줄을 생성한 목록으로 통째로 치환 (경로에 #이 없다고 가정하지 않도록 awk 사용)
    awk -v repo="$REPO" -v home="$HOME" -v paths="$paths" '
      /__WATCHPATHS__/ { print paths; next }
      { gsub(/__REPO__/, repo); gsub(/__HOME__/, home); print }
    ' "$TEMPLATE" > "$PLIST"
    chmod +x "$REPO/deploy/autopush/autopush.sh"
    launchctl bootout "$TARGET" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "$TARGET" "$PLIST"
    launchctl kickstart -k "$TARGET/$LABEL"
    echo "등록 완료: $PLIST"
    echo "커밋 감지: $(echo "$paths" | grep -c 'logs/HEAD')개 리포 · 안전망 5분 주기"
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
