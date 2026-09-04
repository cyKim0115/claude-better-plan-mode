#!/bin/bash
# 지정한 리포들의 "커밋됐지만 아직 push되지 않은" 현재 브랜치를 Mac 자격증명(키체인)으로 push한다.
# 샌드박스·다른 환경에서 만든 커밋을 사람이 push 버튼을 누르지 않아도 원격에 올리는 용도.
#
# 규칙:
# - 현재 브랜치가 이미 upstream을 추적하고 있을 때만 push한다 (새 브랜치를 임의로 원격에 만들지 않는다).
# - rebase/merge 진행 중, index.lock 존재, detached HEAD면 건너뛴다.
# - 리포에 .git/autopush-off 파일이 있으면 건너뛴다 (일시 정지 스위치).
# - force push는 절대 하지 않는다. non-fast-forward면 로그만 남긴다.
#
# 대상 목록: config/autopush.txt (한 줄에 절대경로 하나, # 주석 허용). 예시는 autopush.example.txt
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIST="${AUTOPUSH_LIST:-$ROOT/config/autopush.txt}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

[ -f "$LIST" ] || { log "목록 없음: $LIST"; exit 0; }

while IFS= read -r repo; do
  repo="${repo%%#*}"; repo="$(echo "$repo" | xargs)"
  [ -z "$repo" ] && continue
  [ -d "$repo/.git" ] || { log "[$repo] .git 없음 — 건너뜀"; continue; }
  [ -f "$repo/.git/autopush-off" ] && continue
  [ -f "$repo/.git/index.lock" ] && { log "[$repo] index.lock 존재 — 다음 회차"; continue; }
  git_dir="$repo/.git"
  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] || [ -f "$git_dir/MERGE_HEAD" ]; then
    log "[$repo] rebase/merge 진행 중 — 건너뜀"; continue
  fi

  branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null)" || { continue; }
  upstream="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || {
    log "[$repo] $branch: upstream 없음 — 건너뜀 (git push -u 를 한 번 직접 하세요)"; continue; }

  ahead="$(git -C "$repo" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  [ "$ahead" -gt 0 ] || continue

  # 원격이 앞서 있으면(non-ff) 밀지 않는다 — 사람이 pull/rebase 해야 한다
  git -C "$repo" fetch --quiet origin "${upstream#origin/}" 2>/dev/null
  behind="$(git -C "$repo" rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
  if [ "$behind" -gt 0 ]; then
    log "[$repo] $branch: 원격이 ${behind}개 앞섬 — push 보류 (pull --rebase 필요)"; continue
  fi

  if out="$(git -C "$repo" push --quiet origin "HEAD:${upstream#origin/}" 2>&1)"; then
    log "[$repo] $branch: ${ahead}개 커밋 push 완료 → $upstream"
  else
    log "[$repo] $branch: push 실패 — $out"
  fi
done < "$LIST"
