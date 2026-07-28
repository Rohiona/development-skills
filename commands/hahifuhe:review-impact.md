---
description: 変更影響レビュー。diff 起点で既存コードへの波及を事前確認する。PR は未作成でもよい（opusモデル使用）
model: opus
---

**親 Claude が直接影響レビューを行う。** hahifuhe-impact-reviewer サブエージェントはデフォルトでは起動しない。

親は `agents/hahifuhe-impact-reviewer.md` をプレイブックとして Read し、diff と波及範囲を自分の文脈で Grep/Read しながら評価する。

**理由**: 影響レビューは「変更点から波及先を Grep で辿る」作業であり、親の文脈から切り離すと Grep 結果の読み漏れや捏造が起きやすい。親が直接 diff → Grep → finding を行うことで捏造を構造的に排除する。

**目的**: PR 提出後の「指摘→場当たり修正→再指摘→コード崩壊」ループを防ぐ。

## 入力の規律（トークン効率）

共有契約 `skills/autonomous-dev/references/token-efficient-handoff.md` 準拠。diff 起点なので verbose 本体は既定で読まない。仕様がある機能なら `manifest.json` → `design/context.json` を起点コンテキストに使い、設計判断と矛盾する波及がないか照合する。コードベース走査は diff が触るパッケージ・呼び出し元・依存先に限定（Serena + LSP `incomingCalls` / `goToImplementation` 優先）。

## 対象と境界

- 対象: 実装 diff とその波及範囲
- PR の有無は不要。必要なのは実装差分
- 対象外: 要件整合性確認、設計レビュー、コード品質レビュー

## 分析観点

- 破壊的変更（シグネチャ・型・振る舞い変更の呼び出し元への影響）
- 暗黙の依存（import 先・設定ファイル・スキーマ変更）
- パフォーマンス影響（N+1 導入・計算量悪化）
- セキュリティ影響（新規入力・認証バイパス・ログ漏洩）

## 成果物

```
reviews/impact-review-{date}.md
```
