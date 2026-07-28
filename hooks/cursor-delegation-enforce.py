#!/usr/bin/env python3
"""PreToolUse hook: 対象リポジトリでのコード実装を Cursor agent CLI 委譲へ強制する。

ブロック条件（すべて満たすときだけ deny）:
  1. ツールがコード変更系（Edit/Write/MultiEdit/NotebookEdit/Serena 書換/tsmorph）
  2. 対象がコードファイル（.ts .tsx .js .jsx .mjs .cjs .mts .cts）
     ※ tsmorph 系は定義上コード操作なので拡張子に依らずブロック
  3. cwd が対象リポジトリ（環境変数 CURSOR_DELEGATION_ROOT）配下
  4. 例外スイッチ（~/.claude/.cursor-delegation-fallback）が未発行 or 失効

やむを得ない場合（トークン枯渇・Cursor 障害など）は
  bash ~/.claude/hooks/cursor-delegation-fallback.sh
で TTL 内だけ Serena/Edit を解禁する。

設計方針:
  - パース失敗・想定外は fail-open（exit 0）。フック障害で編集を完全に塞がない。
  - 出力は exit 2 + stderr。stderr 内容が Claude に返り、Cursor 委譲へ誘導する。
"""
import json
import os
import sys
import time

# 委譲を強制する対象リポジトリのルート。導入先で環境変数 CURSOR_DELEGATION_ROOT に
# 絶対パスを設定する（例: settings.json の env で "/path/to/your-repo"）。
# 未設定なら本フックは何もしない（fail-open）。
TARGET_ROOT = os.path.expanduser(os.environ.get("CURSOR_DELEGATION_ROOT", ""))
MARKER = os.path.expanduser("~/.claude/.cursor-delegation-fallback")

CODE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")

# 対象パスを拡張子で判定する変更系ツール → tool_input のキー
PATH_KEYS = {
	"Edit": "file_path",
	"Write": "file_path",
	"MultiEdit": "file_path",
	"NotebookEdit": "notebook_path",
	"mcp__plugin_serena_serena__replace_symbol_body": "relative_path",
	"mcp__plugin_serena_serena__replace_content": "relative_path",
	"mcp__plugin_serena_serena__insert_after_symbol": "relative_path",
	"mcp__plugin_serena_serena__insert_before_symbol": "relative_path",
	"mcp__plugin_serena_serena__create_text_file": "relative_path",
	"mcp__plugin_serena_serena__safe_delete_symbol": "relative_path",
	"mcp__plugin_serena_serena__rename_symbol": "relative_path",
}

# 拡張子に依らず常にコード操作とみなす（tsmorph リファクタ系）
ALWAYS_CODE_TOOLS = {
	"mcp__mcp-tsmorph-refactor__change_signature_by_tsmorph",
	"mcp__mcp-tsmorph-refactor__move_symbol_to_file_by_tsmorph",
	"mcp__mcp-tsmorph-refactor__remove_path_alias_by_tsmorph",
	"mcp__mcp-tsmorph-refactor__rename_filesystem_entry_by_tsmorph",
	"mcp__mcp-tsmorph-refactor__rename_symbol_by_tsmorph",
}

# 小さい編集は Serena/Edit 直を許可する閾値（書き下す「新規内容」の行数）。
# これ以下なら、委譲の仕様文を書くより直接編集した方が安く速い「ちまちました修正」とみなす。
# 超える実装、および新規内容を持たない構造系リファクタ（rename/delete/tsmorph）は委譲へブロック。
SMALL_EDIT_MAX_LINES = 40

# 直接編集で「書き下す新規内容」を持つツール → その内容の tool_input キー。
# ここに無いコード変更系（rename_symbol/safe_delete_symbol/tsmorph 等）は新規内容を測れない＝委譲のまま。
CONTENT_KEYS = {
	"Edit": "new_string",
	"Write": "content",
	"mcp__plugin_serena_serena__replace_symbol_body": "body",
	"mcp__plugin_serena_serena__insert_after_symbol": "body",
	"mcp__plugin_serena_serena__insert_before_symbol": "body",
	"mcp__plugin_serena_serena__create_text_file": "content",
	"mcp__plugin_serena_serena__replace_content": "repl",
}


