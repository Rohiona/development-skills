#!/usr/bin/env bash
# Bugbot の再レビューを起動する（PR に "bugbot run" コメントを投稿）。
# 使い方: run.sh <PR番号> [owner/name]
# 副作用: PR にコメントを1件投稿する。ユーザー承認済みの前提で呼ぶこと。

set -uo pipefail
HERE="$(command dirname "$0")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PR="${1:?usage: run.sh <PR番号> [owner/name]}"
REPO="$(resolve_repo "${2:-}")"

gh pr comment "$PR" ${REPO:+--repo "$REPO"} --body "bugbot run"
echo "posted 'bugbot run' to PR #$PR ($REPO) at $(now_utc)"
