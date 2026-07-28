---
name: hahifuhe:consult-codex
description: 俺様コンサル（Codex向け薄ラッパー）。曖昧な課題や意思決定を対話で整理し、要件定義や調査に渡せる状態にする
---

# Oresama Consult

この skill は薄いラッパー。詳細手順の正本は Claude command / agent playbook にあり、発火時にだけ読む。

## Trigger時の基本動作

1. `~/.claude/commands/hahifuhe:consult.md` を読む
2. 相談セッションを進める前に `~/.claude/agents/hahifuhe-consultant.md` を読む
3. その内容を canonical workflow として扱う
4. Claude 固有の実装はこの skill の Codex 向けルールで読み替える

## 共有契約

蒸留引き渡しは共有契約に従う:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

## Codex 向け読み替えルール

- 親 Codex が既定でコンサルティングを進める
- `spawn_agent` はユーザーが明示的に求めたときだけ使う
- `Think → Share → Invite` を守り、ユーザーに聞く前に自分で調べる。
  コードベース確認はテーマが触れる範囲に限定し、全文読みよりシンボル単位の探索を優先する
- 1 ターン 1 論点を原則にする
- 保存する場合: distilled 引き渡しは `consulting/{session_id}/handover.json`、
  `process_state.json` は下流非参照の scratch、`research_brief.json` は調査が必要な場合のみ。
  保存はユーザーが明示したときだけ行う

## 最小実行手順

1. テーマとゴールを定義する
2. コードベースや既存資料で自力確認できることを（スコープ限定で）調べる
3. `[fact]` `[assumption]` `[preference]` を分けて共有する
4. 重要な 1 問だけをユーザーに返す
5. `requirements_ready` か `research_required` まで収束させる。保存時は `handover.json` を
   distilled として確定し、`manifest.json` の `phases.consulting` を更新する
