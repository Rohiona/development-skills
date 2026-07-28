#!/usr/bin/env bash
# claude-session-sync.sh — Claude デスクトップアプリのセッション一覧をアカウント間で同期する
#
# 背景:
#   デスクトップアプリはセッション一覧（レジストリ）を
#   ~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
#   にアカウント別で保存する。会話本文（~/.claude/projects/**.jsonl）は全アカウント共有なので、
#   このレジストリ JSON をコピーすれば、アカウント切替後も過去セッションが一覧に現れて再開できる。
#   アプリはこのフォルダを「起動時／アカウント切替時」にしか読まないため、切替の前に実行すること。
#
# 使い方:
#   claude-session-sync.sh                  # 既定: 直前アカウントを正として他アカウントへ完全ミラー
#   claude-session-sync.sh --from <uuid>    # 正とするアカウントを明示指定（前方一致可）
#   claude-session-sync.sh --dry-run        # 何をコピー/削除するか表示だけ（書き込みなし）
#   claude-session-sync.sh --merge          # 旧挙動: 全アカウント間で非アーカイブを双方向マージ
#   claude-session-sync.sh --merge --days 7 # マージ時: 直近7日以内に動いたセッションだけ対象
#
# グループ構造（サイドバーのカスタムグループ）:
#   グループ名・所属・並び順はセッション一覧 JSON ではなくアプリの localStorage
#   （Local Storage/leveldb の dframe-store キー・全アカウント共通1個）に入っており、
#   アカウント切替で作り直されて消えることがある。このため同期実行のたびに
#   スナップショットを ~/.claude/backups/claude-session-groups/ へ自動保存し、
#   控えとズレていれば書き戻しも自動で試みる（アプリ起動中は書き戻しのみスキップ、
#   一致していれば何も書かない）。
#   claude-session-sync.sh --show-groups     # 現在のグループ構造を表示
#   claude-session-sync.sh --restore-groups  # 明示的に書き戻す（アプリ完全終了後に実行）
#   claude-session-sync.sh --restore-groups --dry-run   # 書き戻し結果の事前確認
set -euo pipefail

GROUPS_HELPER="$HOME/.claude/scripts/claude-session-groups/index.mjs"
case "${1:-}" in
	--show-groups) shift; exec node "$GROUPS_HELPER" show "$@" ;;
	--restore-groups) shift; exec node "$GROUPS_HELPER" restore "$@" ;;
esac

BASE="${CLAUDE_SESSION_SYNC_BASE:-$HOME/Library/Application Support/Claude/claude-code-sessions}"
CONFIG="${CLAUDE_SESSION_SYNC_CONFIG:-$HOME/Library/Application Support/Claude/config.json}"
BACKUP_ROOT="${CLAUDE_SESSION_SYNC_BACKUP:-$HOME/.claude/backups/claude-session-sync}"

MODE=mirror
FROM_OVERRIDE=""
DRY=0
DAYS=0

while [ $# -gt 0 ]; do
	case "$1" in
		--merge) MODE=merge ;;
		--from)
			shift
			FROM_OVERRIDE="${1:?"--from には UUID または前方一致文字列が必要です"}"
			;;
		--dry-run) DRY=1 ;;
		--days)
			shift
			DAYS="${1:-0}"
			;;
		*) echo "unknown option: $1" >&2; exit 1 ;;
	esac
	shift
done

if [ ! -d "$BASE" ]; then
	echo "セッション保存フォルダが見つかりません: $BASE" >&2
	exit 1
fi

# --- 共通ヘルパ ---

get_session_label() {
	local f="$1"
	local label
	label=$(jq -r '(.title // empty)' "$f")
	[ -n "$label" ] || label=$(jq -r '(.cwd // "?") | split("/") | last' "$f")
	echo "$label"
}

abbrev_acct() {
	local acct="$1"
	if [ "${#acct}" -gt 8 ]; then
		echo "${acct:0:8}…"
	else
		echo "$acct"
	fi
}

get_leaf_max_activity() {
	local leaf="$1"
	local max=0
	local f last
	for f in "$leaf"/local_*.json; do
		[ -e "$f" ] || continue
		last=$(jq -r '.lastActivityAt // 0' "$f")
		if [ "${last%.*}" -gt "$max" ]; then
			max="${last%.*}"
		fi
	done
	echo "$max"
}

# --- mirror モード用 ---

