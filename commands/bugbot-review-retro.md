---
description: ローカル /bugbot-review と本物 Cursor Bugbot のPRレビューを同一コミットで突合し、見落とし観点を観点集へ蒸留（Missed 自動・構造変更は承認制）
argument-hint: "<PR番号>"
---

# /bugbot-review-retro — 仮想 Bugbot の自己成長（蒸留）ループ ※統合済み・薄ラッパー

> **このコマンドは `/review-retro` に統合されました。** 収集・重複除去・振り分け・蒸留は
> `~/.claude/commands/review-retro.md` が1本で行います。本コマンドは**その bot 経路のみ**を呼ぶ薄ラッパーです
> （`/bugbot-review-retro <PR>` の既存導線＝bugbot-loop skill 等を壊さないために存続）。

## このコマンドを実行したら初めにやること
「bugbot-review-retro.md を実行（→ review-retro の bot 経路へ委譲）」と出力すること。

## 実行内容（委譲）

`/review-retro <PR>` を**本物 Cursor Bugbot のみをお手本とするモード**で実行する。具体的には review-retro の手順を、
次の bot 経路に限定して回す:

- **収集**: 手順1の経路 (A) `cursor[bot]` インライン指摘のみ（人間経路 B/C/D はスキップ）。
- **baseline**: 手順0。review-all の `bugbot-<slice>.md`＋`coverage.json`、無ければローカル `/bugbot-review`
  出力 `~/.claude/bugbot-logs/<branch>-<shortsha>.md`、それも無ければ当該 SHA で `/bugbot-review` を実行して生成。
- **振り分け先(棚)**: 機械的バグ → bug 棚 `~/.claude/agents/bugbot-review.lenses.md`（L*）。
  security に分類されるものは review-retro の router に従い security 棚（S*）へ寄せうる（二重学習回避）。
- **cases**: `~/.claude/agents/bugbot-review.cases.jsonl`（`shelf:"bug"` 行）。
- **ゲート**: 実害ゲート（保守性のみは参考に落とす）。同一 SHA 原則・Missed 自動・構造変更は承認制。

詳細手順・スキーマ・誤学習防止の前提は `/review-retro` の正本を参照（重複記述を持たない＝乖離防止）。
