---
name: hahifuhe:review-architecture-codex
description: 俺様設計レビュー（Codex向け薄ラッパー）。architecture 系ドキュメントの妥当性を Codex で評価する
---

# Oresama Review Architecture

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review-architecture.md` を読む
2. 評価基準の詳細が必要なら `~/.claude/agents/hahifuhe-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 技術選定や AWS 制約は公式一次情報で確認する
- 対象設計が前提としている既存コードや既存システムも確認する
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. `manifest.json` → `design/context.json`（設計判断・棄却代替案）を読む。verbose 本体（`architecture.md`）は懸念の裏取りに不足したときだけ該当 DD-id 周辺を開く（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 関連要件（`requirements/requirements.json`）と関連コードを対象パッケージに限定して確認する（Serena 優先）
3. 実現可能性、非機能、データ/API 設計、リスクを評価する
4. severity 順に finding を返す
