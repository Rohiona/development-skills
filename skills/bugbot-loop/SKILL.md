---
name: bugbot-loop
description: GitHub PR で Cursor Bugbot のレビュー対応ループ（bugbot run 投稿 → 新規レビュー監視 → 指摘のトリアージ → 修正 or 据え置き承認 → スレッド返信 → LGTM まで継続）を回すスキル。「bugbot を回す/監視して」「Bugbot の指摘に対応して」「LGTM になるまで見て」「bugbot run して結果待って」等で必ず起動し、Cursor Bugbot / cursor[bot] / 「bugbot run」「@cursor review」が絡む PR レビューなら「ループ」と明示されなくても使う。
---

# Bugbot Loop

Cursor Bugbot（GitHub PR 上の `cursor[bot]` レビュアー）の指摘対応を、毎回ハマる定型
（UTCタイムゾーン、本文SHA一致判定、指摘抽出、返信の gh 叩き）を固めて、
LGTM まで安定して回すためのオーケストレーション。

このスキルは**手順と配線**を提供する。**「どこまで直すか」の判断は依頼者の承認**を通す
（自動で直しに走らない）。根本診断は `codex` / `hahifuhe-discuss-review` に委譲してよい。

## いつ使うか

- 「bugbot run して」「Bugbot 回して」「Bugbot の指摘に対応して」「LGTM まで見て」
- PR を作った/更新した後に Bugbot レビューを回収したいとき
- Bugbot の指摘が来ていて、対応方針（直す/据え置く）を決めたいとき

## 前提

- `gh` CLI 認証済み。対象 PR 番号がわかること。リポジトリは cwd の git から自動解決
  （明示する場合は各スクリプトの第2引数 or 環境変数 `BUGBOT_REPO` に `owner/name`）。
- スクリプトは `~/.claude/skills/bugbot-loop/scripts/` 配下。実行属性が無くても
  `bash <script>` で呼べる。

## コアループ（1ラウンド）

```
[0] 現状確認   → latest.sh <PR>            ：最新verdict/対象commitを見る
[1] 起動       → run.sh <PR>               ：PRに "bugbot run" を投稿（要承認・1コメント副作用）
    SINCE=$(現在UTC)  ※run直後のUTCを控える。findings.sh の絞り込みに使う
[2] 監視       → Monitor(watch.sh <PR>)    ：45秒間隔・persistent で新規レビューを待つ
[3] 検知時:
      verdict=LGTM     → ループ停止。TaskStop で監視を止め、依頼者に報告して終了
      verdict=FINDINGS → findings.sh <PR> <SINCE> で個別指摘を抽出 → [4] へ
[4] トリアージ → references/triage.md に従い、根本/到達可能性/副作用/スコープを評価
                必要なら codex / hahifuhe-discuss-review でクロスチェック
                → 依頼者に「直す/据え置く」を提示し承認を得る（AskUserQuestion 等）
[5] 対応:
      直す     → コード修正(+テスト) → 型/lint/テスト green を確認
      据え置く → 設計書の OQ に根治内容と出典(commit/指摘)を明記
[6] 逆おこし   → 設計書(要件/設計)を実装に合わせて更新
[7] commit/push（依頼者が「コミットするな」と言っていないか確認。pre-commit フックで check が走るプロジェクトもある）
[8] 返信       → reply.sh <PR> <comment_id> - <<<'本文' で各指摘スレッドに返信
[9] 再ラウンド → [1] に戻る（コードを変えた場合は新コミットで Bugbot が自動再レビュー、
                変えていない場合は run.sh で明示再起動）
```

LGTM の signal は本文の「found no new issues!」「didn't find」等。`watch.sh` が自動判定し、
LGTM 検知で exit する（Monitor は完了通知を出す）。

## 自動学習（仮想Bugbot へのフィードバック）

新規 FINDINGS を検知した各ラウンド（[3]→[4]）で、**本物 Bugbot の指摘とローカル `/bugbot-review` 出力を同一コミットで突合**し、ローカルが落とした観点（Missed）を仮想Bugbot の **観点集へ自動で蒸留** する。

