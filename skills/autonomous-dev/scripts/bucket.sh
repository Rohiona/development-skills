#!/usr/bin/env bash
# bucket.sh — autonomous-dev の run bucket 管理（state.json が唯一の正）
#
# 工程間の成果物受け渡しと、Workflow/サブエージェントが人間に質問できない制約の
# 回避機構の中核。停止理由は escalations.jsonl に追記し、メインループが読んで
# AskUserQuestion → 回答を書き戻して再開する。
#
# Usage:
#   bucket.sh init <feature>                 -> design_doc/<feature>/autodev/<run_id>/ を作成し run_dir を出力
#   bucket.sh path <feature> <run_id>        -> run_dir を出力
#   bucket.sh read <run_dir> [jq_filter]     -> state.json 全体（or jq フィルタ結果）を出力
#   bucket.sh write <run_dir> <key> <value>  -> state.json の top-level key を設定（value は JSON か文字列）
#   bucket.sh gate  <run_dir> <name> <json>  -> state.json .gates[name] にゲート結果 JSON を記録
#   bucket.sh escalate <run_dir> <reason> [options_json]
#                                            -> escalations.jsonl に追記し .stopped=true にする
#   bucket.sh answer <run_dir> <answer>      -> 最新 escalation の answer を埋め .stopped=false に戻す
#   bucket.sh phase <feature_dir> <run_dir> <stage> <status> [handoff]
#                                            -> state.json（.stage/.phase）と feature_dir/manifest.json
#                                               （phases.*/current_phase）を同時更新（二重簿記の機械化）。
#                                               stage: requirements|design|implement|gate|review|fix|reverify|reconcile|pr
#                                               manifest へ反映されるのは requirements/design/implement/review/pr のみ
#                                               （gate/fix/reverify/reconcile は run 内部＝state.json のみ）
#
# 依存: jq （JS monorepo 前提。jq が無ければ明示エラー）
set -uo pipefail

REPO_ROOT="${AUTODEV_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CMD="${1:-}"; shift 2>/dev/null || true

need_jq() { command -v jq >/dev/null 2>&1 || { echo "ERROR: jq が必要です（brew install jq）" >&2; exit 3; }; }
state() { echo "$1/state.json"; }

case "$CMD" in
	init)
		FEATURE="${1:?ERROR: feature 名が必要}"
		RUN_ID="$(date +%Y%m%d-%H%M%S)"
		RUN_DIR="$REPO_ROOT/design_doc/$FEATURE/autodev/$RUN_ID"
		need_jq
		mkdir -p "$RUN_DIR"
		jq -n --arg f "$FEATURE" --arg r "$RUN_ID" \
			'{feature:$f, run_id:$r, phase:"requirements", stage:"0-scan", stopped:false, approvals:{requirements:false, design:false}, gates:{}, iterations:{}, escalations:0}' \
			> "$(state "$RUN_DIR")"
		: > "$RUN_DIR/escalations.jsonl"
		echo "$RUN_DIR" ;;
	path)
		FEATURE="${1:?}"; RUN_ID="${2:?}"
		echo "$REPO_ROOT/design_doc/$FEATURE/autodev/$RUN_ID" ;;
	read)
		RUN_DIR="${1:?ERROR: run_dir が必要}"; FILTER="${2:-.}"
		need_jq
		jq -r "$FILTER" "$(state "$RUN_DIR")" ;;
	write)
		RUN_DIR="${1:?}"; KEY="${2:?}"; VALUE="${3:?}"
		need_jq
		TMP="$(mktemp)"
		if echo "$VALUE" | jq -e . >/dev/null 2>&1; then
			jq --argjson v "$VALUE" ".${KEY} = \$v" "$(state "$RUN_DIR")" > "$TMP"
		else
			jq --arg v "$VALUE" ".${KEY} = \$v" "$(state "$RUN_DIR")" > "$TMP"
		fi
		mv "$TMP" "$(state "$RUN_DIR")"; echo ok ;;
	gate)
		RUN_DIR="${1:?}"; NAME="${2:?}"; GJSON="${3:?}"
		need_jq
		TMP="$(mktemp)"
		jq --arg n "$NAME" --argjson g "$GJSON" '.gates[$n] = $g' "$(state "$RUN_DIR")" > "$TMP"
		mv "$TMP" "$(state "$RUN_DIR")"; echo ok ;;
	escalate)
		RUN_DIR="${1:?}"; REASON="${2:?}"; OPTS="${3:-[]}"
		need_jq
		TS="$(date +%Y-%m-%dT%H:%M:%S)"
		jq -nc --arg ts "$TS" --arg r "$REASON" --argjson o "$OPTS" \
			'{ts:$ts, reason:$r, options:$o, answer:null}' >> "$RUN_DIR/escalations.jsonl"
		TMP="$(mktemp)"
		jq '.stopped = true | .escalations = (.escalations + 1)' "$(state "$RUN_DIR")" > "$TMP"
		mv "$TMP" "$(state "$RUN_DIR")"; echo escalated ;;
	answer)
		RUN_DIR="${1:?}"; ANS="${2:?}"
		need_jq
		# escalations.jsonl の最終行（answer:null）に回答を埋める
		EJL="$RUN_DIR/escalations.jsonl"
		TMP="$(mktemp)"
		awk 'NR>1{print prev} {prev=$0} END{exit 0}' "$EJL" > "$TMP" 2>/dev/null || true
		LAST="$(tail -n 1 "$EJL")"
		echo "$LAST" | jq -c --arg a "$ANS" '.answer = $a' >> "$TMP"
		mv "$TMP" "$EJL"
		TMP2="$(mktemp)"
		jq '.stopped = false' "$(state "$RUN_DIR")" > "$TMP2"; mv "$TMP2" "$(state "$RUN_DIR")"
		echo answered ;;
	phase)
		FEATURE_DIR="${1:?ERROR: feature_dir が必要}"; RUN_DIR="${2:?ERROR: run_dir が必要}"
		STAGE="${3:?ERROR: stage が必要}"; STATUS="${4:?ERROR: status が必要}"; HANDOFF="${5:-}"
		need_jq
		# state.json 側（run の実行制御）
		TMP="$(mktemp)"
		jq --arg s "$STAGE" '.stage = $s | .phase = $s' "$(state "$RUN_DIR")" > "$TMP"
		mv "$TMP" "$(state "$RUN_DIR")"
		# manifest.json 側（成果物の進行）。run 内部ステージは反映しない
		case "$STAGE" in
			requirements) MP="requirements" ;;
			design)       MP="design" ;;
			implement)    MP="implementation" ;;
			review)       MP="review-all" ;;
			pr)           MP="create-pr" ;;
			*)            MP="" ;;
		esac
		if [ -n "$MP" ]; then
			MANIFEST="$FEATURE_DIR/manifest.json"
			if [ ! -f "$MANIFEST" ]; then
				jq -n --arg t "$(basename "$FEATURE_DIR")" '{theme:$t, phases:{}, current_phase:null, next_action:null}' > "$MANIFEST"
			fi
			TMP="$(mktemp)"
			jq --arg mp "$MP" --arg st "$STATUS" --arg h "$HANDOFF" \
				'.phases[$mp] = ((.phases[$mp] // {}) + {status:$st} + (if $h != "" then {handoff:$h} else {} end))
				 | .current_phase = $mp | .current_phase_status = $st' "$MANIFEST" > "$TMP"
			mv "$TMP" "$MANIFEST"
		fi
		echo ok ;;
	*)
		echo "usage: bucket.sh {init|path|read|write|gate|escalate|answer|phase} ..." >&2; exit 2 ;;
esac
