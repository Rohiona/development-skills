#!/usr/bin/env bash
# impacted-packages.sh — 変更ファイルから影響 pnpm パッケージ名を算出
#
# `pnpm --filter <pkg> test` の対象を決めるため、変更ファイルが属する pnpm パッケージ
# （最も近い祖先 package.json の "name"）を返す。
#
# 推奨: 実装ステージが result.json で報告した changed_files を明示的に渡す（最も正確。
#       git 推定だとスキル自身の未追跡ファイル等を巻き込む）:
#   impacted-packages.sh --files packages/server-core/src/a.ts packages/foo/b.ts
# git から推定（明示リストが無い時のフォールバック）:
#   impacted-packages.sh            # 作業ツリー変更(staged+unstaged) + 新規(未追跡)
#   impacted-packages.sh --base develop   # 上記 + develop...HEAD のコミット差分
# 出力: パッケージ名を1行ずつ（重複排除）。該当なしなら何も出さず exit 0。
set -uo pipefail

REPO_ROOT="${AUTODEV_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO_ROOT" 2>/dev/null || exit 1

MODE="git"; BASE=""; FILES=()
case "${1:-}" in
	--files) shift; MODE="files"; FILES=("$@") ;;
	--base)  shift; BASE="${1:-}" ;;
	"")      : ;;
	*)       BASE="$1" ;;   # 後方互換: 第1引数を base ref とみなす
esac

changed_files() {
	if [ "$MODE" = "files" ]; then
		[ "${#FILES[@]}" -gt 0 ] && printf '%s\n' "${FILES[@]}"
		return 0
	fi
	git diff --name-only HEAD 2>/dev/null || true                 # 作業ツリー(staged+unstaged) vs HEAD
	git ls-files --others --exclude-standard 2>/dev/null || true  # 新規(未追跡)ファイルも含める
	if [ -n "$BASE" ]; then
		git diff --name-only "${BASE}...HEAD" 2>/dev/null || true
	fi
}

pkg_name_for() {
	local f="$1" dir
	dir="$(dirname "$f")"
	while [ "$dir" != "." ] && [ "$dir" != "/" ] && [ -n "$dir" ]; do
		if [ -f "$REPO_ROOT/$dir/package.json" ]; then
			node -e "try{var n=require('$REPO_ROOT/$dir/package.json').name;if(n)process.stdout.write(n)}catch(e){}" 2>/dev/null
			return 0
		fi
		dir="$(dirname "$dir")"
	done
	return 0
}

changed_files | sort -u | while IFS= read -r f; do
	[ -n "$f" ] || continue
	name="$(pkg_name_for "$f")"
	[ -n "$name" ] && printf '%s\n' "$name"
done | sort -u

exit 0
