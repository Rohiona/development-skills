#!/usr/bin/env bash
# Bugbot の新規レビューを 45 秒間隔で監視し、検知したら1行で emit する。
# Monitor ツール（persistent: true）の command として使うことを想定。
# 使い方: watch.sh <PR番号> [owner/name] [間隔秒=45] [since(UTC ISO)]
#
# 出力(1レビュー=1行): "NEW Bugbot review | <submitted_at> | commit <sha7> | <verdict>"
#   verdict は LGTM / FINDINGS(found N ...) / UNKNOWN(inline等)。
# LGTM を検知したら "==> LGTM <commit>" を最後に出して exit 0（ループ停止条件）。
#
# 設計上の注意:
# - since は未指定なら起動時刻(UTC)。★JSTの壁時計を渡さないこと（未来時刻=空振り）。
# - 判定はレビュー本文に対象コミットSHAが入る前提を使う（時刻ズレに強い）。
# - seen ファイルで重複 emit を防ぐ。
# - gh 失敗(レート制限等)は握りつぶしてループ継続（|| true）。

set -uo pipefail
HERE="$(command dirname "$0")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PR="${1:?usage: watch.sh <PR番号> [owner/name] [間隔秒] [since]}"
REPO="$(resolve_repo "${2:-}")"
INTERVAL="${3:-45}"
SINCE="${4:-$(now_utc)}"
SEEN="$(command mktemp "/tmp/bugbot-seen-${PR}.XXXXXX")"

echo "watching Bugbot reviews on PR #$PR ($REPO) since $SINCE every ${INTERVAL}s"

while true; do
	gh api --paginate "repos/$REPO/pulls/$PR/reviews?per_page=100" \
		--jq '.[] | select(.user.login=="cursor[bot]" and .submitted_at > "'"$SINCE"'")
		      | [.id, .submitted_at, ((.body | capture("for commit (?<c>[0-9a-f]{7})").c) // "?"), (.body // "")] | @tsv' \
		2>/dev/null \
	| while IFS=$'\t' read -r id ts commit body; do
		[ -z "$id" ] && continue
		if ! command grep -qxF "$id" "$SEEN" 2>/dev/null; then
			echo "$id" >> "$SEEN"
			verdict="$(printf '%s' "$body" | classify_verdict)"
			echo "NEW Bugbot review | $ts | commit $commit | $verdict"
			case "$verdict" in
				LGTM*) echo "==> LGTM $commit"; exit 42 ;;
			esac
		fi
	done
	# 内側 while の exit 42 をループ全体の終了に伝播させる
	[ "${PIPESTATUS[*]: -1}" = "42" ] && exit 0
	command sleep "$INTERVAL"
done
