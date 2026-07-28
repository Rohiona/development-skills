---
description: 俺様レビューオール。整合性・要件・設計・変更影響・品質（+テスト健全性）+ セキュリティ + BugBot 観点（仮想 Bugbot＝実バグ先回り）を並列実行し統合レポート化（opus/high effort）。※学習(retro)は統合入口 /review-retro に集約: 本物 Bugbot＋人間の全 PR 指摘を1パスで収集し種類別の棚（bug/impact/quality/security/tautology）へ振り分け（旧 /bugbot-review-retro・/hahifuhe:review-retro は薄ラッパーで存続）
model: opus
effort: high
---

# 俺様コードレビューオール

review-all は**バックグラウンド Workflow** として実行する。全観点をサブエージェントで回し、各 reviewer の所見は `/tmp` にファイル永続化、**メインには判定サマリーだけ返す**（巨大 PR でもメイン文脈を膨張させない）。

## 実行手順

1. **正本を読む**: `skills/hahifuhe-review-all/references/review-all-workflow.md`（メインループの責務・原則・Phase 0 準備・GO ループ・報告）。
2. **Phase 0（メインループの準備）**: 正本の「Phase 0」どおり、対象 diff を `/tmp/review-{ts}/diff.patch` 等の**ファイルへ逃がし**、`files.json`・行数・テスト有無・spec 検出結果を用意する（diff 本文をメイン文脈に載せない）。
2.5. **Phase 0.5（入口トリアージ・2026-07-09 v4）**: 正本の「Phase 0.5」どおり、危険領域判定・既存レビュー棚卸し・規模から `profile`（full/light）を fail-closed で自動決定し、**選定と理由を起動前にチャットへ 1 行宣言**する（閣下の明示指定が常に最優先。Codex は profile に関わらず必ず実行される）。
3. **Workflow 起動**: **Workflow ツール**を `scriptPath: "~/.claude/workflows/review-all.js"`（絶対パスに解決）+ `args`（Phase 0 の結果）で 1 回呼ぶ。観点の起動・並列 fan-out・統合レポート合成はすべてスクリプトが行い、メインには `{overallVerdict, totals, reportPath, blockers}` だけ返る。
   - この呼び出しは「コマンドの指示で Workflow を呼ぶ」＝ multi-agent orchestration の opt-in を満たす正規ルート。
4. **報告**: Workflow 戻り値から GO/NO-GO・件数・ブロッカー・`reportPath` を報告（正本「Phase 2」）。
5. **GO までのループ**: NO-GO なら修正 → **Workflow をもう一度起動**（フル再レビュー）。GO（Critical 0 かつ Major 0）まで止めない。

> オーケストレーションの正本は `~/.claude/workflows/review-all.js`。観点 → agentType の対応・schema・fan-out・合成はスクリプトにある。各 reviewer のプレイブックは agent 定義側（`agents/hahifuhe-*-reviewer.md` / `bugbot-review.md`）。

トークン効率の共有契約（distilled + diff を既定で読む / manifest 起点 / Serena 優先）:

- `skills/autonomous-dev/references/token-efficient-handoff.md`

GO/NO-GO ゲート: 総合判定 GO の条件は **Critical = 0 かつ Major = 0**。machine gate（型 / lint / test）と並ぶ二重ゲートであり、machine gate が通っていても本レビューが NO-GO ならリリースしない。
