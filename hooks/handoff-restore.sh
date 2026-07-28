#!/usr/bin/env bash
# SessionStart hook: if a freshly-written handoff exists for THIS cwd,
# inject a one-line pointer into the new session's context (additionalContext).
# No confirmation, no auto-offer — just makes the pointer available so that when
# the user says "続き" the assistant can Read it and resume.
# /clear regenerates the session_id and provides no previous_session_id, so we
# locate the predecessor by "newest handoff in this cwd within a freshness window".
# Task handoffs (task-*.json) are preferred; session auto-dump (*.md) is fallback.
# Always exits 0.
set -uo pipefail

dbg(){ [ -f "$HOME/.claude/handoff/.debug" ] && printf '%s [restore] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$HOME/.claude/handoff/.debug.log" 2>/dev/null; return 0; }

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

GIT=/opt/homebrew/bin/git
[ -x "$GIT" ] || GIT=$(command -v git) || GIT=""

FRESH_SECONDS=${HANDOFF_FRESH_SECONDS:-300}   # full summary within this window (5 min)
POINTER_SECONDS=${HANDOFF_POINTER_SECONDS:-1209600}  # one-line pointer up to 14 days

input=$(cat 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | "$JQ" -r '.cwd // empty' 2>/dev/null)
cur_session=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0

# compact（圧縮）後の SessionStart では動かない。圧縮の復旧は compact-restore.sh に
# 一元化されており、ここで過去タスクの handoff pointer を注入するとミスリードになる
# （2026-07-08 compact 対策導入時のレビュー指摘 M1）。
src=$(printf '%s' "$input" | "$JQ" -r '.source // empty' 2>/dev/null)
[ "$src" = "compact" ] && exit 0
dbg "invoked session=$cur_session cwd=$cwd"

slug=$(printf '%s' "$cwd" | sed 's#/#-#g')
dir="$HOME/.claude/handoff/$slug"
[ -d "$dir" ] || exit 0

now=$(date +%s 2>/dev/null) || exit 0

# --- ISO8601 UTC -> epoch (best-effort; macOS date) ---
iso_to_epoch() {
	local iso="$1"
	local epoch
	epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null) && { printf '%s' "$epoch"; return; }
	epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%S%z" "$iso" +%s 2>/dev/null) && { printf '%s' "$epoch"; return; }
	printf '%s' "0"
}

# --- Select terminal task-*.json by createdAt + supersede leaf (within age limit) ---
select_json_handoff() {
	local max_age="$1"
	local -a files=()
	local f

	for f in "$dir"/task-*.json; do
		[ -f "$f" ] || continue
		files+=("$f")
	done
	[ "${#files[@]}" -gt 0 ] || return 1

	# Build set of paths superseded by someone else in this directory
	local -a superseded=()
	local canon child
	for f in "${files[@]}"; do
		while IFS= read -r child; do
			[ -n "$child" ] || continue
			if [ -f "$child" ]; then
				canon=$(cd "$(dirname "$child")" && pwd)/$(basename "$child")
			else
				canon="$child"
			fi
			superseded+=("$canon")
		done < <("$JQ" -r '.supersedes[]?' "$f" 2>/dev/null)
	done

	is_superseded() {
		local target="$1"
		local tcanon s
		tcanon=$(cd "$(dirname "$target")" && pwd)/$(basename "$target")
		# 空配列の "${arr[@]}" は bash 3.2 + set -u で unbound → ${arr[@]+...} でガード
		for s in ${superseded[@]+"${superseded[@]}"}; do
			[ "$s" = "$tcanon" ] && return 0
		done
		return 1
	}

	local best="" best_epoch=0 created_epoch age
	for f in "${files[@]}"; do
		is_superseded "$f" && continue
		created=$("$JQ" -r '.createdAt // empty' "$f" 2>/dev/null)
		[ -n "$created" ] || continue
		created_epoch=$(iso_to_epoch "$created")
		[ "$created_epoch" -gt 0 ] || continue
		age=$(( now - created_epoch ))
		[ "$age" -le "$max_age" ] || continue
		if [ "$created_epoch" -gt "$best_epoch" ]; then
			best_epoch=$created_epoch
			best=$f
		fi
	done

	[ -n "$best" ] || return 1
	printf '%s' "$best"
	return 0
}

