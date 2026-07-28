#!/usr/bin/env bash
# compact 復旧 hook（2つのイベントに同じスクリプトを登録し、stdin で分岐）。
#
# 主経路: SessionStart(matcher: compact) — 圧縮直後に additionalContext で
#   「状態ファイルを読み直せ／圧縮サマリーの次の一手は仮説扱い」を注入する。
# 保険経路: UserPromptSubmit — PostCompact が残した印（marker）を検出したら
#   同じ注入を行う。SessionStart(compact) が発火しないバージョン/経路でも
#   1ターン遅れで必ず復旧させるための冗長化。
#
# 冪等性（二重注入の防止）: transcript に compact のたびに刻まれる
#   {"type":"system","subtype":"compact_boundary"} 行の「出現数」を復旧の通し番号
#   として使う。復旧を実行したら出現数を .restored に記録し、以後は
#   「現在の出現数 > 記録済み出現数」のときだけ注入する。これで PostCompact と
#   SessionStart の発火順がどちらでも、同一圧縮への注入は厳密1回になる
#   （設計レビュー指摘 H2: mtime 窓比較は順序逆転・時計飛びに弱いため廃止）。
#
# marker 無しの通常ターンは test -f 1回で即抜け（毎ターンのコストほぼゼロ）。
# 何が起きても exit 0。
set -uo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq) || exit 0

STATE_DIR="$HOME/.claude/session-state"
MARK_DIR="$STATE_DIR/.marks"
EV_LOG="$STATE_DIR/.hook-events.log"

log_ev() {
	printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$EV_LOG" 2>/dev/null
	# 肥大防止: 200KB 超で後半 100KB だけ残す
	if [ "$(stat -f '%z' "$EV_LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
		tail -c 100000 "$EV_LOG" >"$EV_LOG.tmp" 2>/dev/null && mv -f "$EV_LOG.tmp" "$EV_LOG" 2>/dev/null
	fi
	return 0
}

input=$(cat 2>/dev/null) || exit 0
event=$(printf '%s' "$input" | "$JQ" -r '.hook_event_name // empty' 2>/dev/null)
sid=$(printf '%s' "$input" | "$JQ" -r '.session_id // empty' 2>/dev/null)
transcript=$(printf '%s' "$input" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)
sid=$(printf '%s' "$sid" | tr -cd 'a-zA-Z0-9-' | cut -c1-64)
[ -n "$sid" ] || exit 0

marker="$MARK_DIR/$sid.compacted"
restored_f="$MARK_DIR/$sid.restored"
state_file="$STATE_DIR/$sid.md"
dump_file="$STATE_DIR/$sid.pre-compact.jsonl"

# transcript 内の compact 境界の出現数（通し番号）。取れなければ -1（不明）。
# 注意: grep -c は 0 件のとき自分で「0」を印字して exit 1 する。ここに || echo 0 を
# 重ねると出力が「0\n0」になり整数比較が壊れて誤注入する（2026-07-09 実発火で検出）。
boundary_count() {
	local cnt
	if [ -n "$transcript" ] && [ -f "$transcript" ]; then
		cnt=$(command grep -c '"compact_boundary"' "$transcript" 2>/dev/null) || true
		printf '%s\n' "${cnt:-0}"
	else
		echo -1
	fi
}

restored_count() {
	local v
	v=$(cat "$restored_f" 2>/dev/null | tr -cd '0-9')
	printf '%s' "${v:-0}"
}

build_context() {
	local msg="【compact 復旧】直前にコンテキスト圧縮が実行されました。作業を続ける前に必ず次を行うこと:
"
	if [ -f "$state_file" ]; then
		local saved_at
		saved_at=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$state_file" 2>/dev/null)
		msg+="1. 状態ファイル $state_file を Read する（保存: ${saved_at:-不明}）。
   「判断ログ」（採用案・却下案・却下理由）と「復旧メモ」を最優先で復元すること。
   末尾の『ユーザー指示の原文』appendix は判断に迷ったときだけ参照する
   （全文を長々とチャットへ展開しない・圧縮効果を打ち消さない）。
2. 現在フェーズ・制約・バックグラウンドタスク構成を状態ファイルの記載どおりに再確認すること。
3. 圧縮サマリーが示す『次の一手』は仮説として扱い、状態ファイル・plan・TaskList と
   照合が取れてから動くこと（食い違えば状態ファイルを正とする）。
   保存日時が古い場合はその旨をユーザーに一言添えること。"
	else
		msg+="1. 状態ファイルは無い（保存を経ない自動圧縮の可能性が高い）。
2. 圧縮サマリーが示す『次の一手』は仮説として扱うこと。判断根拠・却下済みの案・
   現在フェーズに少しでも不確かさがあれば、勝手に進めずユーザーに一言確認すること。"
	fi
	if [ -f "$dump_file" ]; then
		msg+="
補助: 圧縮直前の生ログ退避が $dump_file にある。個別の事実確認が必要なときだけ
   grep 等で部分参照する（全文 Read は禁止・コンテキストを再び膨らませない）。"
	fi
	printf '%s' "$msg"
}

# 注入して通し番号を記録する。$1=イベント名 $2=現在の境界数（-1=不明）
inject() {
	local event_name="$1" cur="$2"
	local ctx
	ctx=$(build_context)
	"$JQ" -n --arg ev "$event_name" --arg ctx "$ctx" \
		'{hookSpecificOutput: {hookEventName: $ev, additionalContext: $ctx}}' 2>/dev/null
	if [ "$cur" -ge 0 ]; then
		printf '%s' "$cur" >"$restored_f" 2>/dev/null
	fi
	rm -f "$marker" 2>/dev/null
	log_ev "event=$event_name sid=$sid action=inject boundary=$cur state_file=$([ -f "$state_file" ] && echo yes || echo no)"
}

case "$event" in
	SessionStart)
		src=$(printf '%s' "$input" | "$JQ" -r '.source // empty' 2>/dev/null)
		[ "$src" = "compact" ] || exit 0
		cur=$(boundary_count)
		if [ "$cur" -ge 0 ] && [ "$cur" -le "$(restored_count)" ]; then
			# この境界は復旧済み（保険経路が先に処理したケース）
			rm -f "$marker" 2>/dev/null
			log_ev "event=SessionStart sid=$sid action=skip-already-restored boundary=$cur"
			exit 0
		fi
		inject "SessionStart" "$cur"
		;;
	UserPromptSubmit)
		[ -f "$marker" ] || exit 0
		cur=$(boundary_count)
		if [ "$cur" -ge 0 ] && [ "$cur" -le "$(restored_count)" ]; then
			# 主経路（SessionStart[compact]）が復旧済み。印だけ回収して沈黙。
			rm -f "$marker" 2>/dev/null
			log_ev "event=UserPromptSubmit sid=$sid action=skip-already-restored boundary=$cur"
			exit 0
		fi
		inject "UserPromptSubmit" "$cur"
		;;
	*)
		exit 0
		;;
esac

exit 0
