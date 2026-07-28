#!/usr/bin/env bash
# Bugbot のインライン指摘スレッドに返信する。
# 使い方:
#   reply.sh <PR番号> <comment_id> <本文>            # 本文を引数で
#   reply.sh <PR番号> <comment_id> -                 # 本文を標準入力から（長文・改行向け）
#   [owner/name は環境変数 BUGBOT_REPO で上書き可]
# 副作用: PR のレビューコメントスレッドに返信を1件投稿する。

set -uo pipefail
HERE="$(command dirname "$0")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PR="${1:?usage: reply.sh <PR番号> <comment_id> <本文|->}"
CID="${2:?comment_id が必要です（findings.sh の id=... を使う）}"
BODY_ARG="${3:?本文（または - で標準入力）が必要です}"
REPO="$(resolve_repo "${BUGBOT_REPO:-}")"

if [ "$BODY_ARG" = "-" ]; then
	BODY="$(command cat)"
else
	BODY="$BODY_ARG"
fi

gh api -X POST "repos/$REPO/pulls/$PR/comments/$CID/replies" -f body="$BODY" --jq '.html_url'
