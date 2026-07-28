#!/usr/bin/env bash
# PostCompact hook: 「このセッションで圧縮が起きた」印ファイルを書くだけの薄い hook。
#
# PostCompact は文脈注入もブロックもできない（副作用専用）ため、印を残すことが唯一の
# 仕事。復旧指示の注入は compact-restore.sh（SessionStart[compact] が主経路、
# UserPromptSubmit が保険経路）がこの印を見て行う。
# あわせて context-weight-warn.py の debounce 状態を消し、圧縮後の再警告を許可する。
# 何が起きても exit 0。
set -uo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

MARK_DIR="$HOME/.claude/session-state/.marks"
mkdir -p "$MARK_DIR" 2>/dev/null || exit 0

input=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
sid=$(printf '%s' "$sid" | tr -cd 'a-zA-Z0-9-' | cut -c1-64)
[ -n "$sid" ] || exit 0

date '+%s' >"$MARK_DIR/$sid.compacted" 2>/dev/null

# 圧縮でコンテキストが縮むと context-weight-warn.py の「前回警告時サイズ」比較が
# 負のまま固定され再警告が死ぬため、状態ファイルを消してリセットする。
# （パスは context-weight-warn.py の state_path() と同一規約: gettempdir はどちらも
#   TMPDIR に従う。万一ズレても warn 側の ctx<last リセットが二重の保険になる）
rm -f "${TMPDIR:-/tmp}/ctxwarn-$sid.json" 2>/dev/null

printf '%s event=PostCompact sid=%s action=mark\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$sid" \
	>>"$HOME/.claude/session-state/.hook-events.log" 2>/dev/null

exit 0
