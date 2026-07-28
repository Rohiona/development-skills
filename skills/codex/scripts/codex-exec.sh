#!/usr/bin/env bash
# codex-exec.sh - Codex CLI wrapper for Claude Code skill
#
# Responsibilities:
#   - timeout 適用 (第1引数)
#   - stdout/stderr を tee でログに保存
#   - </dev/null で stdin を強制クローズ (Codex の固まり防止)
#   - session ID をログから抽出して末尾に明示
#   - codex の exit code を保持
#
# Usage:
#   codex-exec.sh <timeout_sec> <codex_subcommand> [args...]
#
# Examples:
#   codex-exec.sh 1200 exec -s read-only -C /repo -o /tmp/out.md "<prompt>"
#   codex-exec.sh 1200 exec resume <SESSION_ID> "<prompt>"
#   codex-exec.sh 1200 review --diff-target main

set -uo pipefail

if [ "$#" -lt 2 ]; then
	echo "Usage: $0 <timeout_sec> <codex_subcommand> [args...]" >&2
	echo "Example: $0 1200 exec -s read-only -C /repo \"<prompt>\"" >&2
	exit 64
fi

TIMEOUT_SEC="$1"
shift

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
	echo "ERROR: first argument must be timeout seconds (integer), got: $TIMEOUT_SEC" >&2
	exit 64
fi

LOG="/tmp/codex-$(date +%s)-$$.log"

timeout "$TIMEOUT_SEC" codex "$@" </dev/null 2>&1 | tee "$LOG"
EXIT="${PIPESTATUS[0]}"

SESSION_ID="$(grep -m1 -oE 'session id: [0-9a-f-]{36}' "$LOG" | awk '{print $3}')"

echo
echo "=== codex-exec.sh meta ==="
echo "exit: $EXIT"
echo "log: $LOG"
if [ -n "$SESSION_ID" ]; then
	echo "session_id: $SESSION_ID"
else
	echo "session_id: 取得失敗 (timeout / pattern unmatched / log truncated)"
fi

exit "$EXIT"
