# 要件成果物スキーマ

成果物は共有契約（`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`）の
3分類に従う。requirements.json は**設計フェーズが既定で読む distilled 引き渡し**であり、
冗長な説明・コード片・スキーマ全文は本体 `requirements.md` 側に置く。
書き方は共有契約 §6 の記載規律（単一記載原則・サマリ2〜3文・本文は現在形の最終状態のみ・
レビュー指摘 ID は末尾括弧のみ）に従う。

---

## 1. 引き渡し（distilled）: `design_doc/{機能名}/requirements/requirements.json`

設計フェーズが意思決定に必要な要点だけを構造化したもの（共有契約 §3.1）。
判断に必要な事実（受け入れ基準・must_have・前提・スコープ）は構造化して残し、
説明文の冗長性だけ削る。「要約して捨てる」ではない。

```json
{
  "theme": "feature-key",
  "title": "機能タイトル",
  "version": "1.0.0",
  "status": "discovery|definition|approved|completed",
  "entropy": "high|medium|low",
  "basic": {
    "what": "何を作るか（2〜3文まで。仕様の詳細は must_have / 各欄が正本 — ここに再掲しない）",
    "why": "なぜ必要か（ビジネス価値）",
    "who": {
      "stakeholders": ["ステークホルダー"],
      "users": ["エンドユーザー"],
      "owner": "意思決定者"
    },
    "where": "どこで使われるか",
    "when": "期限・マイルストーン（1行）",
    "how": "実現方法の大枠（1行）"
  },
  "constraints": {
    "technical": ["技術的制約"],
    "business": ["ビジネス上の制約"],
    "legal": ["法的・規制上の制約"]
  },
  "assumptions": {
    "confirmed": ["確認済みの前提"],
    "unconfirmed": ["未確認の前提（要検証）"]
  },
  "scope": {
    "in_scope": ["スコープ内"],
    "out_of_scope": ["スコープ外"],
    "deferred": ["後回し"]
  },
  "functional_requirements": {
    "must_have": [{
      "id": "FR-001",
      "requirement": "必須機能",
      "acceptance": "受け入れ条件",
      "feasibility": {
        "status": "unverified|verified|verified_conditional|risk_waived|infeasible_rejected",
        "approach": "実現方法（1-2行）",
        "conditions": ["verified_conditional 時の成立条件"],
        "evidence": [{ "label": "fact|inference|speculation", "statement": "根拠", "source": "URL または file:line" }],
        "verified_by": "research/research.json#INV-001 | existing-code | user-decision",
        "confidence": "high|medium|low"
      }
    }],
    "should_have": [{ "id": "FR-101", "requirement": "重要だが必須ではない" }],
    "could_have": [{ "id": "FR-201", "requirement": "あると良い" }],
    "wont_have": ["今回は実装しない"]
  },
  "nfr": {
    "performance": ["定量的なパフォーマンス要件"],
    "security": ["セキュリティ要件"],
    "reliability": ["信頼性要件"],
    "scalability": ["スケーラビリティ要件"]
  },
  "dependencies": {
    "systems": ["依存する既存システム"],
    "services": ["依存する外部サービス"],
    "data": ["依存するデータソース"]
  },
  "acceptance_criteria": ["機能横断の受け入れ基準（測定可能な形式で）"],
  "kpis": [{ "metric": "指標", "target": "目標値" }],
  "unknowns_deferred_to_design": [
    {
      "id": "UNK-001",
      "question": "設計で解決すべき論点（何を決めるのか）",
      "criticality": "should|could",
      "resolution_mode": "fact_finding|user_decision",
      "decision_condition": "何が揃えば決められるか＋材料の取り方（例: 既存コード X の実測 / 公式 docs Y の確認 / 閣下に選択肢A・Bを提示）",
      "blocks": "design|implementation|none",
      "options": ["候補A（選ぶと何が起きるか）", "候補B（同上）"]
    }
  ],
  "meta": {
    "last_updated": "ISO8601形式",
    "confidence_level": "low|medium|high"
  }
}
```

