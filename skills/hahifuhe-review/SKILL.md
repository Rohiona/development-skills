---
name: hahifuhe:review-codex
description: 俺様批判的レビュー（Codex向け薄ラッパー）。要件書や設計書の懸念点を Codex で評価する
---

# Oresama Review

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review.md` を読む
2. 評価基準の詳細が必要なら `~/.claude/agents/hahifuhe-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 最新情報確認が必要なら公式一次情報を優先する
- 問題点だけでなく良い点も拾う
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. `manifest.json` を読み、対象 distilled（要件なら `requirements/requirements.json`、設計なら `design/context.json`）を読む。verbose 本体は懸念の裏取りに不足したときだけ該当セクションを開く（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 関連コードを対象パッケージに限定して確認する（Serena 優先）
3. 懸念点の妥当性を検証する
4. severity 順に finding を返す
5. 必要なら次の hahifuhe workflow を提案する
