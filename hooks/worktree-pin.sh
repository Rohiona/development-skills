#!/usr/bin/env bash
# SessionStart hook: detect the git worktree this session has been working in
# (by scanning the transcript for .claude/worktrees/<name> references) and
# surface it as additionalContext. On session resume the Bash cwd resets to the
# primary working directory (main repo), which silently desyncs Claude's shell
# from the worktree that Codex/Cursor/Serena were pointed at. This hook makes the
# canonical work dir explicit so the assistant re-cd's there and passes the SAME
# absolute path to every delegation. Hard-codes nothing; auto-detects per session.
# Always exits 0 (never blocks a session from starting).
set -uo pipefail

dbg(){ [ -f "$HOME/.claude/handoff/.debug" ] && printf '%s [wt-pin] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$HOME/.claude/handoff/.debug.log" 2>/dev/null; return 0; }

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

input=$(cat 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null)
sid=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
tpath=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0

# Locate the transcript: prefer the path the harness gives us; else construct it
# from the project slug + session_id (~/.claude/projects/<slug>/<sid>.jsonl).
if [ -z "$tpath" ] || [ ! -f "$tpath" ]; then
	slug=$(printf '%s' "$cwd" | sed 's#/#-#g')
	tpath="$HOME/.claude/projects/$slug/$sid.jsonl"
fi
[ -f "$tpath" ] || { dbg "no transcript ($tpath)"; exit 0; }

# Most-recently-referenced worktree path in the transcript.
wt=$(grep -oE '/Users/[^"]*/\.claude/worktrees/[A-Za-z0-9._-]+' "$tpath" 2>/dev/null | tail -1)
[ -n "$wt" ] || { dbg "no worktree referenced"; exit 0; }

# Validate it is a real, current worktree (not a removed one) and exists on disk.
[ -d "$wt" ] || { dbg "worktree dir missing: $wt"; exit 0; }
if ! git -C "$cwd" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $wt"; then
	dbg "not in worktree list: $wt"
	exit 0
fi

# If the session is already inside this worktree, nothing to surface.
[ "$cwd" = "$wt" ] && { dbg "cwd already = worktree"; exit 0; }

branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)

ctx=$(printf '⚠️ このセッションの作業 worktree: %s（ブランチ %s）。\nセッション再開で Bash cwd が本体リポ(%s)に戻っています。Bash/git/ファイル操作の前にまず `cd %s` してこの worktree に揃えること。\nCodex/Cursor/Serena への委譲も必ずこの絶対パスを渡し、Claude・Codex・Cursor の3者が同一ディレクトリを見る状態にすること。\nこのセッションが worktree と無関係な作業に切り替わったなら無視してよい。' "$wt" "${branch:-?}" "$cwd" "$wt")

dbg "INJECT worktree=$wt branch=$branch"
"$JQ" -nc --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}'
exit 0
