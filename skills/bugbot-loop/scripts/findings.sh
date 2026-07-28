#!/usr/bin/env bash
# 指定ラウンドの Bugbot インライン指摘を抽出する。
# Bugbot は「サマリ=レビュー(pulls/{n}/reviews)」「個別指摘=インラインコメント(pulls/{n}/comments)」
# に分けて投稿する。本スクリプトは後者を新規ラウンド分だけ取り出す。
#
# 使い方: findings.sh <PR番号> <since(UTC ISO)> [owner/name]
#   since には「直前に run.sh を打った時刻(UTC)」や「watch.sh が emit した submitted_at」を渡す。
#
# 出力(1指摘ごと): 機械処理しやすいよう区切り付きで id / path / line / タイトル / 本文要約 を表示。

set -uo pipefail
HERE="$(command dirname "$0")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PR="${1:?usage: findings.sh <PR番号> <since(UTC ISO)> [owner/name]}"
SINCE="${2:?since(UTC ISO) が必要です（例: 2026-06-09T03:55:38Z）}"
REPO="$(resolve_repo "${3:-}")"

gh api --paginate "repos/$REPO/pulls/$PR/comments?per_page=100" \
	--jq '.[] | select(.user.login=="cursor[bot]" and .created_at >= "'"$SINCE"'")
	      | "==== id=\(.id) | \(.path):\(.original_line // .line)\n"
	        + ((.body | capture("### (?<t>[^\n]*)").t) // "(no title)") + "\n"
	        + ((.body | gsub("<!--.*?-->";"") | split("<div>")[0] | split("<details>")[0]) | gsub("\n\n+";"\n"))'
