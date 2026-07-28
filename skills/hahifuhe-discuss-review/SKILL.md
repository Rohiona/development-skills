---
name: hahifuhe:discuss-review-codex
description: 俺様レビュー討議（Codex向け薄ラッパー）。レビュー指摘の妥当性や対応方針を Codex で整理する
---

# Oresama Discuss Review

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:discuss-review.md` を読む
2. 討議の進め方が必要なら `~/.claude/agents/hahifuhe-discussion.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- 親 Codex が既定で討議を進める
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- レビュー指摘は正解扱いせず、妥当性とコストを検証する
- 1 件ずつ論点を区切り、代替案とトレードオフを明示する
- 討議ログの保存はユーザーが明示したときだけ行う

## 最小実行手順

1. 対象のレビュー結果を読む
2. **根本原因集約を最初に通す**（個別論点の前）: 指摘をクラスタリングして根を 1〜数個に言語化し、**根は必ず Serena と LSP で事実確認**（構造・シンボル・参照元は Serena、型同一性・実装網羅・呼び出し関係は LSP）。各主張に 事実 / 推論 / 推測 を明示。症状→根マップと「根を解くと消える枝葉」を示し、根レベルの議論点を 2〜4 個提示する
3. 根に束ねられない独立指摘だけ、論点ごとに妥当性・影響・代替案を整理する
4. 対応、受容、保留、棄却のいずれかに寄せる
5. 残るリスクと意思決定理由を短く返す
