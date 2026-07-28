#!/usr/bin/env bash
# 現在の Claude Code セッション ID を推定して stdout に出す（compact-save skill 用）。
#
# 方式: cwd に対応する ~/.claude/projects/<slug>/ 直下で最終更新が最も新しい *.jsonl の
# ファイル名（= session_id）を返す。skill（モデル側）には hook と違い session_id が
# 渡らないため、この推定が唯一の経路。
#
# Hard gate（呼び出し側との契約）:
# - 取得できない/鮮度が古い/UUID 形式でない → 何も出力せず exit 1。
#   呼び出し側（compact-save skill）は exit 1 のとき推測名でファイルを作らず停止する。
# - 並行セッション（同一 cwd 複数窓）では「直近に更新された方」を現行とみなす。
#   この skill は直前のユーザー発話の直後に呼ばれるため、自セッションの transcript が
#   ほぼ確実に最新更新になる（触っていない並行セッションが直後に書き込む競合は許容）。
#
# 使い方:
#   get-session-id.sh                     … 最新 jsonl 方式のみ
#   get-session-id.sh --verify "<文字列>" … 候補 jsonl の末尾に <文字列>（直近の
#       ユーザー発話の一部など）が含まれることまで確認する。並行セッションが同一
#       cwd で動いている疑いがあるときの誤爆防止（含まれなければ次点候補→全滅で exit 1）。
set -uo pipefail

MAX_AGE_SECONDS=${GET_SESSION_ID_MAX_AGE:-300}

verify_needle=""
if [ "${1:-}" = "--verify" ]; then
	verify_needle="${2:-}"
fi

cwd=$(pwd)
slug=$(printf '%s' "$cwd" | sed 's#/#-#g')
dir="$HOME/.claude/projects/$slug"
[ -d "$dir" ] || exit 1

now=$(date +%s)

# mtime 降順の候補一覧（"<mtime> <path>" 形式）
candidates=$(
	for f in "$dir"/*.jsonl; do
		[ -f "$f" ] || continue
		m=$(stat -f '%m' "$f" 2>/dev/null) || continue
		printf '%s %s\n' "$m" "$f"
	done | sort -rn
)
[ -n "$candidates" ] || exit 1

while IFS=' ' read -r m f; do
	[ -n "$f" ] || continue
	# 鮮度: 現行セッションは直近のユーザー発話で必ず更新されているはず
	[ $((now - m)) -le "$MAX_AGE_SECONDS" ] || break # 降順なので以降は全部古い
	# 自己照合（任意）: 直近発話の一部が末尾付近に居るか。
	# 注意: grep -q は早期終了で tail に SIGPIPE を送り、pipefail 下では一致して
	# いてもパイプ全体が失敗になる。全入力を読み切る -c で数える方式にすること。
	if [ -n "$verify_needle" ]; then
		hits=$(tail -c 400000 "$f" 2>/dev/null | command grep -Fac "$verify_needle" || true)
		[ "${hits:-0}" -gt 0 ] 2>/dev/null || continue
	fi
	sid=$(basename "$f")
	sid="${sid%.jsonl}"
	case "$sid" in
		*[!0-9a-fA-F-]* | "") continue ;;
	esac
	printf '%s\n' "$sid"
	exit 0
done <<<"$candidates"

exit 1
