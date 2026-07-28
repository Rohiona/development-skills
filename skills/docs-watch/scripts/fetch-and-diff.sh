#!/bin/bash
# docs-watch: 1ソースを取得し、前回スナップショットとハッシュ比較する。
# 本文をチャットのコンテキストに載せないための機械前処理（token-economy 準拠）。
#
# 使い方:
#   fetch-and-diff.sh <id> <url>     取得・比較。出力は状態行 + 変更時のみ diff（先頭300行）
#   fetch-and-diff.sh --commit <id>  分析完了後にスナップショットを確定（.new を昇格）
#
# 状態行:
#   FIRST_FETCH <id>   初回取得（スナップショット作成のみ・diff なし）
#   UNCHANGED <id>     ハッシュ一致（本文・diff は一切出力しない）
#   CHANGED <id>       変更あり。unified diff を続けて出力。全文 diff は snapshots/<id>.diff
#   FETCH_ERROR <id>   取得失敗（exit 2）
#
# CHANGED 時はスナップショットを直接更新せず <id>.md.new / <id>.meta.new に置く。
# 提案レポートの作成が済んでから --commit で確定する（分析前に前回状態を失わないため）。
set -u

BASE="$HOME/.claude/docs-watch"
SNAPDIR="$BASE/snapshots"
mkdir -p "$SNAPDIR"

if [ "${1:-}" = "--commit" ]; then
	ID="${2:?--commit には <id> が必要}"
	if [ ! -f "$SNAPDIR/$ID.md.new" ]; then
		echo "NOTHING_TO_COMMIT $ID (.new がありません)"
		exit 1
	fi
	mv "$SNAPDIR/$ID.md.new" "$SNAPDIR/$ID.md"
	mv "$SNAPDIR/$ID.meta.new" "$SNAPDIR/$ID.meta"
	rm -f "$SNAPDIR/$ID.diff"
	echo "COMMITTED $ID"
	exit 0
fi

ID="${1:?使い方: fetch-and-diff.sh <id> <url>}"
URL="${2:?使い方: fetch-and-diff.sh <id> <url>}"
SNAP="$SNAPDIR/$ID.md"
META="$SNAPDIR/$ID.meta"
TMP="$(mktemp)"
TMPRAW="$(mktemp)"
trap 'rm -f "$TMP" "$TMPRAW"' EXIT

if ! curl -sL --max-time 60 -A "Mozilla/5.0" "$URL" -o "$TMPRAW"; then
	echo "FETCH_ERROR $ID (curl 失敗)"
	exit 2
fi

# HTML なら macOS 標準の textutil でテキスト化。生 Markdown/テキストはそのまま
if head -c 512 "$TMPRAW" | command grep -qi '<!DOCTYPE\|<html'; then
	if ! textutil -convert txt -stdout "$TMPRAW" > "$TMP" 2>/dev/null; then
		echo "FETCH_ERROR $ID (textutil 失敗)"
		exit 2
	fi
else
	cp "$TMPRAW" "$TMP"
fi

if [ ! -s "$TMP" ]; then
	echo "FETCH_ERROR $ID (空レスポンス)"
	exit 2
fi

NEW_HASH=$(shasum -a 256 "$TMP" | cut -d' ' -f1)
NOW=$(date '+%Y-%m-%d %H:%M:%S')

if [ ! -f "$SNAP" ]; then
	cp "$TMP" "$SNAP"
	printf 'fetched_at=%s\nsha256=%s\nurl=%s\n' "$NOW" "$NEW_HASH" "$URL" > "$META"
	echo "FIRST_FETCH $ID"
	exit 0
fi

# 比較の正本はスナップショットファイル自体（meta の sha256 は記録用）
OLD_HASH=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
if [ "$NEW_HASH" = "$OLD_HASH" ]; then
	echo "UNCHANGED $ID"
	exit 0
fi

echo "CHANGED $ID"
diff -u "$SNAP" "$TMP" > "$SNAPDIR/$ID.diff" || true
TOTAL=$(wc -l < "$SNAPDIR/$ID.diff" | tr -d ' ')
head -300 "$SNAPDIR/$ID.diff"
if [ "$TOTAL" -gt 300 ]; then
	echo "... [diff 全 ${TOTAL} 行のうち先頭 300 行のみ表示。全文: $SNAPDIR/$ID.diff]"
fi
cp "$TMP" "$SNAP.new"
printf 'fetched_at=%s\nsha256=%s\nurl=%s\n' "$NOW" "$NEW_HASH" "$URL" > "$META.new"
exit 0
