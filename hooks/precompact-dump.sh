#!/usr/bin/env bash
# PreCompact hook: 圧縮の直前に transcript（生ログ）を丸ごと退避する保険。
#
# 役割: compact-save skill での保存を経ずに自動 compact が走っても、圧縮前の
# 生ログが必ず残るようにする（LLM 不使用・トークンコストゼロ・cp 1回）。
# manual / auto の両トリガーで動く（matcher なしで登録）。
# 復旧側（compact-restore.sh）がこのダンプの存在を圧縮後の Claude に知らせる。
# 何が起きても exit 0（compact を絶対に妨げない）。
set -uo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

STATE_DIR="$HOME/.claude/session-state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

input=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
transcript=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)
trigger=$(printf '%s' "$input" | "$JQ" -r '.trigger // "unknown"' 2>/dev/null)
cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null)

# session_id を安全なファイル名に（英数とハイフン以外は捨てる）
sid=$(printf '%s' "$sid" | tr -cd 'a-zA-Z0-9-' | cut -c1-64)
[ -n "$sid" ] || exit 0

if [ -n "$transcript" ] && [ -f "$transcript" ]; then
	cp -f "$transcript" "$STATE_DIR/$sid.pre-compact.jsonl" 2>/dev/null
fi

# どこで・いつ・何がきっかけで圧縮されたかの1行メタ（復旧時の人間可読の手がかり）
GIT=/opt/homebrew/bin/git
[ -x "$GIT" ] || GIT=$(command -v git) || GIT=""
branch=""
if [ -n "$GIT" ] && [ -n "$cwd" ]; then
	branch=$("$GIT" -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
fi
printf '%s trigger=%s cwd=%s branch=%s\n' \
	"$(date '+%Y-%m-%dT%H:%M:%S%z')" "$trigger" "${cwd:-unknown}" "${branch:-unknown}" \
	>>"$STATE_DIR/$sid.pre-compact.meta" 2>/dev/null

# 14日超の残骸を掃除（state / dump / marker 全種）
find "$STATE_DIR" -type f -mtime +14 -delete 2>/dev/null

printf '%s event=PreCompact sid=%s action=dump trigger=%s\n' \
	"$(date '+%Y-%m-%dT%H:%M:%S')" "$sid" "$trigger" \
	>>"$STATE_DIR/.hook-events.log" 2>/dev/null

# レビューセッション判定（2026-07-23 閣下決定: レビューは compact でなく handoff → /clear が既定）。
# パターンはレビュー用ワークツリー/ブランチの命名規約に限定（CLAUDE.md「レビュー用ワークツリーの命名」
# の review/ 系 + pr-N-review-* 実例。feat/review-ui 等の機能ブランチには当たらない）。
# PreCompact の exit 2 は compact をブロックせず stderr をユーザーへ表示するだけ（dump は上で完了済み）。
is_review=""
case "$cwd" in
	*/.claude/worktrees/review/*|*/.claude/worktrees/*-review-*) is_review=1 ;;
esac
case "$branch" in
	review/*|claude/review/*|*-review-*) is_review=1 ;;
esac
if [ -n "$is_review" ]; then
	echo "【レビューセッション検知】この compact (trigger=$trigger) はレビュー用セッション（cwd=$cwd / branch=${branch:-unknown}）で実行されました。レビュー文脈は使い捨てが大半のため、compact での継続より handoff → /clear での切り替えが既定です。次の切れ目では handoff を使ってください。" >&2
	exit 2
fi

exit 0
