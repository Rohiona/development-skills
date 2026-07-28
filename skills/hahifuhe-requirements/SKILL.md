---
name: hahifuhe:requirements-codex
description: 俺様要件定義（Codex向け薄ラッパー）。複雑な要件を構造化し、requirements 成果物へ収束させる
---

# Oresama Requirements

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:requirements.md` を読む
2. 要件定義に入る前に `~/.claude/agents/hahifuhe-requirements.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## Codex 向け読み替えルール

- 親 Codex が既定で要件定義を進める
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- Researcher（実現可能性調査）はサブエージェント起動せず、親 Codex が
  `~/.claude/agents/hahifuhe-researcher.md` の調査規律・出力契約に従って**インラインで実行**する
- 既存コードと既存資料を**当該機能が触る範囲に限定して**先に読み、未知を減らしてから質問する（無条件の全走査はしない）
- 成果物は共有契約に従い 3 分類で `design_doc/{機能名}/requirements/` に作る:
  - distilled 引き渡し `requirements/requirements.json`（設計が既定で読む）
  - 本体 `requirements/requirements.md`（人間レビュー用・下流は既定で読まない）
  - scratch `requirements/process_state.json`（下流非参照）
- 収束時に feature-root の `manifest.json` の `requirements` エントリ（status / version / handoff）を更新する
- 収束条件と未解決 unknowns を常に明示する
- 共有契約: `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

## 最小実行手順

1. テーマと対象スコープを決める
2. 既存コードと資料から制約を抽出する
3. 重要な unknown を潰す
4. 要件成果物へ落とし込む
5. 収束状況と次アクションを返す
