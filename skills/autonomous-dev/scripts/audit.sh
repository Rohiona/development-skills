#!/usr/bin/env bash
# audit.sh — autonomous-dev の完了条件を機械検証する（散文の「自己監査」の置換）
#
# PR に進む前の最終ゲート。俺様バイパス（成果物欠落・未承認・赤ゲート・レビュー未GO）を
# 構造的に検出する。全チェック PASS で exit 0、1つでも FAIL なら exit 1。
#
# Usage:
#   audit.sh <feature_dir> <run_dir>
#     feature_dir: design_doc/{機能名}（俺様成果物の置き場所）
#     run_dir:     {feature_dir}/autodev/{run_id}（state.json の置き場所）
#
# 出力: 最終行に 1 行 JSON:
#   {"audit":"pass|fail","checks":{...},"missing":["<FAILしたチェック名>", ...]}
#
# チェック内容（完了条件の正本。SKILL.md はここを指すだけ）:
#   requirements_md        requirements.md が存在（人間承認の対象・verbose）
#   requirements_distilled requirements/requirements.json が存在（下流の引き渡し）
#   design_md              design/architecture.md が存在（承認済み設計・verbose）
#   design_distilled       design/context.json が存在（実装の引き渡し）
#   impl_distilled         implementation/context.json が存在（レビュー/PR の引き渡し）
#   approval_requirements  state.json .approvals.requirements == true（★人間承認）
#   approval_design        state.json .approvals.design == true（★人間承認）
#   gates_green            state.json .gates_effective.green == true（マスク後の実効判定・優先）
#                          または .gates が 1 件以上あり全て green
#   review_go              state.json .review.verdict == "GO"（review-all の判定を記録済み）
#   review_report          reviews/comprehensive-review-*.md が 1 件以上存在
#   manifest_consistent    manifest.json の phases.implementation と phases["review-all"] が completed
set -uo pipefail

FEATURE_DIR="${1:?usage: audit.sh <feature_dir> <run_dir>}"
RUN_DIR="${2:?usage: audit.sh <feature_dir> <run_dir>}"
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq が必要です" >&2; exit 3; }

STATE="$RUN_DIR/state.json"
MANIFEST="$FEATURE_DIR/manifest.json"

CHECKS="{}"
set_check() { # name bool
	CHECKS=$(jq -c --arg n "$1" --argjson v "$2" '.[$n] = $v' <<<"$CHECKS")
}
file_check() { # name path
	if [ -f "$2" ]; then set_check "$1" true; else set_check "$1" false; fi
}

file_check requirements_md        "$FEATURE_DIR/requirements.md"
file_check requirements_distilled "$FEATURE_DIR/requirements/requirements.json"
file_check design_md              "$FEATURE_DIR/design/architecture.md"
file_check design_distilled       "$FEATURE_DIR/design/context.json"
file_check impl_distilled         "$FEATURE_DIR/implementation/context.json"

if [ -f "$STATE" ]; then
	AR=$(jq -r '.approvals.requirements == true' "$STATE" 2>/dev/null || echo false)
	AD=$(jq -r '.approvals.design == true' "$STATE" 2>/dev/null || echo false)
	# 実効判定（gates_effective: 変更ファイル外の既存エラーをマスクした後の判定）があればそれを優先。
	# 無ければ生の .gates 全緑を要求
	GG=$(jq -r '(.gates_effective.green == true) or ((.gates | length > 0) and ([.gates[] | .green] | all))' "$STATE" 2>/dev/null || echo false)
	RG=$(jq -r '.review.verdict == "GO"' "$STATE" 2>/dev/null || echo false)
else
	AR=false; AD=false; GG=false; RG=false
fi
set_check approval_requirements "$AR"
set_check approval_design "$AD"
set_check gates_green "$GG"
set_check review_go "$RG"

if ls "$FEATURE_DIR"/reviews/comprehensive-review-*.md >/dev/null 2>&1; then
	set_check review_report true
else
	set_check review_report false
fi

if [ -f "$MANIFEST" ]; then
	MC=$(jq -r '(.phases.implementation.status == "completed") and (.phases["review-all"].status == "completed")' "$MANIFEST" 2>/dev/null || echo false)
else
	MC=false
fi
set_check manifest_consistent "$MC"

MISSING=$(jq -c '[to_entries[] | select(.value == false) | .key]' <<<"$CHECKS")
if [ "$(jq -r 'length' <<<"$MISSING")" -eq 0 ]; then
	jq -nc --argjson c "$CHECKS" '{audit:"pass", checks:$c, missing:[]}'
	exit 0
else
	jq -nc --argjson c "$CHECKS" --argjson m "$MISSING" '{audit:"fail", checks:$c, missing:$m}'
	exit 1
fi
