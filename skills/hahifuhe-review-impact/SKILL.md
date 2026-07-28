---
name: hahifuhe:review-impact-codex
description: 俺様変更影響レビュー（Codex向け薄ラッパー）。diff 起点の波及を Codex で評価する
---

# Oresama Review Impact

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review-impact.md` を読む
2. 実行前に `~/.claude/agents/hahifuhe-impact-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- diff、参照元検索、対象コード読解を同じ文脈で行う
- 影響先を主張する前に実際の呼び出し元や依存先を確認する
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. diff を決める。仕様がある機能なら `manifest.json` → `design/context.json` を起点コンテキストに使う（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 変更を分類する
3. 呼び出し元、依存先、設定、テストを確認する（diff が触るパッケージ・呼び出し元・依存先に限定、Serena + LSP `incomingCalls` 優先）
4. 破壊的変更、性能、セキュリティの影響を整理する
5. severity 順に finding を返す
