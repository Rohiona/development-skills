#!/usr/bin/env bash
# PostToolUse(Write|Edit|MultiEdit): format the just-edited file with Biome.
# Claude Code passes tool data as JSON on stdin; the edited path is at
# .tool_input.file_path. Env vars like $CLAUDE_FILE_PATH are NOT provided
# (confirmed via the Claude Code hooks docs), so the previous hook silently
# did nothing.

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

if [ -n "$file" ] && [ -f "$file" ]; then
	case "$file" in
		*.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.mts | *.cts | *.json | *.jsonc | *.css)
			# pnpm ラッパー経由の起動が支配的コスト（実測 554ms/回・2026-07-04）だったため、
			# リポジトリの biome バイナリを直接叩く。見つからない場合のみ pnpm にフォールバック。
			root_dir=$(cd "$(dirname "$file")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)
			if [ -n "$root_dir" ] && [ -x "$root_dir/node_modules/.bin/biome" ]; then
				(cd "$root_dir" && ./node_modules/.bin/biome check --write "$file") >/dev/null 2>&1 || true
			else
				pnpm biome check --write "$file" >/dev/null 2>&1 || true
			fi
			;;
	esac
fi
exit 0