resolve_source_account() {
	if [ -n "$FROM_OVERRIDE" ]; then
		local matches=()
		local d acct
		for d in "$BASE"/*/; do
			[ -d "$d" ] || continue
			acct=$(basename "$d")
			if [[ "$acct" == "$FROM_OVERRIDE"* ]]; then
				matches+=("$acct")
			fi
		done
		if [ "${#matches[@]}" -eq 0 ]; then
			echo "エラー: --from の前方一致に該当するアカウントがありません: $FROM_OVERRIDE" >&2
			exit 1
		fi
		if [ "${#matches[@]}" -gt 1 ]; then
			echo "エラー: --from の前方一致が複数アカウントにマッチしました: ${matches[*]}" >&2
			exit 1
		fi
		echo "${matches[0]}"
	else
		if [ ! -f "$CONFIG" ]; then
			echo "エラー: config.json が見つかりません: $CONFIG" >&2
			echo "--from で正とするアカウントを指定してください" >&2
			exit 1
		fi
		local uuid
		uuid=$(jq -r '.lastKnownAccountUuid // empty' "$CONFIG")
		if [ -z "$uuid" ]; then
			echo "エラー: lastKnownAccountUuid が設定されていません" >&2
			echo "--from で正とするアカウントを指定してください" >&2
			exit 1
		fi
		echo "$uuid"
	fi
}

pick_source_leaf() {
	local acct="$1"
	local acct_leaves=()
	local d
	while IFS= read -r d; do
		acct_leaves+=("$d")
	done < <(find "$BASE/$acct" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

	if [ "${#acct_leaves[@]}" -eq 0 ]; then
		echo "エラー: 正アカウントに org リーフがありません: $acct" >&2
		exit 1
	fi

	if [ "${#acct_leaves[@]}" -eq 1 ]; then
		echo "${acct_leaves[0]}"
		return
	fi

	local best_leaf="" best_max=0 leaf max_act org
	for leaf in "${acct_leaves[@]}"; do
		max_act=$(get_leaf_max_activity "$leaf")
		if [ "$max_act" -gt "$best_max" ]; then
			best_max=$max_act
			best_leaf=$leaf
		fi
	done
	org="${best_leaf#"$BASE/$acct/"}"
	echo "正アカウントの org リーフを選択: ${org}（lastActivityAt 最大）" >&2
	echo "$best_leaf"
}

prune_deleted_backups() {
	[ -d "$BACKUP_ROOT" ] || return 0
	local dirs=() d i=0
	while IFS= read -r d; do
		dirs+=("$d")
	done < <(find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'deleted-*' 2>/dev/null | sort -r)
	# bash 3.2 は set -u で空配列の展開に失敗するため先に抜ける
	[ "${#dirs[@]}" -eq 0 ] && return 0
	for d in "${dirs[@]}"; do
		i=$((i + 1))
		if [ "$i" -gt 20 ]; then
			rm -rf "$d"
		fi
	done
}

mirror_leaf() {
	local src_leaf="$1"
	local dst_leaf="$2"
	local dst_acct="$3"
	local updated=0 unchanged=0 deleted=0
	local f name label backup_dest
	local -a deleted_lines=()

	for f in "$src_leaf"/local_*.json; do
		[ -e "$f" ] || continue
		name=$(basename "$f")
		if [ -e "$dst_leaf/$name" ] && cmp -s "$f" "$dst_leaf/$name"; then
			unchanged=$((unchanged + 1))
		else
			if [ "$DRY" -eq 0 ]; then
				cp "$f" "$dst_leaf/$name"
			fi
			updated=$((updated + 1))
		fi
	done

	for f in "$dst_leaf"/local_*.json; do
		[ -e "$f" ] || continue
		name=$(basename "$f")
		if [ -e "$src_leaf/$name" ]; then
			continue
		fi
		label=$(get_session_label "$f")
		if [ "$DRY" -eq 1 ]; then
			deleted=$((deleted + 1))
			deleted_lines+=("  deleted: $name ($label)")
		else
			backup_dest="$DELETE_BACKUP_DIR/$dst_acct/$name"
			mkdir -p "$(dirname "$backup_dest")"
			if cp "$f" "$backup_dest"; then
				rm "$f"
				deleted=$((deleted + 1))
				deleted_lines+=("  deleted: $name ($label)")
			else
				echo "警告: 退避に失敗したため削除をスキップ: $name ($label)" >&2
			fi
		fi
	done

	MIRROR_UPDATED=$((MIRROR_UPDATED + updated))
	MIRROR_UNCHANGED=$((MIRROR_UNCHANGED + unchanged))
	MIRROR_DELETED=$((MIRROR_DELETED + deleted))
	if [ "${#deleted_lines[@]}" -gt 0 ]; then
		MIRROR_DELETED_LINES+=("${deleted_lines[@]}")
	fi
}

run_mirror() {
	if [ "$DAYS" -gt 0 ]; then
		echo "エラー: --days は --merge 専用です" >&2
		exit 1
	fi

	local src_acct src_source
	src_acct=$(resolve_source_account)
	if [ ! -d "$BASE/$src_acct" ]; then
		echo "エラー: 正とするアカウントのフォルダが見つかりません: $src_acct" >&2
		echo "--from で指定してください" >&2
		exit 1
	fi

	local src_source_label="lastKnownAccountUuid"
	if [ -n "$FROM_OVERRIDE" ]; then
		src_source_label="--from"
	fi
	echo "正: ${src_acct}（${src_source_label}）"

	local src_leaf
	src_leaf=$(pick_source_leaf "$src_acct")

	# 他アカウントが無ければ終了
	local accounts=() acct d
	for d in "$BASE"/*/; do
		[ -d "$d" ] || continue
		acct=$(basename "$d")
		[ "$acct" = "$src_acct" ] && continue
		accounts+=("$acct")
	done
	if [ "${#accounts[@]}" -eq 0 ]; then
		echo "他アカウントがないためミラー不要です"
		exit 0
	fi

	DELETE_BACKUP_DIR=""
	if [ "$DRY" -eq 0 ]; then
		DELETE_BACKUP_DIR="$BACKUP_ROOT/deleted-$(date +%Y%m%d-%H%M%S)"
	fi

	local dst_acct dst_leaf
	for dst_acct in "${accounts[@]}"; do
		MIRROR_UPDATED=0
		MIRROR_UNCHANGED=0
		MIRROR_DELETED=0
		MIRROR_DELETED_LINES=()

		while IFS= read -r dst_leaf; do
			mirror_leaf "$src_leaf" "$dst_leaf" "$dst_acct"
		done < <(find "$BASE/$dst_acct" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

		echo "→ $(abbrev_acct "$dst_acct"): 更新 $MIRROR_UPDATED / 変更なし $MIRROR_UNCHANGED / 削除 $MIRROR_DELETED"
		if [ "${#MIRROR_DELETED_LINES[@]}" -gt 0 ]; then
			printf '%s\n' "${MIRROR_DELETED_LINES[@]}"
		fi
	done

	if [ "$DRY" -eq 0 ] && [ -n "$DELETE_BACKUP_DIR" ]; then
		prune_deleted_backups
		if [ -d "$DELETE_BACKUP_DIR" ]; then
			echo "削除分の退避先: $DELETE_BACKUP_DIR/"
		fi
	fi

	if [ "$DRY" -eq 0 ]; then
		echo "反映はアプリの再起動またはアカウント切替後です。"
	fi
}

# --- merge モード用（旧挙動） ---

run_merge() {
	local leaves=()
	while IFS= read -r d; do
		leaves+=("$d")
	done < <(find "$BASE" -mindepth 2 -maxdepth 2 -type d | sort)

	if [ "${#leaves[@]}" -lt 2 ]; then
		echo "アカウントのフォルダが1つしかないため同期不要です（${#leaves[@]}個検出）" >&2
		exit 0
	fi

	local now_ms=$(( $(date +%s) * 1000 ))
	local cutoff_ms=0
	if [ "$DAYS" -gt 0 ]; then
		cutoff_ms=$(( now_ms - DAYS * 86400000 ))
	fi

	local copied=0 skipped_arch=0 skipped_old=0 skipped_uptodate=0
	local src dst src_acct dst_acct f name arch last dst_last label

	for src in "${leaves[@]}"; do
		for dst in "${leaves[@]}"; do
			[ "$src" = "$dst" ] && continue
			src_acct="${src#"$BASE"/}"; src_acct="${src_acct%%/*}"
			dst_acct="${dst#"$BASE"/}"; dst_acct="${dst_acct%%/*}"
			[ "$src_acct" = "$dst_acct" ] && continue

			for f in "$src"/local_*.json; do
				[ -e "$f" ] || continue
				name=$(basename "$f")
				arch=$(jq -r '.isArchived // false' "$f")
				last=$(jq -r '.lastActivityAt // 0' "$f")
				if [ "$arch" = "true" ]; then
					skipped_arch=$((skipped_arch + 1)); continue
				fi
				if [ "$cutoff_ms" -gt 0 ] && [ "${last%.*}" -lt "$cutoff_ms" ]; then
					skipped_old=$((skipped_old + 1)); continue
				fi
				if [ -e "$dst/$name" ]; then
					dst_last=$(jq -r '.lastActivityAt // 0' "$dst/$name")
					if [ "${dst_last%.*}" -ge "${last%.*}" ]; then
						skipped_uptodate=$((skipped_uptodate + 1)); continue
					fi
				fi
				label=$(get_session_label "$f")
				if [ "$DRY" -eq 1 ]; then
					echo "[dry-run] $name ($label) -> $dst_acct"
				else
					cp "$f" "$dst/$name"
					echo "copied: $name ($label) -> $dst_acct"
				fi
				copied=$((copied + 1))
			done
		done
	done

	echo "---"
	echo "対象 ${copied} 件（アーカイブ除外 ${skipped_arch} / 期間外 ${skipped_old} / 送り先が最新 ${skipped_uptodate}）"
	if [ "$DRY" -eq 0 ] && [ "$copied" -gt 0 ]; then
		echo "反映はアプリの再起動またはアカウント切替後です。"
	fi
}

# --- メイン分岐 ---

case "$MODE" in
	mirror) run_mirror ;;
	merge)  run_merge ;;
esac

# グループ構造のスナップショットを自動保存し、必要なら書き戻しまで自動で試みる
# （アプリ起動中は書き戻しだけ自動スキップ。失敗しても同期自体は成功扱い）
if [ "$DRY" -eq 0 ] && [ -f "$GROUPS_HELPER" ] && command -v node >/dev/null 2>&1; then
	echo "---"
	node "$GROUPS_HELPER" backup || echo "（グループ構造のバックアップに失敗しました。同期は完了しています）" >&2
	node "$GROUPS_HELPER" restore --if-unlocked || echo "（グループの書き戻しに失敗しました。--restore-groups で個別に再実行できます）" >&2
fi
