#!/usr/bin/env bash
# 共通ユーティリティ。各スクリプトから source する。
# profile のエイリアス/関数上書きを避けるため core コマンドは command 経由で呼ぶ。

set -uo pipefail

# リポジトリ owner/name を gh から解決（cwd の git リポジトリ基準）。
# 引数 $1 に owner/name を明示した場合はそれを優先。
resolve_repo() {
	if [ "${1:-}" != "" ]; then
		printf '%s' "$1"
		return 0
	fi
	gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null
}

# 現在時刻を UTC ISO8601 で返す。
# ★重要: GitHub API の since/created_at は UTC。ローカル(JST等)の壁時計を
#   そのまま渡すと未来時刻になり「永遠にヒットしない」事故になる(実績あり)。
now_utc() {
	command date -u +%Y-%m-%dT%H:%M:%SZ
}

# Bugbot レビュー本文から verdict を判定して表示文字列を返す。
# 標準入力に review body を渡す。
# 出力例: "LGTM (no new issues)" / "FINDINGS (found 2 potential issues)" / "UNKNOWN"
classify_verdict() {
	command awk '
		/no new issues|did(n.t| not) find|no potential issues/ { print "LGTM"; found=1; exit }
		match($0, /found [0-9]+ (new )?(potential )?issue/) { print "FINDINGS (" substr($0, RSTART, RLENGTH) ")"; found=1; exit }
		END { if (!found) print "UNKNOWN" }
	'
}
