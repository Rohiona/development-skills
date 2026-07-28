---
name: hahifuhe:architect-codex
description: 俺様アーキテクト（Codex向け薄ラッパー）。設計・技術選定・API/DB設計を Codex で進める
---

# Oresama Architect

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:architect.md` を読む
2. 設計作業に入る前に `~/.claude/agents/hahifuhe-architect.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- 親 Codex が既定で実行する
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- Claude 固有 MCP の記述は「深い検討」と「一次情報確認」の意図として解釈し、ローカル調査と公式情報で代替する
- 設計判断では前提、選択肢、trade-off を明示する
- この workflow の主成果物が設計書なら作成または更新してよい

## トークン効率の共有契約

本 skill が委譲する agent/command は hahifuhe シリーズの共有契約に従う:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

- 入力は `manifest.json` → `requirements/requirements.json`（distilled）の順で読む。`requirements.md` は既定で読まない。
- コードベース走査はスコープ限定（当該機能が触るパッケージと近接モジュールのみ）。広域把握は manifest.context の source/target_system 要約で代替する。無条件の全体スキャンは行わない。
- 引き渡しは `design/context.json`（chosen_strategy / rejected_alternatives / key_design_decisions / assumptions_confirmed / unresolved）。
- `architecture.md` / `api-design.md` は verbose 本体として保持（人間レビュー用、下流非参照）。`design-progress.json` は scratch（下流非参照）。
- 完了時に `manifest.json` の `phases.design`（status / version / handoff / changes）を更新する。

## 最小実行手順

1. `manifest.json` と `requirements/requirements.json`、当該機能が触る範囲の既存実装（Serena でスコープ限定）を確認する
2. 設計論点を分解し、選択肢と評価軸（比較表）を整理する
3. 推奨案と理由、却下した代替案を示す
4. verbose 本体（architecture.md）と distilled（context.json）を両方更新し、manifest.json も更新する
5. 決定事項、未解決論点、次アクションを短く返す
