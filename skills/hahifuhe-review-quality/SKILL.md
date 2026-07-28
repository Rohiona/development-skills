---
name: hahifuhe:review-quality-codex
description: 俺様コード品質レビュー（Codex向け薄ラッパー）。実装とテストの健全性を Codex で評価する
---

# Oresama Review Quality

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review-quality.md` を読む
2. 実行前に `~/.claude/agents/hahifuhe-quality-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- finding を出す前に対象ファイルを実際に読む
- 品質、設計、性能、テストの観点を分けて評価する
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. 対象スコープを `git diff` で決める。仕様がある機能なら `manifest.json` → `design/context.json` / `implementation/context.json` を参照し、設計で意図的に選んだ判断を品質問題と誤指摘しない（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 実装とテストを読む（対象パッケージに限定、Serena シンボル単位優先）
3. 根拠のある問題だけを抽出する
4. severity 順に finding を返す。GO は Critical = 0 かつ Major = 0