**distilled に必ず残すもの（共有契約 §5・品質の核）**:
- `acceptance_criteria` と `functional_requirements.must_have`（要件↔設計↔実装の整合性レビューの基盤）
- must_have 各項目の `feasibility`（実現方法の裏付け。下流が読む正本はここ — `research/research.json` は要件フェーズの入力・監査用で下流は既定で読まない）
- `scope.in_scope / out_of_scope`（設計の境界判断）
- `unknowns_deferred_to_design`（設計フェーズへ引き継ぐ未解決論点。詳細な却下理由などは本体へ）

**本体（verbose）に置くもの**: 既存コード分析の詳細（related_files の全リスト・api_patterns・data_models・
business_logic）、リスク詳細、質問・回答の経緯、却下した代替案の長い説明。
設計フェーズは既定でこれらを読まない。必要時のみ requirements.md の該当セクションをピンポイント参照する。

---

## 2. scratch: `design_doc/{機能名}/requirements/process_state.json`

要件フェーズ内部の作業状態。**下流フェーズは絶対に読まない**（共有契約 §1）。
下流に必要な情報は必ず distilled（requirements.json）へ昇格させる。

```json
{
  "phase": "requirements",
  "status": "in_progress|completed|blocked",
  "completed_at": "YYYY-MM-DD",
  "entropy_progression": ["high", "medium", "low"],
  "cycles_completed": 0,
  "unknowns_resolved": 0,
  "unknowns_deferred_to_design": 0,
  "quality_check": {
    "consistency": "ok|warn|ng",
    "completeness": "ok|warn|ng",
    "coherence": "ok|warn|ng",
    "clarity": "ok|warn|ng"
  },
  "artifacts": [
    "requirements/requirements.json",
    "requirements/requirements.md"
  ]
}
```

作業中の質問履歴・回答履歴・サイクルごとの詳細はこの scratch 内で管理してよいが、
収束後に下流が必要とする結論はすべて requirements.json 側に反映済みであることを確認する。

---

## 3. 本体（verbose）: `design_doc/{機能名}/requirements/requirements.md`

人間レビュー用の全詳細。distilled の各項目を散文で展開し、既存コード分析・リスク・
意思決定の経緯・代替案の検討を含める。下流フェーズは既定で読まない（監査と人間レビュー用）。

**書き方（共有契約 §6 準拠）**:
- 概要（What）は2〜3文。同一の詳細文を概要・スコープ・機能要件に多重再掲せず、正本の節を1つ決めて他は「§N 参照」で指す。
- 本文は**現在形の最終状態のみ**。「当初〜だったが〜へ変更」等の経緯は「レビュー討議の決定」等の経緯専用節へ隔離する。
- レビュー指摘 ID（【H-2】等）を本文の主語・ラベルにしない。末尾括弧のトレーサビリティ補助に限定する。

---

## 4. 調査（research）: `design_doc/{機能名}/research/research.json`

Researcher の verdict を集約する台帳。**書くのは親（要件エージェント）のみ**
（researcher は自分の `research/{brief_id}/` 配下しか書かない — 並列競合防止）。
下流は既定で読まない（feasibility の正本は requirements.json 側。ここは監査・再調査用）。

```json
{
  "briefs": [
    {
      "brief_id": "INV-001",
      "status": "dispatched|resolved|expired|escalated",
      "dispatched_at": "YYYY-MM-DD",
      "resolved_at": "YYYY-MM-DD",
      "retry_count": 0,
      "verdict": { "...": "researcher が返した verdict JSON をそのまま格納（改変しない）" }
    }
  ]
}
```

- **原子性（1 brief = 1 エントリ）**: brief 単位で追記・更新する。1つの brief の結果を
  複数エントリに分割しない。verdict は researcher の返答をそのまま格納する（親が要約・改変しない）。
