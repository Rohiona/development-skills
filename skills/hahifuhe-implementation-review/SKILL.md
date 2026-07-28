---
name: hahifuhe:implementation-review-codex
description: 俺様実装レビュー（Codex向け薄ラッパー）。要件・設計と実装の整合や品質を Codex で評価する
---

# Oresama Implementation Review

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:implementation-review.md` を読む
2. 実行前に `~/.claude/agents/hahifuhe-implementation-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 要件、設計、実装の順で実際に読んでから finding を出す
- 最新仕様やライブラリ情報が必要なら公式一次情報で確認する
- レビュー結果は findings first で返し、レポート保存は明示要求時だけ行う

## 最小レビュー手順

1. 対象スコープを `git diff` で決める
2. `manifest.json` → distilled（`requirements/requirements.json`, `design/context.json`, `implementation/context.json`）を読む。verbose 本体は不足時のみ該当セクションを開く（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
3. 実装とテストを読む（対象パッケージに限定、Serena シンボル単位優先）
4. FR、AC、NFR、品質の観点で finding を整理する
5. severity 順に返す。GO は Critical = 0 かつ Major = 0（machine gate と並ぶ二重ゲート）
