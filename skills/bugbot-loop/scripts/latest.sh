#!/usr/bin/env bash
# 現在の Bugbot 最新レビューの verdict と対象コミットを表示する（監視を貼る前の現状確認用）。
# 使い方: latest.sh <PR番号> [owner/name]

set -uo pipefail
HERE="$(command dirname "$0")"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PR="${1:?usage: latest.sh <PR番号> [owner/name]}"
REPO="$(resolve_repo "${2:-}")"

echo "now (UTC): $(now_utc)"
echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
	--jq '[.[] | select(.user.login=="cursor[bot]")] | .[-1] // empty
	      | "latest cursor[bot] review | \(.submitted_at) | commit \((.body | capture("for commit (?<c>[0-9a-f]{7})").c) // "?")"' \
	2>/dev/null
# verdict は body を分けて分類（lib.sh）
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" \
	--jq '[.[] | select(.user.login=="cursor[bot]")] | (.[-1].body // "")' 2>/dev/null \
	| { body="$(command cat)"; printf 'verdict: '; printf '%s' "$body" | classify_verdict; }
