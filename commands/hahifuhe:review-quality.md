---
description: コード品質レビュー。実装コードとテストの健全性を評価する。要件整合性チェックは対象外（opusモデル使用）
model: opus
---

**親 Claude が直接コード品質レビューを行う。** hahifuhe-quality-reviewer サブエージェントはデフォルトでは起動しない。

親は `agents/hahifuhe-quality-reviewer.md` をプレイブックとして Read し、Ground Truth 検証（対象ファイルを Read で実際に読んでから finding を上げる）を自分の文脈で実行する。

**理由**: レビュー系の主要な failure mode は「対象ファイルを Read せずに推測で finding を捏造する」こと。親が直接 Read → 引用 → finding 生成の一連を自分の文脈で行うことで捏造を構造的に排除する。

## 既存 `hahifuhe:implementation-review` との使い分け

- **hahifuhe:implementation-review** — 要件（FR/AC/NFR）との整合性が主軸。リリース前の総合チェックに使う
- **hahifuhe:review-quality** — コード健全性（アーキテクチャ・品質・パフォーマンス・テスト）が主軸。リファクタ後や品質チェック単体に使う

## 入力の規律（トークン効率）

共有契約 `skills/autonomous-dev/references/token-efficient-handoff.md` 準拠。仕様がある機能なら `manifest.json` → `design/context.json` / `implementation/context.json` を参照し、設計で意図的に選んだ判断を品質問題と誤指摘しない。レビュー対象は `git diff` で特定し、対象パッケージに限定して Serena シンボル単位で読む。verbose 本体は不足時のみ該当 DD-id 周辺を開く。

## 対象と境界

- 対象: 実装コード、テストコード、実装に密接に結びつく設定
- 対象外: 要件整合性確認、設計レビュー、diff 起点の波及確認

## GO/NO-GO

GO の条件は **Critical = 0 かつ Major = 0**。これは machine gate（型 / lint / test）と並ぶ二重ゲートの片翼。

## 評価観点

- アーキテクチャ準拠
- コード品質
- パフォーマンス
- テスト

## 成果物

```
reviews/quality-review-{date}.md
```
