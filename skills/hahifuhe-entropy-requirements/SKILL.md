---
name: hahifuhe-entropy-requirements
description: エントロピーベース要件定義。不確実性を段階的に削減し要件を収束させる
---

# エントロピーベース要件定義スキル

7フェーズ構成（初期化→既存コード分析→質問生成・調査ディスパッチ→回答・verdict 分類→不足検知・実現可能性チェック→品質検証→収束判定）の詳細は下記を読むこと。
収束はツインピークスモデル: 全 must_have に実現方法の裏付け（feasibility）が付くまで収束しない（収束条件⑤）。
調査で解ける unknown は `hahifuhe-researcher` を Task で並列起動して解く（起動テンプレート: phase-workflow.md Phase 3）。
**実行経路はメインループ直接実行の一択**（grill ループは途中のユーザー対話が必須で、サブエージェントは対話できない。
対話不要の自動実行文脈でのみ Researcher をインライン実行に切り替える）。

- `~/.claude/skills/hahifuhe-entropy-requirements/references/phase-workflow.md` — フェーズ詳細
- `~/.claude/skills/hahifuhe-entropy-requirements/references/requirement-schema.md` — JSON構造
- `~/.claude/skills/hahifuhe-entropy-requirements/references/quality-criteria.md` — 4要素品質基準
- `~/.claude/skills/hahifuhe-entropy-requirements/references/entropy-evaluation.md` — エントロピー評価・収束判定

共有契約（必読・全フェーズ共通）:

- `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md` — 本体（verbose）/ 引き渡し（distilled）/ scratch の分離、manifest.json 規律、読み込み規律

## 成果物の3分類（共有契約 §1 準拠）

| 区分 | ファイル | 役割 | 下流の扱い |
|---|---|---|---|
| 引き渡し（distilled） | `design_doc/{機能名}/requirements/requirements.json` | 設計フェーズが意思決定に使う構造化要点 | **設計フェーズが既定で読む** |
| 本体（verbose） | `design_doc/{機能名}/requirements/requirements.md` | 人間レビュー用の全詳細 | **下流は既定で読まない** |
| scratch | `design_doc/{機能名}/requirements/process_state.json` | 収束追跡・履歴（フェーズ内部の作業状態） | **下流は絶対に読まない** |
| 調査（distilled 集約） | `design_doc/{機能名}/research/research.json` + `research/{brief_id}/findings.md`（verbose） | Researcher の verdict 集約（要件の feasibility の出典） | **下流は既定で読まない**（正本は requirements.json の feasibility） |

- distilled スキーマの最小契約は共有契約 §3.1。詳細は `references/requirement-schema.md`。
- 下流に必要な情報は必ず distilled（requirements.json）へ昇格させ、scratch に閉じ込めない。

## フェーズ完了時の manifest.json 更新（共有契約 §2 必須）

収束して成果物を確定したら、機能ディレクトリ直下の `design_doc/{機能名}/manifest.json` の
`requirements` エントリを更新する（無ければ作成）:

```jsonc
"requirements": {
  "status": "completed",
  "version": "1.0.0",
  "handoff": "requirements/requirements.json"
}
```

併せて `current_phase` / `current_phase_status` / `next_action` も更新する。
`phases.*` には本文を入れない（status / version / handoff パス / 1行 changes のみ）。

## 質問の作法（grill ループ）

質問生成フェーズで unknown を潰すときは次の作法で行う。曖昧さを残したまま次フェーズに進めない。

- **1 ターン 1 論点**。質問を束ねず、決定木の枝を 1 本ずつ解消する。
- 各質問には **推奨回答（こちらの想定とその理由）を必ず添える**。ユーザーは是非だけ判断すればよい状態にする。
- **コードベース・既存資料で答えが出ることは聞かない**。先に自分で調べ、確認できた事実は `[fact]` として提示する（既存コード分析フェーズの成果を使う）。
- **調査で解ける unknown も聞かない**。外部 API 仕様・ライブラリ制約は `hahifuhe-researcher` に調査させ、verdict を `[fact]` として提示する。人に聞くのは意図・好み・ビジネス判断だけ。
- 事実 / 推論 / 推測（要確認）を分けて出し、推測を前提に質問を組み立てない。
- load-bearing な分岐が解消するまで繰り返し、エントロピーが収束したら明示する。
