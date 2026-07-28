---
name: entropy-requirements
description: エントロピーベース要件定義（旧入口）。正本は hahifuhe-entropy-requirements — 本スキルは委譲のみ行う
---

# エントロピーベース要件定義（旧入口・委譲ラッパー）

このスキルは**旧入口**であり、独自の手順を持たない。正本は
`~/.claude/skills/hahifuhe-entropy-requirements/` — 呼ばれたら正本の SKILL.md と
references（phase-workflow.md / requirement-schema.md / quality-criteria.md / entropy-evaluation.md）に
従って実行すること。

- 本ディレクトリ配下の `references/` は**旧版であり参照禁止**（schema が古く、
  unknowns_deferred_to_design の selection gate 拡張・feasibility 契約を含まない）。
- 成果物パス・スキーマも正本側の定義（`design_doc/{機能名}/requirements/` 配下）に従う。
- 二重管理解消の経緯: 2026-07-15 selection gate 導入時に正本へ一本化。
