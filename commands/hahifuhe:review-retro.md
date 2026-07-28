---
description: 人間レビュアーの PR 指摘を正解に、自分の impact/quality/tautology レビューが落とした観点を振り分け→蒸留して育てる（Missed 自動・構造変更は承認制）
argument-hint: "<PR番号>"
model: opus
---

# /hahifuhe:review-retro — 俺様レビュー観点の自己成長（蒸留）ループ ※統合済み・薄ラッパー

> **このコマンドは `/review-retro` に統合されました。** 収集・重複除去・振り分け・蒸留は
> `~/.claude/commands/review-retro.md` が1本で行います。本コマンドは**その human 経路のみ**を呼ぶ薄ラッパーです
> （`/hahifuhe:review-retro <PR>` の既存導線を壊さないために存続）。

## このコマンドを実行したら初めにやること
「hahifuhe:review-retro.md を実行（→ review-retro の human 経路へ委譲）」と出力すること。

## 実行内容（委譲）

`/review-retro <PR>` を**人間レビュアーのみをお手本とするモード**で実行する。具体的には review-retro の手順を、
次の human 経路に限定して回す:

- **収集**: 手順1の経路 (B) 全体コメント【一次信号源】/ (C) 総評 / (D) 人間インライン（`*[bot]` と PR 作成者を除外）。bot 経路 (A) はスキップ。
- **前処理**: 手順1.5（構造化レビューを finding 単位に分解）＋手順2（ノイズ除去）を適用。
- **baseline**: 手順0。review-all の `impact/quality/test-sanity-<slice>.md`＋`coverage.json`、無ければ `reviews/*-review-{date}.md`、それも無ければ軽量モード（diff×現行 lenses 机上判定）。
- **振り分け先(棚)**: router（手順5）に従い impact(I*) / quality(Q*) / tautology(T*) / security(S*) / out-of-scope。
- **cases**: `~/.claude/agents/hahifuhe-review.cases.jsonl`（`shelf` が I*/Q*/T*/S*/out-of-scope の行）。
- **ゲート**: 再発ゲート（quality は結合度/保守性を実害扱い）。同一 SHA 原則・Missed 自動・構造変更は承認制。

詳細手順・スキーマ・誤学習防止の前提は `/review-retro` の正本を参照（重複記述を持たない＝乖離防止）。