- **status の終端**: 全 brief は最終的に `resolved`（verdict 回収済み）/ `expired`（起動失敗・
  再試行後も回収不能）/ `escalated`（unknown 継続でユーザー判断へ）のいずれかで終わる。
  `dispatched` のまま放置しない（終端規則は phase-workflow.md Phase 3/4 参照）。

---

## 5. 変更要求台帳（assurance）: `design_doc/{機能名}/assurance.json`

フェーズ横断の台帳。設計フェーズが「要件の前提が崩れた」と発見した時に**変更要求（CR）**を
追記し、要件フェーズがその決着を書く（design→requirements 還流の運搬体。
発行側の規律は `~/.claude/agents/hahifuhe-architect.md`、受領側の再開手順は
`phase-workflow.md`「変更要求（CR）受領時の再開手順」、還流の全体フローは
autonomous-dev `pipeline.md`）。将来はリスクエントリ（`type: "risk"`）を同居させる予定のため、
エントリは `type` で型分けする（P1 拡張の前方互換）。

```json
{
  "schema_version": 1,
  "entries": [
    {
      "id": "CR-001",
      "type": "change_request",
      "status": "open|accepted|rejected|superseded",
      "issued_by": "design",
      "issued_at": "YYYY-MM-DD",
      "kind": "feasibility_change|contradiction|constraint_discovered",
      "target_requirement_ids": ["FR-001"],
      "based_on_requirements_version": "1.2.0",
      "summary": "何が崩れたか（1-2行・平文）",
      "evidence": [{ "label": "fact", "statement": "根拠", "source": "file:line / URL" }],
      "proposed_action": "要件側への提案（緩和・代替・wont_have 化など。決めるのは要件フェーズ）",
      "resolution": null
    }
  ]
}
```

**記入規則**:
- **発行（設計側）は append-only**。既存エントリの書き換え・削除は禁止。要件 JSON も書き換えない。
- **fact evidence 必須**: `evidence[]` に `label: fact` の一次情報（実コード file:line / 公式 docs URL）が
  1件以上ないエントリは発行できない（好み・設計趣味による差し戻しの排除）。
- `based_on_requirements_version` は発行時点の `requirements.json` の `version` を転記する
  （版付き変更要求 — どの要件版への指摘かを照合可能にする）。
- **決着を書くのは要件フェーズのみ**。決着時に `status` を更新し `resolution` を埋める:
  ```json
  { "resolved_at": "YYYY-MM-DD", "action": "要件をどう変えたか / 却下理由",
    "requirements_version_after": "1.3.0" }
  ```
  - `accepted` = 要件を変更した（該当 FR の feasibility は `unverified` に戻して再検証。version bump 必須）
  - `rejected` = 要件は変えない（理由を action に明記。同一 kind × 同一 target への再発 CR は
    circuit breaker 対象 — autonomous-dev `guards.md`）
  - `superseded` = 後続 CR に置き換えられた（後続の id を action に記録）
- `kind` の使い分け: `feasibility_change` = 検証済みだった実現方法が事実で覆った /
  `contradiction` = 要件同士・要件と既存システムの矛盾 / `constraint_discovered` = 要件が想定しない新制約。

---

## フィールド説明

### functional_requirements の criticality（MoSCoW）

| 区分 | 説明 | 収束への影響 |
|----|------|------|
| must_have | 必須（収束に必要） | id + acceptance + **feasibility を必ず付与**（収束条件⑤） |
| should_have | 重要（できれば解決） | id 付与推奨。feasibility は任意 |
| could_have | あると良い | 残っても収束可。feasibility は任意 |
| wont_have | 今回は実装しない | スコープ外の明示 |

### feasibility（実現可能性・ツインピークスモデル）

要件は「この方法で実現できる」という裏付けとセットで初めて収束と認める。
must_have の各項目に feasibility を必須で付与し、全件が `verified` / `verified_conditional` に
なるまで収束しない（収束条件⑤・`entropy-evaluation.md` 参照）。

