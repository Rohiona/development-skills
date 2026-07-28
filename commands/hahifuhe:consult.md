---
description: 構造化コンサルティング。曖昧なアイデアを対話で整理し、要件定義または調査に渡せる状態にする（opusモデル使用）
model: opus
---

**親 Claude が直接コンサルティングを行う。** hahifuhe-consultant サブエージェントはデフォルトでは起動しない。

親は `agents/hahifuhe-consultant.md` をプレイブックとして Read し、Think → Share → Invite サイクルを自分の文脈で実行する。

## ゴール

曖昧なアイデアや意思決定課題を対話で整理し、以下のどちらかに収束させる:
- `requirements_ready` — `/hahifuhe:requirements` に渡せる状態
- `research_required` — 外部 evidence が必要、`research_brief.json` を生成して調査に渡す

## 対象と境界

- 対象: 要件定義の前段階にある曖昧なアイデア・意思決定課題
- コードベースや既存成果物で答えられることは自分で調べてから対話に入る
- 既に要件が明確な場合は `/hahifuhe:requirements` を直接使う

## 共有契約

進行前に **トークン効率と蒸留引き渡しの共有契約**を読む:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

コードベース確認はテーマが触れる範囲に限定し、Serena（シンボル単位）を全文 Read より優先する。

## セッション成果物

```
consulting/{session_id}/
├── handover.json           # distilled・必須（下流が既定で読む唯一の引き渡し）
├── process_state.json      # scratch・必須（収束追跡 / stage_log。下流非参照）
├── artifacts.json          # コードベースから確認した事実（出典付き・必要時のみ）
└── research_brief.json     # 調査が必要な場合のみ
```

`session_id`: `YYYYMMDD-001` 形式

完了時は `handover.json` を確定し、`design_doc/{機能名}/manifest.json` の
`phases.consulting`（status / latest_session / handoff）と `current_phase` / `next_action` を更新する。
