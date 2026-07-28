#!/usr/bin/env bash
# development-skills を ~/.claude へソフトリンクで導入するインストーラ
#
# 使い方:
#   ./install.sh          # 既存の同名エントリはスキップ（安全側）
#   ./install.sh --force  # 既存エントリを削除してこのリポジトリへのリンクに置き換え（注意: 既存実体は消える）
#
# 方式: ディレクトリ丸ごとではなく「中身1つずつ」をリンクする。
#   例) ~/.claude/skills/memory -> <このリポジトリ>/skills/memory
# こうすることで、導入先に元からあるローカル専用スキル・hooks と共存できる。
# リポジトリを git pull すればリンク先の実体が更新されるので、全現場に即反映される。
#
# settings.json は自動編集しない。hooks の配線は templates/settings.hooks.json を
# 手動でマージすること（既存の settings を壊さないため）。

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.claude"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

link_children() {
	local from="$1" to="$2"
	mkdir -p "$to"
	local entry name target
	for entry in "$from"/*; do
		[ -e "$entry" ] || continue
		name="$(basename "$entry")"
		target="$to/$name"
		if [ -L "$target" ] && [ "$(readlink "$target")" = "$entry" ]; then
			echo "    = $name（リンク済み）"
		elif [ -e "$target" ] || [ -L "$target" ]; then
			if [ "$FORCE" = 1 ]; then
				rm -rf "$target"
				ln -s "$entry" "$target"
				echo "    ! $name（既存を削除してリンクに置換）"
			else
				echo "    - $name（既存ありスキップ。リンクへの置換は --force）"
			fi
		else
			ln -s "$entry" "$target"
			echo "    + $name"
		fi
	done
}

echo "==> 導入先: $DST（モード: $([ "$FORCE" = 1 ] && echo '--force 置換' || echo '既存スキップ')）"

for dir in skills commands agents workflows hooks scripts references; do
	echo "  $dir/"
	link_children "$SRC/$dir" "$DST/$dir"
done

echo "  rules/common/"
link_children "$SRC/rules/common" "$DST/rules/common"

echo "  plugins/local/"
link_children "$SRC/plugins" "$DST/plugins/local"

# CLAUDE.md はリンクせずコピー（導入先ごとにプロジェクト固有節を追記して育てるため）
if [ ! -f "$DST/CLAUDE.md" ]; then
	cp "$SRC/templates/CLAUDE.md" "$DST/CLAUDE.md"
	echo "  CLAUDE.md ... テンプレートを配置（コピー。導入先で自由に追記）"
else
	echo "  CLAUDE.md ... 既存あり。templates/CLAUDE.md を参考に手動マージしてください"
fi

echo ""
echo "==> 残りの手動ステップ:"
echo "    1. templates/settings.hooks.json の hooks を ~/.claude/settings.json にマージ"
echo "    2. skills/extract-testable-module/references/area-map.md に導入先リポジトリの領域表を記入"
echo "    3. 前提 CLI の確認: gh / codex / cursor-agent / uv（README「前提ツール」参照）"
echo ""
echo "==> アンインストール: このリポジトリを指すリンクだけを外すには"
echo "    find ~/.claude -maxdepth 3 -type l -lname \"$SRC/*\" -delete"
