#!/usr/bin/env python3
"""PR作成・push 等の「リモートに公開される git/GitHub 操作」を検知したら、
permissionDecision=ask を返して必ず人間の確認プロンプトを挟む PreToolUse フック。

背景: 閣下の明示依頼なしに Claude が PR を作成する事故が2回発生（2026-07-11 ほか）。
プラン承認や CLAUDE.md のフロー記述を「PR 作成まで承認済み」と拡大解釈する失敗モードを、
モデルの自制ではなく機構で塞ぐ。allow ルール（例: Bash(gh api:*)）より優先される。

対象: gh pr create / gh pr ready / gh pr merge / git push（全形態）/
      gh api による PR 作成・更新（POST/PATCH × pulls）/ gh repo create
非対象: gh pr view/list/diff/close 等の読み取り・後始末系、git fetch/pull。
"""

import json
import re
import sys


PATTERNS = [
	# git push（git -C <dir> push 等、間に任意のオプション・引数を挟む形も拾う。
	# ローカル操作の git stash push は除外。過検知は「確認が1回増える」だけなので広めに倒す）
	r"(?:^|[;&|`$(]|\s)git\s+(?:\S+\s+)*?(?<!stash\s)push\b",
	# gh の PR 作成・公開・マージ
	r"\bgh\s+pr\s+(?:create|ready|merge)\b",
	# gh api での PR 作成・更新（POST/PATCH/PUT × pulls エンドポイント）
	r"\bgh\s+api\b(?=.*\bpulls\b)(?=.*(?:-X\s*(?:POST|PATCH|PUT)|--method[=\s]*(?:POST|PATCH|PUT)|(?:^|\s)-[fF]\s))",
	# リポジトリ新規公開
	r"\bgh\s+repo\s+create\b",
]

REASON = (
	"🛑 リモート公開系の操作（git push / PR 作成・公開・マージ）です。"
	"この操作は閣下がこの会話で明示的に依頼した場合のみ実行できます（2026-07-11 再発防止の恒久ルール）。"
	"依頼済みなら承認、依頼していないなら拒否してください。"
)


def main() -> None:
	try:
		payload = json.load(sys.stdin)
	except Exception:
		return
	if payload.get("tool_name") != "Bash":
		return
	command = (payload.get("tool_input") or {}).get("command") or ""
	for pattern in PATTERNS:
		if re.search(pattern, command):
			print(
				json.dumps(
					{
						"hookSpecificOutput": {
							"hookEventName": "PreToolUse",
							"permissionDecision": "ask",
							"permissionDecisionReason": REASON,
						}
					}
				)
			)
			return


if __name__ == "__main__":
	main()