def new_content_line_count(tool_name, tool_input):
	"""直接編集で書き下す新規内容の行数。測れない（構造系など）は None。

	例外時も None を返し、呼び出し側で「委譲へブロック」側に倒す（小編集の誤許可を避ける）。
	"""
	try:
		if tool_name == "MultiEdit":
			edits = tool_input.get("edits", [])
			if not isinstance(edits, list):
				return None
			total = 0
			for e in edits:
				s = (e or {}).get("new_string", "")
				if isinstance(s, str):
					total += s.count("\n") + 1
			return total
		key = CONTENT_KEYS.get(tool_name)
		if key is None:
			return None
		s = tool_input.get(key, "")
		if not isinstance(s, str):
			return None
		return s.count("\n") + 1
	except Exception:
		return None


BLOCK_MESSAGE = """\
[cursor-delegation-enforce] この編集は大きい/構造系のため Cursor agent CLI へ委譲してください（CLAUDE.md 既定）。

小さい編集（書き下す新規内容が {max_lines} 行以下）は Serena/Edit 直が自動許可されます。
これがブロックされたのは、新規内容が {max_lines} 行超、もしくは新規内容を持たない構造系
（rename_symbol / safe_delete_symbol / tsmorph 等）だからです。大きい実装・構造系は委譲してください。
次の形で委譲してください（settings.json の permissions で事前承認しておくこと）:

  cursor agent -p --trust --force \\
    --workspace={workspace} --model composer-2.5 \\
    --output-format text "<要件/スコープ/触ってはいけない核/完了報告項目。/extract-testable-module と /tautology-test-detector の実行を必須で含める>"

やむを得ない場合（トークン枯渇・Cursor 起動不可・障害・timeout）のみ Serena/Edit を解禁:

  bash ~/.claude/hooks/cursor-delegation-fallback.sh        # 既定30分
  bash ~/.claude/hooks/cursor-delegation-fallback.sh 60     # 分指定

解禁後に同じ編集を再試行してください。"""


def fail_open():
	sys.exit(0)


def fallback_active() -> bool:
	try:
		with open(MARKER) as f:
			expiry = float(f.read().strip())
		return time.time() < expiry
	except Exception:
		return False


def main():
	try:
		payload = json.load(sys.stdin)
	except Exception:
		fail_open()
		return

	tool_name = payload.get("tool_name", "")
	tool_input = payload.get("tool_input", {}) or {}
	cwd = payload.get("cwd", "") or ""

	# 対象リポジトリ配下でのみ強制（未設定なら何もしない）
	if not TARGET_ROOT or not (cwd == TARGET_ROOT or cwd.startswith(TARGET_ROOT + "/")):
		fail_open()
		return

	is_code = False
	if tool_name in ALWAYS_CODE_TOOLS:
		is_code = True
	elif tool_name in PATH_KEYS:
		path = tool_input.get(PATH_KEYS[tool_name], "")
		if isinstance(path, str) and path.endswith(CODE_EXTS):
			is_code = True

	if not is_code:
		fail_open()
		return

	# 例外スイッチが有効なら通す
	if fallback_active():
		fail_open()
		return

	# 小さい編集（書き下す新規内容が SMALL_EDIT_MAX_LINES 行以下）は Serena/Edit 直を許可する。
	# 委譲の仕様文を書く方が割高になる「ちまちました修正」を直接やれるようにする（CLAUDE.md 既定）。
	# 構造系リファクタ（rename/delete/tsmorph）・大きい実装は None or 閾値超でブロック＝委譲へ。
	lines = new_content_line_count(tool_name, tool_input)
	if lines is not None and lines <= SMALL_EDIT_MAX_LINES:
		fail_open()
		return

	# ブロック
	sys.stderr.write(BLOCK_MESSAGE.format(workspace=cwd, max_lines=SMALL_EDIT_MAX_LINES))
	sys.exit(2)


if __name__ == "__main__":
	main()
