---
name: hahifuhe:review-conformance-codex
description: 俺様整合性レビュー（Codex向け薄ラッパー）。要件・設計・実装の一致を Codex で突き合わせる
---

# Oresama Review Conformance

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:review-conformance.md` を読む
2. 実行前に `~/.claude/agents/hahifuhe-conformance-reviewer.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- レビュー本体は親 Codex が実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- 要件、設計、実装の 3 点を実際に読んでから finding を出す
- FR、AC、NFR ごとに対応箇所を確認し、推測で穴を埋めない
- レビュー結果は findings first で返し、保存は明示要求時だけ行う

## 最小レビュー手順

1. `manifest.json` を読み、distilled（`requirements/requirements.json`, `design/context.json`, `implementation/context.json`）を特定して読む。verbose 本体は不足時のみ該当セクションを開く（共有契約 `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）
2. 対応する実装とテストを読む（対象パッケージに限定、Serena 優先）
3. 不一致、未実装、設計ドリフトを確認する
4. severity 順に finding を返す。GO は Critical = 0 かつ Major = 0
