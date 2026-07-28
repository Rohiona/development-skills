#!/usr/bin/env bash
# review-worktree-clean.sh
# レビュー用に切ったワークツリー/ブランチを一括削除する（「レビューのワークツリーお掃除して」トリガー用）。
#
# 削除対象は次の2つだけ。これ以外（feat/ fix/ verify/ investigate/ chore/ 等）には絶対に触らない:
#   - ワークツリー: パスが .claude/worktrees/review/ 配下のもの
#   - ブランチ    : review/* および claude/review/*
#
# 使い方:
#   review-worktree-clean.sh            実削除（review スコープに限定して強制削除 → prune）
#   review-worktree-clean.sh --dry-run  削除せず対象一覧だけ表示（-n も可）
#
# 注意: レビュー用ワークツリーは「見るための使い捨て」前提のため --force で消す
#       （中の未コミット差分は破棄される）。恒久作業をここに置かないこと。
set -uo pipefail

DRY=0
case "${1:-}" in
	--dry-run | -n) DRY=1 ;;
	"") ;;
	*) echo "unknown arg: $1 (use --dry-run)"; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "git リポジトリ内で実行してください"; exit 1; }
cd "$ROOT" || exit 1

echo "== レビュー用ワークツリーの掃除 =="
[ "$DRY" = 1 ] && echo "(dry-run: 実際には削除しません)"

# 1) review 用ワークツリー
found_wt=0
while IFS= read -r wt; do
	[ -z "$wt" ] && continue
	found_wt=1
	echo "- worktree: $wt"
	[ "$DRY" = 1 ] || git worktree remove --force "$wt"
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep '/.claude/worktrees/review/')
[ "$found_wt" = 0 ] && echo "- 削除対象のワークツリーなし"

# 2) review 用ブランチ
found_br=0
while IFS= read -r br; do
	[ -z "$br" ] && continue
	found_br=1
	echo "- branch: $br"
	[ "$DRY" = 1 ] || git branch -D "$br"
done < <(git branch --list 'review/*' 'claude/review/*' | sed 's/^[+*]* *//')
[ "$found_br" = 0 ] && echo "- 削除対象のブランチなし"

# 3) 登録の掃除
[ "$DRY" = 1 ] || git worktree prune

echo "== 完了 =="
