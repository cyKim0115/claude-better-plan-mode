#!/bin/bash
# 워커 MCP + 보드 서버 제어 (macOS launchd 전용).
#
#   deploy/worker.sh              현재 상태
#   deploy/worker.sh start        기동
#   deploy/worker.sh stop         종료
#   deploy/worker.sh restart      재시작
#   deploy/worker.sh rebuild      npm run build 후 재시작
#   deploy/worker.sh logs [N]     로그 따라가기 (기본 50줄부터)
#
# LaunchAgent에 KeepAlive가 걸려 있어 kill로는 멈추지 않는다 (launchd가 다시 띄운다).
# 종료는 반드시 이 스크립트(launchctl bootout)를 쓴다.
# 등록 자체(plist 생성·삭제)는 deploy/launchd/install.sh 담당.
set -uo pipefail

LABEL="com.cykim.better-plan-worker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="gui/$(id -u)"
LOG="$REPO/deploy/launchd/logs/worker.err.log"

# 포트는 .env.local 값을 따른다 (시크릿이 아닌 포트 키만 읽는다).
env_port() {
  local v
  v=$(grep -m1 "^$1=" "$REPO/.env.local" 2>/dev/null | cut -d= -f2- | tr -d '"'\''[:space:]')
  echo "${v:-$2}"
}
BOARD_PORT="${PLANMODE_PORT:-$(env_port PLANMODE_PORT 3000)}"
WORKER_PORT="${WORKER_PORT:-$(env_port WORKER_PORT 4000)}"

CMD="${1:-status}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] || [ "$a" = "-f" ] && FORCE=1; done

loaded()    { launchctl print "$TARGET/$LABEL" >/dev/null 2>&1; }
port_pid()  { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
health()    { curl -s -m 3 "http://127.0.0.1:$WORKER_PORT/health" 2>/dev/null; }
board_code(){ curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BOARD_PORT/jobs" 2>/dev/null; }
busy_jobs() {
  curl -s -m 5 "http://127.0.0.1:$BOARD_PORT/api/jobs" 2>/dev/null \
    | grep -oE '"status":"(running|queued)"' | wc -l | tr -d ' '
}

wait_up() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    case "$(health)" in *'"ok":true'*'"board":true'*) return 0 ;; esac
    sleep 2
  done
  return 1
}

wait_down() {
  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ -z "$(port_pid "$WORKER_PORT")" ] && [ -z "$(port_pid "$BOARD_PORT")" ] && return 0
    sleep 1
  done
  return 1
}

# 진행 중·대기 중 잡이 있으면 멈춘다. 서버를 내리면 그 세션이 끊기기 때문.
guard_busy() {
  local n
  n=$(busy_jobs)
  if [ "${n:-0}" != "0" ]; then
    if [ "$FORCE" = "1" ]; then
      echo "경고: 진행 중·대기 중 잡 ${n}건 - --force 지정이라 그대로 진행합니다."
    else
      echo "진행 중이거나 대기 중인 잡이 ${n}건 있습니다. 지금 내리면 해당 세션이 끊깁니다."
      echo "  확인: http://127.0.0.1:$BOARD_PORT/jobs"
      echo "  그래도 진행: $0 $CMD --force"
      exit 1
    fi
  fi
}

status() {
  if loaded; then
    local st pid
    st=$(launchctl print "$TARGET/$LABEL" 2>/dev/null | awk -F' = ' '/^[[:space:]]*state = /{print $2; exit}')
    pid=$(launchctl print "$TARGET/$LABEL" 2>/dev/null | awk -F' = ' '/^[[:space:]]*pid = /{print $2; exit}')
    echo "launchd    : ${st:-unknown} (pid ${pid:-none})"
  elif [ -f "$PLIST" ]; then
    echo "launchd    : 내려감 (plist는 있음 - '$0 start'로 기동)"
  else
    echo "launchd    : 미등록 (bash deploy/launchd/install.sh 필요)"
  fi

  local wp bp h bc n
  wp=$(port_pid "$WORKER_PORT"); bp=$(port_pid "$BOARD_PORT")
  h=$(health);                   bc=$(board_code)
  echo "워커 MCP   : :$WORKER_PORT pid ${wp:-none} ${h:-무응답}"
  echo "보드       : :$BOARD_PORT pid ${bp:-none} HTTP ${bc:-000} /jobs"
  n=$(busy_jobs)
  echo "진행 중 잡 : ${n:-0}"
  echo "로그       : $LOG"
}

start() {
  if [ ! -f "$PLIST" ]; then
    echo "LaunchAgent가 등록돼 있지 않습니다. 먼저: bash deploy/launchd/install.sh"
    exit 1
  fi
  loaded || launchctl bootstrap "$TARGET" "$PLIST" 2>/dev/null
  launchctl kickstart "$TARGET/$LABEL" >/dev/null 2>&1
  if wait_up; then echo "기동 완료"; status; else
    echo "90초 내 응답 없음 - 로그 확인:"; tail -20 "$LOG"; exit 1
  fi
}

stop() {
  guard_busy
  if loaded; then
    launchctl bootout "$TARGET/$LABEL" 2>/dev/null || launchctl bootout "$TARGET" "$PLIST" 2>/dev/null
  fi
  if ! wait_down; then
    # 워커가 죽으면서 보드 자식이 남는 경우 정리
    for p in $(port_pid "$BOARD_PORT") $(port_pid "$WORKER_PORT"); do kill "$p" 2>/dev/null; done
    sleep 3
    for p in $(port_pid "$BOARD_PORT") $(port_pid "$WORKER_PORT"); do kill -9 "$p" 2>/dev/null; done
  fi
  if [ -z "$(port_pid "$WORKER_PORT")" ] && [ -z "$(port_pid "$BOARD_PORT")" ]; then
    echo "종료 완료 (다시 켜기: $0 start)"
  else
    echo "포트가 아직 열려 있습니다:"; status; exit 1
  fi
}

restart() {
  guard_busy
  if ! loaded; then start; return; fi
  launchctl kickstart -k "$TARGET/$LABEL" >/dev/null 2>&1
  if wait_up; then echo "재시작 완료"; status; else
    echo "90초 내 응답 없음 - 로그 확인:"; tail -20 "$LOG"; exit 1
  fi
}

# 빌드만 하고 재시작을 빼먹으면 옛 청크 이름이 박힌 HTML이 남아 브라우저가 ChunkLoadError로 죽는다.
rebuild() {
  guard_busy
  ( cd "$REPO" && npm run build ) || { echo "빌드 실패 - 서버는 그대로 둡니다"; exit 1; }
  restart
}

case "$CMD" in
  status|"")      status ;;
  start)          start ;;
  stop)           stop ;;
  restart)        restart ;;
  rebuild)        rebuild ;;
  logs)           tail -n "${2:-50}" -f "$LOG" ;;
  *) echo "usage: $0 [status|start|stop|restart|rebuild|logs [N]] [--force]"; exit 1 ;;
esac
