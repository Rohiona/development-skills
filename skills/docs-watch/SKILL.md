---
name: docs-watch
description: |
  公式ドキュメント（Fable 5 プロンプトガイド・Claude Code ベストプラクティス等）の見回り。
  前回スナップショットとの差分を検知し、変更があった部分だけを現環境（~/.claude の CLAUDE.md・rules・agents・skills）と
  突き合わせて「取り込み提案レポート」を作る。
  トリガー: 「/docs-watch」「ドキュメントの見回り」「公式ドキュメントの更新チェック」等。
  定期タスク docs-watch-weekly からも同一手順で起動される。
argument-hint: "[特定ソースの id（省略時は全件）]"
---

# docs-watch: 公式ドキュメント見回り

## 絶対的ゲート（緩めない）

1. **~/.claude 配下の設定への取り込み（書き込み）は絶対に自動でやらない**。このスキルの成果物は提案レポートまで。反映は閣下承認後の別作業
2. **却下済みの案を再提案しない**。`~/.claude/docs-watch/decisions.jsonl` の `verdict: rejected` に該当する提案は本文から除外し、レポート末尾に「却下済みのため非提案」として1行だけ記録する
3. **ページ本文をコンテキストに載せない**（token-economy 準拠）。取得・比較は必ず `scripts/fetch-and-diff.sh` 経由で行い、受け取るのは状態行と diff だけ。UNCHANGED のソースについて本文を Read しない

## データ

- 監視対象: `~/.claude/docs-watch/watchlist.json`
- スナップショット: `~/.claude/docs-watch/snapshots/<id>.md` / `<id>.meta`
- 採用/却下履歴: `~/.claude/docs-watch/decisions.jsonl`
  形式: `{"date","source","item","verdict":"adopted|rejected|deferred","reason"}`
- レポート: `~/.claude/docs-watch/reports/YYYY-MM-DD.md`

## 手順

1. `watchlist.json` を Read する（引数で id 指定があればそのソースだけ対象にする）
2. 各ソースについて `bash ~/.claude/skills/docs-watch/scripts/fetch-and-diff.sh <id> <url>` を実行する
   - `UNCHANGED` / `FIRST_FETCH` → そのソースは終了
   - `FETCH_ERROR` → URL 失効の可能性。レポート（または1行報告）に「取得失敗・要 watchlist 確認」と記録する。黙って飛ばさない
   - `CHANGED` → 出力された diff を分析対象にする（300行超は全文が `snapshots/<id>.diff` にある）
3. **全件 UNCHANGED/FIRST_FETCH なら**: チャットに1行（例: 「4件とも変更なし」）報告して終了。レポートファイルは作らない
4. **CHANGED があれば**: 変更部分だけを現環境と突き合わせる
   - 照合先: `~/.claude/CLAUDE.md`・`~/.claude/rules/common/*.md`・`~/.claude/agents/`・`~/.claude/skills/` の該当箇所（diff の論点に関係する箇所だけ読む）
   - `decisions.jsonl` を Read し、採用済み（対応済みなので提案不要）と却下済み（ゲート2）を除外する
   - CHANGELOG の差分は新バージョン追記が主。設定・運用に影響のある変更（新機能・非互換・非推奨化）だけ提案対象にする
5. 提案があれば `references/report-template.md` の形式で `reports/YYYY-MM-DD.md` に書く。チャットには要約（提案件数と1行ずつの見出し）とレポートのパスだけ返す
6. レポート作成が済んだら（提案ゼロで終わる場合も）各 CHANGED ソースを `fetch-and-diff.sh --commit <id>` で確定する
7. 閣下が提案を承認/却下したら、その結果を `decisions.jsonl` に追記する（このスキルの次回実行が正しく除外できるように。reason 必須）

## 報告の規律

- 提案には必ず「ガイドのどの記述か（引用1〜2文）」「現環境のどこと食い違うか（file:line）」「推測を含むなら推測ラベル」を付ける（epistemic-honesty 準拠）
- 定期実行（新規セッション）でもこの SKILL.md と上記ゲートが正本。会話文脈に依存しない
