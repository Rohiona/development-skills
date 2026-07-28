#!/usr/bin/env bash
# cursor-delegation-enforce の例外スイッチ。
# やむを得ない場合（トークン枯渇・Cursor 起動不可・障害・timeout）のみ、
# 指定分数だけ Serena/Edit によるコード編集を解禁する。
#
# 使い方:
#   bash ~/.claude/hooks/cursor-delegation-fallback.sh        # 既定 30 分解禁
#   bash ~/.claude/hooks/cursor-delegation-fallback.sh 60     # 60 分解禁
#   bash ~/.claude/hooks/cursor-delegation-fallback.sh off    # 即時解除
set -euo pipefail

MARKER="$HOME/.claude/.cursor-delegation-fallback"

if [[ "${1:-}" == "off" ]]; then
	rm -f "$MARKER"
	echo "[cursor-delegation-enforce] 例外スイッチを解除しました。コード編集は再びブロックされます。"
	exit 0
fi

MINUTES="${1:-30}"
if ! [[ "$MINUTES" =~ ^[0-9]+$ ]] || [[ "$MINUTES" -eq 0 ]]; then
	echo "使い方: cursor-delegation-fallback.sh [分数>=1 | off]" >&2
	exit 1
fi

NOW="$(date +%s)"
EXPIRY=$(( NOW + MINUTES * 60 ))
printf '%s\n' "$EXPIRY" > "$MARKER"
echo "[cursor-delegation-enforce] Serena/Edit を ${MINUTES} 分間解禁しました（失効: $(date -r "$EXPIRY" '+%H:%M:%S')）。"
