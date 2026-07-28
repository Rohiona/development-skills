---
name: hahifuhe:review-requirements-codex
description: 俺様要件レビュー（Codex向け薄ラッパー）。requirements ドキュメントの妥当性を Codex で評価する
---

# Oresama Review Requirements

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review-requirements.md` を読む
2. 評価基準の詳細が必要なら `~/.claude/agents/hahifuhe-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 要件書だけでなく関連する既存コードや制約も確認する
- 最新の外部制約が絡む場合は公式一次情報で確認する
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. `manifest.json` → `requirements/requirements.json`（FR/AC/NFR/scope/assumptions）を読む。verbose 本体（`requirements.md`）は懸念の裏取りに不足したときだけ該当セクションを開く（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 関連制約と既存実装を対象パッケージに限定して確認する（Serena 優先）
3. 完全性、明確性、検証可能性、リスクを評価する
4. severity 順に finding を返す