- 対象コミット: Bugbot レビュー本文の SHA（本文SHA一致判定で確定）。同 SHA のローカル出力は `~/.claude/bugbot-logs/<branch>-<shortsha>.md`。無ければ当該 SHA で `/bugbot-review` を実行して生成。
- 突合 → 全 Missed を生ログ `~/.claude/agents/bugbot-review.cases.jsonl` に追記（provenance）。各 Missed に **実害ゲート**（security/perf/UX/正しさに実害があるか。条件付きでも実害あれば対象）を適用し、通ったもので **観点集 `~/.claude/agents/bugbot-review.lenses.md` を蒸留更新**（既存観点でカバー済みなら追加せず、未カバーなら一般化して新観点を追加。重複追加しない・上限超過で統合提案）。
- **Extra**（ローカル○・本物×）は **レポートのみ**（観点化・抑制しない。生ログには残してよい）。
- 詳細手順（突合・蒸留・上限統合）は `/bugbot-review-retro` と同一。LGTM 到達後に1回回してもよい。
- 目的: PR で出た Bugbot 指摘を仮想Bugbot が次回から先回りで拾い、**PR 上の無駄な往復を逓減**させる。

## スクリプト早見

| 用途 | コマンド |
|---|---|
| 現状の最新verdict確認 | `bash scripts/latest.sh <PR> [owner/name]` |
| bugbot run 投稿 | `bash scripts/run.sh <PR> [owner/name]` |
| 新規レビュー監視(Monitorのcommandに) | `bash scripts/watch.sh <PR> [owner/name] [間隔秒=45] [since(UTC)]` |
| 新規指摘の抽出 | `bash scripts/findings.sh <PR> <since(UTC ISO)> [owner/name]` |
| 指摘スレッドへ返信 | `bash scripts/reply.sh <PR> <comment_id> -` （本文は標準入力） |

監視は Monitor ツールで貼る（このスキル自身は監視ループを持たない）:

```
Monitor(persistent: true, timeout_ms: 300000,
        description: "Bugbot watcher PR#<PR>",
        command: "bash ~/.claude/skills/bugbot-loop/scripts/watch.sh <PR>")
```

`<task-notification>` が届いたら [3] のverdict分岐へ。LGTM なら `TaskStop` で監視を止める。

## 必ず守る罠回避（過去に事故った点）

- **UTCタイムゾーン**: `since`/`created_at` は UTC。ローカル(JST)の壁時計を渡すと未来時刻になり
  「永遠に空振り」する。時刻は必ず `now_utc`(=`date -u`) で作る。スクリプトは内部で UTC を使う。
- **判定はコミットSHAで**: Bugbot レビュー本文に対象コミットSHAが入る。時刻 since だけに頼らず
  「本文に最新コミットSHAを含む cursor[bot] レビュー」で当てると時刻ズレに強い。
- **サマリと個別指摘は別API**: サマリ=`pulls/{n}/reviews`、個別指摘=`pulls/{n}/comments`。
  件数は reviews 本文、内容は comments のインラインから。findings.sh は後者を `created_at` で絞る。
- **ページング必須（取りこぼし事故）**: `gh api .../pulls/{n}/comments`(と `/reviews`) は既定 **30 件/page**。
  `--paginate` を付けないと**1ページ目(古い順)だけ**を見て、新しい Bugbot コメントが後続ページに落ち
  「新規 0 件」と**誤判定**する（過去レビューの実例で場当たり gh を `--paginate` 無しで叩き 2 回事故）。新規探索の
  照会は必ず `gh api --paginate ...`＋上記コミットSHAキーで当てる。場当たり gh でなく本 skill の
  検証済みスクリプト（findings.sh / watch.sh）を使えばこの罠を踏まない。
- **shell堅牢性**: core コマンドは `command` 経由（profile のエイリアス/関数上書き回避）。
  jq のパイプは半角 `|`（全角 `｜` 混入で壊れた実績あり）。
- **空振りを誤判定しない**: 監視が無言＝新規レビューが無いだけのこともある。TaskList に
  Monitor は出ない（別系統）。死活はスクリプト出力で確認する。
- **コミット規約**: 依頼者が「勝手にコミットするな」と言っていれば push 前に必ず確認。

## トリアージの考え方

`references/triage.md` を読んでから判断する。要点:
- 複数指摘が**単一の根本原因**の別レイヤ表出でないか（継ぎ足しパッチを疑う）。
- その不正状態が**通常のデータライフサイクルで到達可能か**を一次情報で検証。
- 直すなら副作用の小さい手段から（表示専用 < 保存直前正規化 < zod/サーバ < open時書換え）。
- 本PRで閉じるか別チケット(OQ)へ切るかを依頼者承認で決め、設計書とBugbotスレッドに記録。
