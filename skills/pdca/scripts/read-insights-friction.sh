#!/usr/bin/env bash
# PDCA: /insights が生成した永続ファイル（facets / report）から「横断 friction」を抽出し、
# あわせて鮮度（前回 insights 以降の未分析セッション数）を報告する。
#
# 重要: このスクリプトは insights 自体を起動しない（スキル/エージェントからは起動不可。検証済み）。
#        あくまで「過去に /insights が生成したキャッシュを読むだけ」。最新化はユーザーの /insights 実行が必要。
#
# Usage: read-insights-friction.sh
set -euo pipefail

USAGE_DIR="$HOME/.claude/usage-data"
FACETS="$USAGE_DIR/facets"

echo "# insights 横断 friction digest"

if [ ! -d "$FACETS" ]; then
	echo "status: NO_DATA"
	echo "HINT: insights データ未生成。一度 /insights を実行してください（このスクリプトからは起動できません）。"
	exit 0
fi

# --- 鮮度チェック（前回 insights 以降に溜まった未分析セッション数） ---
REPORT=$(ls -t "$USAGE_DIR"/report-*.html 2>/dev/null | head -1 || true)
if [ -n "${REPORT:-}" ]; then
	echo "last_insights: $(stat -f '%Sm' "$REPORT" 2>/dev/null || stat -c '%y' "$REPORT")"
	NEWER=$(find "$HOME/.claude/projects" -name "*.jsonl" -newer "$REPORT" 2>/dev/null | wc -l | tr -d ' ')
	echo "stale_sessions_since: ${NEWER}"
	echo "# ↑ この数だけ未分析。多いなら /pdca 内でユーザーに /insights 実行を訴求すること。"
else
	echo "last_insights: (report なし)"
fi
echo ""

# --- friction 抽出: facets を1件ずつ読み、friction あり/未達成のものだけ出す ---
echo "## friction を含むセッション（outcome != fully_achieved もしくは friction_counts あり）"
COUNT=0
for f in "$FACETS"/*.json; do
	line=$(jq -rc '
		{ outcome: (.outcome // "?"),
		  friction: ((.friction_counts // {}) | to_entries | map("\(.key)=\(.value)") | join(",")),
		  detail: (.friction_detail // ""),
		  goal: ((.brief_summary // .underlying_goal // "") | gsub("\n";" ")) }
		| select(.outcome != "unclear_from_transcript")
		| select((.friction != "") or (.outcome == "not_achieved") or (.outcome == "partially_achieved"))
		| "- [\(.outcome)] {\(.friction)}\n    goal: \(.goal[0:140])\n    friction: \(.detail | gsub("\n";" ") | .[0:240])"
	' "$f" 2>/dev/null || true)
	if [ -n "$line" ]; then
		echo "$line"
		COUNT=$((COUNT + 1))
	fi
done
echo ""
echo "## friction セッション数: ${COUNT}"
echo "## End of insights friction digest"