| status | 意味 | 収束 |
|----|------|------|
| unverified | 実現方法が未検証 | **不可**（調査 or 既存コード確認が必要） |
| verified | 一次情報で実現可能と確認済み | 可 |
| verified_conditional | 条件付きで実現可能（`conditions[]` に成立条件を明記） | 可 |
| risk_waived | fact の裏付けが取れないまま、**リスクを承知でユーザーが明示的に受け入れた** | 可（受け入れ記録必須） |
| infeasible_rejected | 実現不能と判明 | **不可** — `wont_have` へ移動するか要件を再交渉するまで収束できない |

- `evidence[]` には fact / inference / speculation のラベルを必ず付ける。
  `verified` / `verified_conditional` には **`label: fact` の一次情報（公式ドキュメント URL または
  実コード file:line）が1件以上必須**。
- **ユーザー判断で作れるのは `risk_waived` のみ**（`verified` にはできない — 検証済みと
  リスク受け入れを混ぜない）。`risk_waived` には fact evidence の代わりに、ユーザーが
  受け入れた事実（日付・発言要旨）を evidence に記録する。
- `verified_by` は裏付けの出どころ: Researcher の verdict（`research/research.json#INV-xxx`）、
  既存コードの前例（`existing-code`）、ユーザーの明示受け入れ（`user-decision` = risk_waived 専用）のいずれか。
- **existing-code パスの排他条件**: 外部プラットフォーム/サービスの仕様に依存する要件
  （phase-workflow.md のルーブリック1該当）には `existing-code` を使えない。外部仕様は
  Researcher の external 調査が必須（内部前例は外部仕様の変更を保証しないため）。
- `basic.how`（実現方法の大枠1行）は機能全体の方向性、feasibility は **FR 単位の裏付け**。役割が異なる。

### unknowns の criticality（解決優先度: must > should > could）

| criticality | 説明 | 扱い |
|----|------|------|
| blocked_by | ブロッカー | 最優先で解決（収束前に必須） |
| must | 必須 | 収束前に解決 |
| should | 重要 | 解決 or `unknowns_deferred_to_design` へ |
| could | 任意 | 残っても収束可 |

### unknowns_deferred_to_design（selection gate — 未決事項を下流へ運ぶ型）

要件フェーズで解消しきれなかった論点を、**仮定で埋めて進めるのでも、質問文だけで放り投げるのでもなく**、
「決められる状態」に整えて設計フェーズへ運ぶための欄。以下を契約とする。

- **質問文だけのエントリは禁止**。`resolution_mode`・`decision_condition`・`blocks` を必ず埋める。
  埋められない（決める条件すら言えない）論点は unknown として要件フェーズ内で先に整理する。
- `resolution_mode` は決着のさせ方の判別子:
  - `fact_finding` = 技術的事実で決まる（調査・実測・既存コード確認で決着。決めるのは設計/実装エージェント）
  - `user_decision` = トレードオフ判断で決まる（決めるのはユーザー。`options[]` に選択肢と「選ぶと何が起きるか」を必ず用意する）
- `blocks` は未解決のまま先へ進めない範囲: `design`（設計を止める）/ `implementation`（設計は
  進めてよいが実装開始前に決着必須）/ `none`（実装後でも差し替え可能な選択）。
- **解決状態（status）はこの欄に持たせない**。決着の記録は設計フェーズ成果物の
  `resolves` / `unresolved` が正本（真実の二重化を避ける。受領側の規律は
  `~/.claude/agents/hahifuhe-architect.md` の「unknowns の受領規律」節）。
- 決着の証拠は2型を混ぜない: `fact_finding` の決着には fact 一次情報（file:line / URL）、
  `user_decision` の決着にはユーザーが決めた事実（日付・発言要旨）を記録する
  （feasibility の verified / risk_waived を混ぜない規律と同じ思想）。
- `options[]` は任意だが、`user_decision` では必須。技術語でなく「選ぶと何が起きるか」で書く。
- 欄を埋めるための調査を新たに始めない（それは unknown の解決であり、この欄の仕事ではない）。
  既に手元にある情報で書ける範囲を書く。**この欄は最小限に保つ** — 空欄埋めの儀式にしない。
