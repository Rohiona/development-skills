#!/usr/bin/env bash
# SessionStart hook: auto-push the session's git worktree branch and set upstream
# when it has none. git provides no "worktree add" hook, so we compensate at session
# start: if the session is (or was) working in a LINKED worktree whose branch lacks an
# upstream, push it to origin in the background. Combined with the global
# push.autoSetupRemote=true, this creates origin/<same-name> and sets it as upstream,
# guaranteeing every worktree branch ends up pushed + tracked.
#
# Scope: all linked worktrees (not just .claude/worktrees). The PRIMARY worktree and
# the integration branches (develop/main/master) are never auto-pushed.
# Non-blocking: the push runs detached; this hook always exits 0 and never delays start.
set -uo pipefail

LOG="$HOME/.claude/handoff/.debug.log"
dbg(){ [ -f "$HOME/.claude/handoff/.debug" ] && printf '%s [wt-autopush] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG" 2>/dev/null; return 0; }

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

input=$(cat 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null)
sid=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
tpath=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0

# A linked worktree's git-dir lives under <repo>/.git/worktrees/<name>.
is_linked_wt(){
	local gd
	gd=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
	case "$gd" in */worktrees/*) return 0 ;; *) return 1 ;; esac
}

# Resolve candidate worktree: (1) cwd if it is itself a linked worktree,
# else (2) the most-recently-referenced .claude/worktrees path in the transcript.
wt=""
if is_linked_wt "$cwd"; then
	wt="$cwd"
else
	if [ -z "$tpath" ] || [ ! -f "$tpath" ]; then
		slug=$(printf '%s' "$cwd" | sed 's#/#-#g')
		tpath="$HOME/.claude/projects/$slug/$sid.jsonl"
	fi
	[ -f "$tpath" ] || { dbg "no transcript"; exit 0; }
	wt=$(grep -oE '/Users/[^"]*/\.claude/worktrees/[A-Za-z0-9._+-]+' "$tpath" 2>/dev/null | tail -1)
fi
[ -n "$wt" ] && [ -d "$wt" ] || { dbg "no worktree dir"; exit 0; }

# Must be a real, current worktree, and a linked one (never the primary tree).
git -C "$cwd" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $wt" || { dbg "not in worktree list: $wt"; exit 0; }
is_linked_wt "$wt" || { dbg "not linked: $wt"; exit 0; }

branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$branch" ] && [ "$branch" != "HEAD" ] || { dbg "detached HEAD"; exit 0; }
case "$branch" in develop | main | master) dbg "integration branch $branch; skip"; exit 0 ;; esac

# Need an origin remote.
git -C "$wt" remote get-url origin >/dev/null 2>&1 || { dbg "no origin remote"; exit 0; }

# Already tracked? nothing to do.
if git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
	dbg "upstream exists for $branch; skip"
	exit 0
fi

# Detached background push (no setsid on macOS): the subshell returns immediately and
# the grandchild is reparented, so session start is never blocked on the network.
dbg "auto-push $branch from $wt"
( git -C "$wt" push -u origin HEAD >>"$LOG" 2>&1 & ) >/dev/null 2>&1

ctx=$(printf '🔄 worktree ブランチ `%s`（%s）に upstream が無かったため、バックグラウンドで `git push -u origin HEAD` を開始しました（origin/%s を作成し追跡設定）。ネットワーク不通等で失敗していたら手動 push が必要です。' "$branch" "$wt" "$branch")
"$JQ" -nc --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}'
exit 0