inject_json_context() {
	local handoff="$1"
	local mode="$2"   # full | pointer
	local age=$(( now - $(iso_to_epoch "$("$JQ" -r '.createdAt' "$handoff")") ))

	local topic goal branch created_at needs_completion incomplete_note head_warn where
	topic=$("$JQ" -r '.topic // "?"' "$handoff")
	goal=$("$JQ" -r '.goal // ""' "$handoff" | head -n 3)
	branch=$("$JQ" -r '.place.branch // ""' "$handoff")
	created_at=$("$JQ" -r '.createdAt // ""' "$handoff")
	needs_completion=$("$JQ" -r '.needsCompletion // false' "$handoff")

	incomplete_note=""
	[ "$needs_completion" = "true" ] && incomplete_note=$'\n⚠️ 不完全版（機械事実のみ）。needsCompletion=true — 散文フィールドは要補完。'

	# headSha vs current HEAD
	head_warn=""
	recorded_sha=$("$JQ" -r '.place.headSha // empty' "$handoff")
	worktree=$("$JQ" -r '.place.worktree // empty' "$handoff")
	if [ -n "$GIT" ] && [ -n "$worktree" ] && [ "$worktree" != "unknown" ] && \
		[ -n "$recorded_sha" ] && [ "$recorded_sha" != "unknown" ] && \
		"$GIT" -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		current_sha=$("$GIT" -C "$worktree" rev-parse HEAD 2>/dev/null || echo "")
		if [ -n "$current_sha" ] && [ "$current_sha" != "$recorded_sha" ] && \
			[[ "$current_sha" != "$recorded_sha"* ]] && [[ "$recorded_sha" != "$current_sha"* ]]; then
			head_warn=$'\n⚠️ 陳腐化の可能性: 記録 HEAD '"$recorded_sha"' ≠ 現 HEAD '"$current_sha"'。着手前に再照合せよ。'
		fi
	fi

	where=""
	[ -n "$branch" ] && where=$'\n作業ブランチ: '"${branch}"'（続きはこのブランチで。develop / main で作業しないこと）'
	pr_url=$("$JQ" -r '.place.prUrl // empty' "$handoff")
	[ -n "$pr_url" ] && [ "$pr_url" != "none" ] && where=$where$'\nPR: '"$pr_url"

	local ctx
	if [ "$mode" = "pointer" ]; then
		ctx=$(printf 'タスク引き継ぎあり: %s / %s / %s / %s。該当タスクなら Read、無関係なら無視。%s' \
			"$topic" "$branch" "$created_at" "$handoff" "$incomplete_note")
	else
		ctx=$(printf '【%s】%s\n\n前回セッションのタスク handoff があります（%d秒前）。続きの作業をする場合はまず次を Read して状況を把握してください:\n%s%b%s%s\n\n【ハンドオフに情報が欠けていたときの補完手順（推測で違う場所を探さない）】\n- 事実が不明（今どうなっているか）: コード・git 履歴で確認する（最新の一次情報・陳腐化しない）。\n- 背景/意図が不明（なぜそうしたか）: まず memory skill（claude-mem）で想起 → 次に設計書 design_doc/（実装からの逆起こしで鮮度が低いためヒント扱い・必ずコードで裏取り）。\n- それでも埋まらない／確信が持てない箇所は、推測で進めず必ずユーザーに確認する。補った情報は出所（一次情報/メモリ/推測）を区別して報告する。\n- 中身は AI 生成につき着手前に一次情報で裏取りすること。\n\nこのセッションが前回と無関係な新規作業なら無視して構いません。' \
			"$topic" "$goal" "$age" "$handoff" "$where" "$head_warn" "$incomplete_note")
	fi

	dbg "cwd=$cwd INJECT json=$handoff mode=$mode age=${age}s"
	"$JQ" -nc --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}'
	exit 0
}

# --- JSON path (task-*.json): 5 min full / 5min–14d pointer ---
json_handoff=""
json_handoff=$(select_json_handoff "$POINTER_SECONDS" 2>/dev/null) || json_handoff=""
if [ -n "$json_handoff" ]; then
	created_epoch=$(iso_to_epoch "$("$JQ" -r '.createdAt' "$json_handoff")")
	json_age=$(( now - created_epoch ))
	# 2026-07-04 閣下決定: JSON は経過時間によらず常に1行ポインタ（要約注入なし）。
	# 貼り付けブロックが正・自動注入は保険。誤注入の害を1行に固定する。
	if [ "$json_age" -le "$POINTER_SECONDS" ]; then
		inject_json_context "$json_handoff" "pointer"
	fi
	dbg "cwd=$cwd json stale age=${json_age}s>${POINTER_SECONDS}s"
fi

# --- Existing md path (unchanged): mtime + 5 min window only ---
newest=""; newest_mtime=0
for f in "$dir"/*.md; do
	[ -f "$f" ] || continue
	[ "$(basename "$f")" = "$cur_session.md" ] && continue
	m=$(stat -f %m "$f" 2>/dev/null) || continue
	if [ "$m" -gt "$newest_mtime" ]; then newest_mtime=$m; newest=$f; fi
done

[ -n "$newest" ] || { dbg "cwd=$cwd no handoff found in $dir"; exit 0; }
age=$(( now - newest_mtime ))
[ "$age" -le "$FRESH_SECONDS" ] || { dbg "cwd=$cwd stale newest=$newest age=${age}s>${FRESH_SECONDS}s"; exit 0; }

hb=$(grep -m1 '^- branch:' "$newest" 2>/dev/null | sed 's/^- branch: *//; s/`//g')
hpr=$(grep -m1 '^- PR:' "$newest" 2>/dev/null | sed 's/^- PR: *//')
where=""
[ -n "$hb" ] && where="$where\n作業ブランチ: ${hb}（続きはこのブランチで。develop / main で作業しないこと）"
[ -n "$hpr" ] && where="$where\nPR: ${hpr}"

ctx=$(printf '前回セッションの handoff があります（自動生成・%d秒前に終了）。続きの作業をする場合はまず次を Read して状況を把握してください:\n%s%b\n\n【ハンドオフに情報が欠けていたときの補完手順（推測で違う場所を探さない）】\n- 事実が不明（今どうなっているか）: コード・git 履歴で確認する（最新の一次情報・陳腐化しない）。\n- 背景/意図が不明（なぜそうしたか）: まず memory skill（claude-mem）で想起 → 次に設計書 design_doc/（実装からの逆起こしで鮮度が低いためヒント扱い・必ずコードで裏取り）。\n- それでも埋まらない／確信が持てない箇所は、推測で進めず必ずユーザーに確認する。補った情報は出所（一次情報/メモリ/推測）を区別して報告する。\n\nこのセッションが前回と無関係な新規作業なら無視して構いません。' "$age" "$newest" "$where")

dbg "cwd=$cwd INJECT md newest=$newest age=${age}s"
"$JQ" -nc --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}'
exit 0
