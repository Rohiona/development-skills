---
description: 整合性レビュー。要件↔設計↔実装の一致を突き合わせて評価する。要件/設計単体レビューには使わない（opusモデル使用）
model: opus
---

**親 Claude が直接整合性レビューを行う。** hahifuhe-conformance-reviewer サブエージェントはデフォルトでは起動しない。

親は `agents/hahifuhe-conformance-reviewer.md` をプレイブックとして Read し、要件・設計・実装の 3 点を自分の文脈で突き合わせて整合性を確認する。

**理由**: 整合性レビューは「3 つのソースを同時に読んで突き合わせる」作業であり、親の文脈から切り離すと Read 漏れや記憶補完による捏造が起きやすい。親が直接 Read → 引用 → 突き合わせを行うことで捏造を構造的に排除する。

## レビュー前に必要なもの（distilled + diff を既定で読む）

共有契約 `skills/autonomous-dev/references/token-efficient-handoff.md` 準拠。`manifest.json` を最初に読み、以下の distilled を起点にする。verbose 本体は不足時のみ該当セクションを開く。

- `requirements/requirements.json`（不足時のみ `requirements.md`）
- `design/context.json`（不足時のみ `architecture.md`）
- `implementation/context.json`
- `git diff` + 実装コード（対象パッケージに限定、Serena 優先）

実装がまだない場合は `hahifuhe:review`（要件/設計レビュー）を使う。

## 対象と境界

- 対象: 要件・設計・実装の 3 点をまたぐ整合性確認
- 対象外: 要件定義レビュー、設計レビュー、diff 起点の影響確認

## 突き合わせ観点

- 機能要件（FR）の実現有無
- 受入条件（AC）に対応するコード・テストの存在
- 非機能要件（NFR）の設計・コードへの反映
- 設計判断の尊重（棄却代替案へのドリフトがないか）

## GO/NO-GO

整合 GO の条件は **Critical = 0 かつ Major = 0**。乖離が残れば NO-GO。

## 成果物

```
reviews/conformance-review-{date}.md
```
