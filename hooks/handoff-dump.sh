#!/usr/bin/env bash
# SessionEnd hook: dump the ending session's transcript into a per-session
# handoff markdown so a later session (after /clear) can pick it up.
# - No `claude` invocation (zero token cost / no API billing).
# - Filename is the session_id => parallel sessions never clobber each other.
# Always exits 0 so a failure here never blocks /clear or exit.
set -uo pipefail

dbg(){ [ -f "$HOME/.claude/handoff/.debug" ] && printf '%s [dump] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$HOME/.claude/handoff/.debug.log" 2>/dev/null; return 0; }

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

# Read hook stdin JSON
input=$(cat 2>/dev/null) || exit 0
session_id=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
transcript=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null)
reason=$(printf '%s' "$input" | "$JQ" -r '.reason // "unknown"' 2>/dev/null)

[ -n "$session_id" ] || exit 0
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
[ -n "$cwd" ] || cwd="unknown"

# --- WHERE did the work happen: git branch / worktree / PR ------------------
# Recording this is mandatory: after /clear + restart, the next session must
# know the exact branch & worktree, or it drifts onto develop/main and does
# the wrong thing (the recurring failure this section exists to prevent).
GIT=/opt/homebrew/bin/git;      [ -x "$GIT" ]     || GIT=$(command -v git)        || GIT=""
GH=/opt/homebrew/bin/gh;        [ -x "$GH" ]      || GH=$(command -v gh)          || GH=""
TIMEOUT=/opt/homebrew/bin/timeout; [ -x "$TIMEOUT" ] || TIMEOUT=$(command -v timeout) || TIMEOUT=$(command -v gtimeout) || TIMEOUT=""

