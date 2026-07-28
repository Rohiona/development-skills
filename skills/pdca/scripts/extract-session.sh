#!/usr/bin/env bash
# PDCA: 現在のプロジェクトのセッション transcript(JSONL) から「失敗シグナル」を抽出する。
#
# 出力は短い digest（人間の発話 + ツールエラー）。判断・改善案の提示は Claude 側が行う。
#
# Usage:
#   extract-session.sh [session-id]
#     session-id 省略時はプロジェクト transcript dir の最新 .jsonl を使う。
#
# 注意: このスクリプトは「素材を出す」だけ。書き換えや GitHub 登録はしない。
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Claude Code は transcript dir 名を「絶対パスの / と . を - に置換」して付ける。
ENCODED=$(printf '%s' "$PROJECT_DIR" | sed 's/[/.]/-/g')
TRANSCRIPT_DIR="$HOME/.claude/projects/$ENCODED"

if [ ! -d "$TRANSCRIPT_DIR" ]; then
	echo "ERROR: transcript dir not found: $TRANSCRIPT_DIR" >&2
	echo "HINT: CLAUDE_PROJECT_DIR=$PROJECT_DIR から導出。cwd がプロジェクトルートか確認してください。" >&2
	exit 1
fi

# 実質的な人間発話（isMeta=true やシステム注入 <...> を除く）の件数を数える。
# grep は profile 関数で上書きされうるため使わず wc -l で数える（shell-robustness）。
count_human_turns() {
	{ jq -rc '
		select(.type=="user" and (.isMeta != true))
		| (if (.message.content|type)=="string" then [.message.content]
		   else [.message.content[]? | select(.type=="text") | .text] end)
		| .[] | select(. != null) | select(startswith("<")|not)
	' "$1" 2>/dev/null || true; } | wc -l | tr -d ' '
}

SESSION_ID="${1:-}"
SELECT_NOTE=""
if [ -n "$SESSION_ID" ]; then
	# 明示指定時はスキャンしない（指定を尊重）。
	# まず完全一致。無ければ prefix 一致（部分 id）で一意に解決できれば採用する
	# （フル session-id を毎回コピペせずに済むように）。
	if [ -f "$TRANSCRIPT_DIR/$SESSION_ID.jsonl" ]; then
		JSONL="$TRANSCRIPT_DIR/$SESSION_ID.jsonl"
		SELECT_NOTE="明示指定 session-id を使用（完全一致・スキャンなし）"
	else
		PREFIX_MATCHES=()
		for CAND in "$TRANSCRIPT_DIR/$SESSION_ID"*.jsonl; do
			if [ -f "$CAND" ]; then PREFIX_MATCHES+=("$CAND"); fi
		done
		if [ "${#PREFIX_MATCHES[@]}" -eq 1 ]; then
			JSONL="${PREFIX_MATCHES[0]}"
			SELECT_NOTE="明示指定 session-id の prefix 一致で一意解決（$(basename "$JSONL")）"
		elif [ "${#PREFIX_MATCHES[@]}" -gt 1 ]; then
			echo "ERROR: session-id '$SESSION_ID' は複数の transcript に前方一致します:" >&2
			for M in "${PREFIX_MATCHES[@]}"; do echo "  - $(basename "$M")" >&2; done
			echo "HINT: より長い session-id を指定して一意にしてください。" >&2
			exit 1
		else
			# 一致なし → 後段の not found 判定へ落とす。
			JSONL="$TRANSCRIPT_DIR/$SESSION_ID.jsonl"
			SELECT_NOTE="明示指定 session-id を使用（スキャンなし）"
		fi
	fi
else
	# 「現セッション = 最新 mtime」とは限らない（subagent / monitor / 並行セッションの
	# jsonl が後で更新されうる）。最新 mtime を盲信せず、mtime 降順に走査して
	# 「実質的な人間発話が 1 件以上ある最初のセッション」を選ぶ。
	# そのうえで「どれを・なぜ選んだか」を必ず digest に明示し、取り違えを可視化する（最小案）。
	JSONL=""
	SKIPPED_EMPTY=0
	NEWEST=""
	while IFS= read -r CAND; do
		[ -z "$CAND" ] && continue
		[ -f "$CAND" ] || continue
		[ -z "$NEWEST" ] && NEWEST="$CAND"
		if [ "$(count_human_turns "$CAND")" -gt 0 ]; then
			JSONL="$CAND"
			break
		fi
		SKIPPED_EMPTY=$((SKIPPED_EMPTY + 1))
	done <<EOF
$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null || true)
EOF
	if [ -z "${JSONL:-}" ]; then
		# 全セッションが実質空（通常は起こらない）。最新 mtime に素直に従う。
		JSONL="$NEWEST"
		SELECT_NOTE="実質的人間発話のあるセッションが見つからず最新 mtime を使用"
	elif [ "$JSONL" = "$NEWEST" ]; then
		SELECT_NOTE="最新 mtime のセッションを使用（実質的人間発話あり）"
	else
		SELECT_NOTE="最新 mtime は実質空のためスキップし、mtime 降順で最初に人間発話のあるセッションを使用（実質空を ${SKIPPED_EMPTY} 件スキップ。最新だった: $(basename "$NEWEST")）"
	fi
fi

if [ -z "${JSONL:-}" ] || [ ! -f "$JSONL" ]; then
	echo "ERROR: transcript jsonl not found in $TRANSCRIPT_DIR" >&2
	exit 1
fi

echo "# PDCA session digest"
echo "transcript: $JSONL"
echo "selected: $SELECT_NOTE"
echo "lines: $(wc -l < "$JSONL" | tr -d ' ')"
echo

echo "## Human turns（修正指示・繰り返し・不満はここに出る）"
# isMeta==true はスキル起動時の注入など「人間が打っていない」turn。除外する。
jq -rc '
	select(.type=="user" and (.isMeta != true))
	| .timestamp as $ts
	| (if (.message.content|type)=="string" then [.message.content]
	   else [.message.content[]? | select(.type=="text") | .text] end)
	| .[]
	| select(. != null)
	| select(startswith("<")|not)
	| "- [\($ts)] " + (gsub("\n";" ") | .[0:300])
' "$JSONL" 2>/dev/null || true
echo

echo "## Tool errors / rejections（拒否・失敗の痕跡）"
jq -rc '
	select(.type=="user" and (.message.content|type=="array"))
	| .timestamp as $ts
	| .message.content[]
	| select(.type=="tool_result" and (.is_error==true))
	| ((.content) | if type=="string" then . else ([.[]?|.text//empty]|join(" ")) end) as $txt
	| "- [\($ts)] " + ($txt | gsub("\n";" ") | .[0:300])
' "$JSONL" 2>/dev/null || true
echo

echo "## End of digest"
