---
name: hahifuhe:brainstorm-codex
description: 俺様ブレーンストーミング（Codex向け薄ラッパー）。アイデア探索と論点整理を Codex で進める
---

# Oresama Brainstorm

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:brainstorm.md` を読む
2. 進行の型が必要なら `~/.claude/agents/hahifuhe-brainstorm.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## 共有契約

蒸留引き渡しは共有契約に従う:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

## Codex 向け読み替えルール

- 親 Codex が対話を進める
- `spawn_agent`（参加者 = `hahifuhe-brainstorm-participant` 相当のペルソナ）はユーザーが明示的に求めたときだけ使う
- コードベース確認はテーマが触れる範囲に限定し、全文読みより シンボル単位の探索を優先する
- 発散と収束を混ぜず、探索段階ではアイデアを広げてから整理する
- 保存する場合の distilled 引き渡しは `brainstorm.json`
  （ideas + requirement_candidates + investigations）。メモや JSON の保存はユーザーが明示したときだけ行う

## 最小実行手順

1. テーマと制約を確認する
2. 既存成果物や既存実装を（スコープ限定で）確認する
3. アイデアを広げる（必要なら専門家ペルソナの視点も足す）
4. 発見をカテゴリ分けして整理する（requirement_candidates / investigations を明示）
5. 次に `requirements` へ渡せる状態か、追加調査が必要かを返す。保存時は
   `brainstorm.json` を distilled として残し、`manifest.json` の `phases.brainstorm` を更新する