branch="" ; worktree="" ; is_linked_worktree="" ; pr_url=""
if [ -n "$GIT" ] && [ "$cwd" != "unknown" ] && "$GIT" -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	branch=$("$GIT" -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
	worktree=$("$GIT" -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
	# A linked worktree's git-dir lives under <common>/worktrees/<name>.
	gitdir=$("$GIT" -C "$cwd" rev-parse --git-dir 2>/dev/null)
	case "$gitdir" in */worktrees/*) is_linked_worktree="yes" ;; *) is_linked_worktree="no" ;; esac
	# PR for this branch — best-effort, hard 5s cap so SessionEnd never hangs.
	if [ -n "$GH" ] && [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
		if [ -n "$TIMEOUT" ]; then
			pr_url=$("$TIMEOUT" 5 "$GH" pr view "$branch" --json url --jq '.url' 2>/dev/null)
		else
			pr_url=$("$GH" pr view "$branch" --json url --jq '.url' 2>/dev/null)
		fi
	fi
fi

# --- In-progress autonomous-dev run? -----------------------------------------
# autonomous-dev keeps its run state on disk (design_doc/{feature}/autodev/{run}/
# state.json). If the most-recently-touched run under this cwd was updated
# recently (within 24h) AND is not at a terminal phase, surface it so the next
# session knows a flow is mid-execution and how to resume it. Detection is
# best-effort, scoped to autonomous-dev only, and never blocks SessionEnd.
autodev_section="" ; ad_feature="" ; ad_run="" ; ad_phase="" ; ad_stopped="" ; ad_appr="" ; ad_gates="" ; ad_run_dir="" ; ad_esc=""
if [ "$cwd" != "unknown" ] && [ -d "$cwd/design_doc" ]; then
	# Newest state.json modified in the last 24h (1440 min). BSD stat (darwin).
	state_file=$(find "$cwd/design_doc" -type f -path '*/autodev/*/state.json' -mmin -1440 -print0 2>/dev/null \
		| xargs -0 stat -f '%m %N' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
	if [ -n "$state_file" ] && [ -f "$state_file" ]; then
		ad_phase=$("$JQ" -r '.phase // "?"' "$state_file" 2>/dev/null)
		ad_stopped=$("$JQ" -r '.stopped // false' "$state_file" 2>/dev/null)
		# Terminal = reached the pr phase and not waiting on a human. Anything
		# else that was touched recently counts as still in progress.
		if ! { [ "$ad_phase" = "pr" ] && [ "$ad_stopped" = "false" ]; }; then
			ad_feature=$("$JQ" -r '.feature // "?"' "$state_file" 2>/dev/null)
			ad_run=$("$JQ" -r '.run_id // "?"' "$state_file" 2>/dev/null)
			ad_appr=$("$JQ" -r '(.approvals // {}) | to_entries | map("\(.key)=\(.value)") | join(", ")' "$state_file" 2>/dev/null)
			[ -n "$ad_appr" ] || ad_appr="なし"
			ad_gates=$("$JQ" -r '(.gates // {}) | to_entries | map("\(.key)=\(if .value.green then "green" else "red(\(.value.errors // "?"))" end)") | join(", ")' "$state_file" 2>/dev/null)
			[ -n "$ad_gates" ] || ad_gates="未記録"
			ad_run_dir=$(dirname "$state_file")
			if [ "$ad_stopped" = "true" ] && [ -f "$ad_run_dir/escalations.jsonl" ]; then
				ad_esc=$(tail -n1 "$ad_run_dir/escalations.jsonl" 2>/dev/null | "$JQ" -r '.reason // empty' 2>/dev/null)
			fi
			autodev_section="yes"
		fi
	fi
fi

# cwd -> slug (mirror Claude's project-dir encoding: '/' -> '-')
slug=$(printf '%s' "$cwd" | sed 's#/#-#g')
outdir="$HOME/.claude/handoff/$slug"
mkdir -p "$outdir" 2>/dev/null || exit 0
out="$outdir/$session_id.md"

# Extract real user prompts + assistant text (drop tool noise, thinking,
# meta/hook-injected records, sidechains, and system-reminder blocks).
body=$("$JQ" -rs '
  [ .[]
    | select(.type=="user" or .type=="assistant")
    | select(.isMeta != true)
    | select(.isSidechain != true)
    | select(has("toolUseResult") | not)
    | if .type=="user" then
        ( .message.content
          | if type=="string" then .
            else ([.[]? | select(.type=="text") | .text] | join("\n")) end )
        | gsub("<system-reminder>.*?</system-reminder>"; ""; "s")
        | gsub("<command-[a-z-]+>.*?</command-[a-z-]+>"; ""; "s")
        | sub("^\\s+"; "") | sub("\\s+$"; "")
        | select(. != "")
        | select(startswith("Stop hook feedback") | not)
        | select(startswith("Caveat:") | not)
        | "### 👤 User\n\n\(.)"
      else
        ( [ .message.content[]? | select(.type=="text") | .text ] | join("\n\n") )
        | sub("^\\s+"; "") | sub("\\s+$"; "")
        | select(. != "")
        | "### 🤖 Assistant\n\n\(.)"
      end
  ] | join("\n\n")
' "$transcript" 2>/dev/null)

[ -n "$body" ] || exit 0

ended=$(date '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null)
{
  printf '# Handoff — session %s\n\n' "$session_id"
  printf -- '## どこで（作業場所・必ず最初に確認）\n\n'
  printf -- '- branch: `%s`\n' "${branch:-unknown}"
  if [ "$is_linked_worktree" = "yes" ]; then
    printf -- '- worktree: `%s` ⚠️ **linked worktree。続きは必ずこの worktree とブランチで行うこと。develop / main や別ツリーへ移って作業しない**\n' "$worktree"
  elif [ -n "$worktree" ]; then
    printf -- '- worktree: `%s`（メインの作業ツリー）\n' "$worktree"
  fi
  if [ -n "$pr_url" ]; then
    printf -- '- PR: %s\n' "$pr_url"
  else
    printf -- '- PR: なし（未作成）または取得不可\n'
  fi
  printf -- '- cwd: `%s`\n' "$cwd"
  printf -- '- ended: %s (reason: %s)\n' "$ended" "$reason"
  printf -- '- transcript: `%s`\n\n' "$transcript"
  if [ "$autodev_section" = "yes" ]; then
    printf -- '## 実行中のフロー（autonomous-dev・要確認）\n\n'
    printf -- '- 機能: `%s` / run: `%s`\n' "$ad_feature" "$ad_run"
    if [ "$ad_stopped" = "true" ]; then
      printf -- '- 現フェーズ: `%s` ⚠️ **stopped:true＝人間の応答待ちで中断中**\n' "$ad_phase"
    else
      printf -- '- 現フェーズ: `%s`（自走中・終端 pr 未到達）\n' "$ad_phase"
    fi
    printf -- '- 承認: %s\n' "$ad_appr"
    printf -- '- ゲート: %s\n' "$ad_gates"
    [ -n "$ad_esc" ] && printf -- '- 最新エスカレーション: %s\n' "$ad_esc"
    printf -- '- run_dir: `%s`\n' "$ad_run_dir"
    printf -- '- 再開: `bash ~/.claude/skills/autonomous-dev/scripts/bucket.sh read %s` で現在地を確認し、autonomous-dev の `references/pipeline.md` に従って続行（stopped:true なら最新 escalation を AskUserQuestion → `bucket.sh answer` で回答を書き戻して再開）\n\n' "$ad_run_dir"
  fi
  printf -- '---\n\n'
  printf '%s\n' "$body"
} > "$out" 2>/dev/null
dbg "wrote $out (reason=$reason)"

# Prune handoffs older than 14 days for this cwd (cheap housekeeping)
find "$outdir" -maxdepth 1 -name '*.md' -type f -mtime +14 -delete 2>/dev/null

exit 0
