#!/usr/bin/env bash
# tautology-test-detector / 静的プレフィルタ
#
# 役割: テストファイルから「トートロジー/メタテスト候補」を機械的に surface するだけ。
#       判定はしない（LLM 段が detection-criteria.md の類型 + 誤検出ガードで adjudicate する）。
#
# 使い方: prefilter.sh [PATH ...]            (既定: カレント配下を再帰)
#   例: prefilter.sh apps/frontend/src
#       prefilter.sh $(git diff --name-only develop...HEAD | grep -E '\.(test|spec)\.tsx?$')
#
# 出力: 1 行 = "category<TAB>file:line:matched"。0 件なら候補なし。
#
# シェル堅牢性: profile のエイリアス/関数上書きを避けるため rg/grep は command 経由で呼ぶ
#   (グローバルルール shell-robustness)。rg が無ければ grep -rnE にフォールバック。

set -uo pipefail

# --- 検索バックエンド選択 ---------------------------------------------------
if command -v rg >/dev/null 2>&1; then
	BACKEND="rg"
	GLOB_ARGS=(-g '*.test.ts' -g '*.test.tsx' -g '*.spec.ts' -g '*.spec.tsx')
	search() { command rg --no-heading --line-number --color never "${GLOB_ARGS[@]}" -e "$1" -- "${PATHS[@]}" 2>/dev/null; }
else
	BACKEND="grep"
	INC_ARGS=(--include='*.test.ts' --include='*.test.tsx' --include='*.spec.ts' --include='*.spec.tsx')
	search() { command grep -rnE "${INC_ARGS[@]}" -e "$1" -- "${PATHS[@]}" 2>/dev/null; }
fi

# --- 対象パス ---------------------------------------------------------------
PATHS=("$@")
if [ "${#PATHS[@]}" -eq 0 ]; then
	PATHS=(".")
fi

# --- カテゴリ -> パターン (detection-criteria.md / static-prefilter.md と対応) ---
# 連想配列は bash 4+ のみなので、移植性のため平行配列で持つ。
CATEGORIES=(
	"META:source-read"
	"META:grep-spawn"
	"META:source-includes"
	"META:self-reference"
	"TAUTOLOGY:literal"
	"TAUTOLOGY:scaffold"
	"MOCKONLY:vi-mock"
	"DOC:comment-exists"
)
PATTERNS=(
	'readFileSync\('
	'spawnSync\(.{0,3}grep'
	'\.includes\(.{0,2}(as any|as unknown|from .~/gen|function )'
	'(__filename|readFileSync\(\s*__)'
	'expect\(\s*(true|false|-?[0-9]+|null|undefined)\s*\)\.toBe\(\s*(true|false|-?[0-9]+|null|undefined)\s*\)'
	'(adds 1 \+ 2 to equal 3|/temp/sum)'
	'vi\.mock\('
	'(toContain\(.{0,2}//|describe\(.*(ドキュメント|documentation))'
)

# --- 実行 -------------------------------------------------------------------
echo "# tautology-test-detector 静的プレフィルタ候補 (backend=${BACKEND})"
echo "# 形式: category<TAB>file:line:matched"
echo "# これは候補出力。各行は LLM 段で detection-criteria.md の類型 + 誤検出ガードに照らして判定すること。"
echo

total=0
i=0
while [ "$i" -lt "${#CATEGORIES[@]}" ]; do
	cat="${CATEGORIES[$i]}"
	pat="${PATTERNS[$i]}"
	out="$(search "$pat")" || true
	if [ -n "$out" ]; then
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			printf '%s\t%s\n' "$cat" "$line"
			total=$((total + 1))
		done <<EOF
$out
EOF
	fi
	i=$((i + 1))
done

echo
echo "# 候補 ${total} 件。0 件でも mock-only / 設計意図のあるメタは静的に拾えないため、健全と即断しないこと。"
echo "# 誤検出帯域(残すべきもの): instanceof 実行時 wiring / 移行期 temp smoke / 同名 field validator /"
echo "#   toMatchSnapshot を使わない誤命名 snapshot / 実際に振る舞いを検証しているテスト。"
