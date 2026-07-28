#!/usr/bin/env bash
# cursor-exec.sh - Cursor agent CLI wrapper（codex-exec.sh と同系列）
#
# Responsibilities:
#   - 実行前スナップショット: tracked + untracked（.gitignore 対象外）を丸ごと
#     refs/cursor-snapshots/<ts> に退避（作業ツリー・index は一切触らない）
#   - timeout 適用 (第1引数)
#   - </dev/null で stdin を強制クローズ + stdout/stderr を tee でログ保存
#   - 実行後: スナップショットと比較して「消えたファイル」を即検知して警告し、
#     復元コマンドを提示（上書き事故の全損防止。2026-06-12 の実例対策の機械化）
#   - 古いスナップショット ref は直近 20 件だけ残して自動整理
#
# Usage:
#   cursor-exec.sh <timeout_sec> [cursor agent の引数...]
#
# Example:
#   cursor-exec.sh 1800 -p --trust --force --workspace=/path/to/worktree \
#     --model composer-2.5 --output-format text "<実装依頼プロンプト>"
#
# テスト用 env: CURSOR_EXEC_BIN（既定 "cursor"。スタブに差し替え可能）

set -uo pipefail

if [ "$#" -lt 2 ]; then
	echo "Usage: $0 <timeout_sec> [cursor agent args...]" >&2
	exit 64
fi

TIMEOUT_SEC="$1"
shift

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
	echo "ERROR: first argument must be timeout seconds (integer), got: $TIMEOUT_SEC" >&2
	exit 64
fi

CURSOR_BIN="${CURSOR_EXEC_BIN:-cursor}"

# --workspace=<dir> があればそこを、なければ cwd を対象リポジトリとする
WS="$PWD"
for a in "$@"; do
	case "$a" in
	--workspace=*) WS="${a#--workspace=}" ;;
	esac
done

if ! git -C "$WS" rev-parse --git-dir >/dev/null 2>&1; then
	echo "ERROR: not a git repository: $WS （スナップショットが取れないため中止）" >&2
	exit 65
fi

# --- 実行前スナップショット（作業ツリー・実 index 無変更） ---
TMPIDX="$(mktemp -t cursor-exec-index.XXXXXX)"
rm -f "$TMPIDX" # git に新規作成させる
SNAP_REF=""
HEAD_SHA="$(git -C "$WS" rev-parse HEAD)"
if GIT_INDEX_FILE="$TMPIDX" git -C "$WS" read-tree HEAD &&
	GIT_INDEX_FILE="$TMPIDX" git -C "$WS" add -A &&
	TREE="$(GIT_INDEX_FILE="$TMPIDX" git -C "$WS" write-tree)"; then
	SNAP_SHA="$(git -C "$WS" commit-tree "$TREE" -p "$HEAD_SHA" -m "cursor-exec snapshot before delegation ($(date -u +%FT%TZ))")"
	SNAP_REF="refs/cursor-snapshots/$(date +%Y%m%d-%H%M%S)-$$"
	git -C "$WS" update-ref "$SNAP_REF" "$SNAP_SHA"
fi
rm -f "$TMPIDX"

if [ -z "$SNAP_REF" ]; then
	echo "ERROR: スナップショット作成に失敗（委譲を中止。作業成果を守れないため fail-closed）" >&2
	exit 66
fi

# --- Cursor 実行 ---
LOG="/tmp/cursor-exec-$(date +%s)-$$.log"
timeout "$TIMEOUT_SEC" "$CURSOR_BIN" agent "$@" </dev/null 2>&1 | tee "$LOG"
EXIT="${PIPESTATUS[0]}"

# --- 実行後: 消えたファイルの即検知 ---
# スナップショットにあって作業ツリーに無いファイル（= 委譲中に消えたもの）
MISSING="$(git -C "$WS" diff --name-only --diff-filter=D "$SNAP_REF" 2>/dev/null)"

echo
echo "=== cursor-exec.sh meta ==="
echo "exit: $EXIT"
[ "$EXIT" -eq 124 ] && echo "note: exit 124 = timeout（${TIMEOUT_SEC}s 超過で強制終了）"
echo "log: $LOG"
echo "snapshot: $SNAP_REF (repo: $WS)"
if [ -n "$MISSING" ]; then
	echo
	echo "⚠️  警告: 委譲前に存在したファイルが消えています（上書き/削除事故の疑い）:"
	echo "$MISSING" | sed 's/^/  - /'
	echo "復元するには: git -C \"$WS\" checkout $SNAP_REF -- <path>"
else
	echo "missing-files: なし（委譲前のファイルは全て生存）"
fi
echo "変更サマリ: $(git -C "$WS" diff --shortstat "$SNAP_REF" 2>/dev/null || echo '取得失敗')"

# --- 古いスナップショットの整理（直近 20 件を保持） ---
git -C "$WS" for-each-ref --sort=-refname --format='%(refname)' refs/cursor-snapshots |
	tail -n +21 |
	while read -r r; do git -C "$WS" update-ref -d "$r"; done

exit "$EXIT"
