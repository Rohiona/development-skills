#!/usr/bin/env python3
"""PreToolUse hook: 生の `codex exec/review/resume` を Bash で直接叩くのをブロックし、
wrapper `~/.claude/skills/codex/scripts/codex-exec.sh` 経由へ誘導する。

背景:
  生 `codex exec` は (1) stdin を閉じないと「Reading additional input from stdin...」で
  無言ハング、(2) timeout が無いと数時間〜数日暴走、(3) session ID 抽出も tee ログも無い。
  codex skill の規約は「wrapper 一択」だが、規約は入口(SKILL.md)にしか無く、下位の
  reference/workflow を辿ると生 `codex exec` を踏んでハングする事故が多発していた。
  ドキュメント修正に加え、本フックで物理的に生起動を塞ぐ（ドキュメントが将来崩れても安全）。

ブロック条件（すべて満たすときだけ deny）:
  1. tool が Bash
  2. command 中に「コマンド位置の」生 `codex (exec|review|resume)` がある
     ※ wrapper `codex-exec.sh ... exec` は `codex` の直後が `-` なのでマッチしない
     ※ `pgrep codex` / `kill $(pgrep codex)` / `cat /tmp/codex-*.log` もマッチしない

設計方針（cursor-delegation-enforce.py に倣う）:
  - パース失敗・想定外は fail-open（exit 0）。フック障害で Bash を完全に塞がない。
  - 出力は exit 2 + stderr。stderr 内容が Claude に返り、wrapper 経由へ誘導する。
"""
import json
import re
import sys

# コマンド位置の `codex (exec|review|resume)` を検出。
# `codex` の直前は 行頭 / 空白 / ; & | ( ) ` { のいずれか（= コマンド境界）。
# wrapper は `.../codex-exec.sh` で `codex` の直前が `/`、直後が `-` なので非マッチ。
RAW_CODEX = re.compile(r"(?:^|[\s;&|()`{])codex\s+(?:exec|review|resume)\b")

BLOCK_MESSAGE = """\
[codex-wrapper-enforce] 生 `codex exec/review/resume` の直接実行はブロックされています。

理由: 生起動は stdin 未クローズで無言ハング / timeout 無しで暴走 / session ID 抽出・tee ログ無し。
必ず wrapper 経由で起動してください（codex skill 既定）:

  ~/.claude/skills/codex/scripts/codex-exec.sh <timeout_sec> exec -s read-only -C <repo> -o <out> "<prompt>"
  ~/.claude/skills/codex/scripts/codex-exec.sh <timeout_sec> exec resume <SESSION_ID> "<prompt>"
  ~/.claude/skills/codex/scripts/codex-exec.sh <timeout_sec> review --diff-target main

wrapper が timeout 適用 / `</dev/null` 強制 / tee ログ保存 / session ID 抽出 を一括で行います。
第1引数は timeout 秒数（既定 1200、短縮 600、拡張 1800/3600）。
詳細は ~/.claude/skills/codex/SKILL.md を参照。"""


def fail_open():
	sys.exit(0)


def main():
	try:
		payload = json.load(sys.stdin)
	except Exception:
		fail_open()
		return

	if payload.get("tool_name", "") != "Bash":
		fail_open()
		return

	command = (payload.get("tool_input", {}) or {}).get("command", "")
	if not isinstance(command, str) or not command:
		fail_open()
		return

	if RAW_CODEX.search(command):
		sys.stderr.write(BLOCK_MESSAGE)
		sys.exit(2)

	fail_open()


if __name__ == "__main__":
	main()
