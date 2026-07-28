# トークン効率と蒸留引き渡し（hahifuhe シリーズ共通契約）

> **位置づけ**: これは hahifuhe シリーズ全フェーズ（agents / commands / skills）が従う**唯一の共有契約**。
> 目的は「**俺様シリーズの品質（厳密なプロセス・レビュー深度・意思決定の追跡可能性）を一切落とさずに、
> フェーズ間引き渡しで消費されるコンテキスト（トークン）を削減する**」こと。
> 形式の正本は gen/2.5（`design_doc/gen2.5/**`）で実運用されている context.json / manifest.json を逆抽出したもの。

---

## 1. 根本原則：「本体（verbose）」と「引き渡し（distilled）」を分離する

各フェーズは 2 種類の成果物を持つ。**次フェーズが既定で読むのは distilled だけ**。

| 区分 | 役割 | 例 | 次フェーズの扱い |
|---|---|---|---|
| **本体（verbose）** | 人間レビュー用の全詳細。コード片・スキーマ全文・図を含む | `requirements.md` / `design/architecture.md` / `design/api-design.md` | **既定で読まない**。distilled で不足した時だけ、該当セクションをピンポイント参照 |
| **引き渡し（distilled）** | 次フェーズが意思決定に必要な要点だけを構造化 | `requirements/requirements.json`*(後述)* / `design/context.json` / `implementation/context.json` | **既定でこれを読む** |
| **フェーズ内部（scratch）** | そのフェーズの作業状態。収束追跡・履歴・チェックリスト | `requirements/process_state.json` / `design/design-progress.json` | **下流では絶対に読まない** |

> トークン削減の本質は「architecture.md が 50KB でも、実装フェーズは 10KB の design/context.json だけ読めば判断できる」状態を作ること。
> 本体を小さくするのではなく、**読むものを小さくする**。

---

## 2. 中央インデックス：manifest.json を「最初に1回だけ」読む

各機能ディレクトリ直下に `manifest.json` を置く。**どのフェーズも、まずこれを読んで現在地を把握**し、
必要な distilled だけを選んで開く。全成果物を走査してはいけない。

```jsonc
{
  "theme": "feature-key",
  "title": "...", "description": "...", "branch": "...", "generated_at": "YYYY-MM-DD",
  "phases": {
    // 14 フェーズ。各値は「軽い状態のみ」（本文は持たない）
    "brainstorm":         { "status": "completed", "artifact": "brainstorm.json" },
    "consulting":         { "status": "skipped" },
    "research":           { "status": "skipped" },
    "requirements":       { "status": "completed", "version": "1.2.0", "handoff": "requirements/requirements.json" },
    "review-requirements":{ "status": "completed" },
    "design":             { "status": "completed", "version": "1.5.0", "handoff": "design/context.json", "changes": "版差分の要約（1行ずつ）" },
    "review-design":      { "status": "completed" },
    "test-design":        { "status": "completed", "handoff": "design/test-plan.json" },
    "task-split":         { "status": "completed", "handoff": "task-split/tasks.json" },
    "implementation":     { "status": "in_progress", "handoff": "implementation/context.json" },
    "test":               { "status": "pending" },
    "review-all":         { "status": "pending" },
    "review-discuss":     { "status": "pending" },
    "create-pr":          { "status": "pending" }
  },
  "current_phase": "implementation",
  "current_phase_status": "in_progress",
  "next_action": "次にやる1アクション（人間/エージェントが即読める粒度）",
  "open_design_questions": [],
  "address_items_pending": [], "address_items_completed": [],
  "context": { "source_system": { /* 要約 */ }, "target_system": { /* 要約 */ } }
}
```

**ルール**
- `phases.*` には**本文を入れない**（status / version / handoff パス / 1行 changes のみ）。
- フェーズ完了時に、そのフェーズの担当が `manifest.json` の該当エントリと `current_phase` / `next_action` を更新する。
- 下流フェーズは `manifest.json` → 必要な `handoff` ファイルの順で読む。verbose 本体は開かない。

---

## 3. フェーズ別 distilled スキーマ（最小契約）

### 3.1 要件 → 設計の引き渡し: `requirements/requirements.json`
要件の構造化版。設計フェーズはこれを読む（`requirements.md` は人間レビュー用）。
最低限: `basic{what,why,who,where,when,how}` / `constraints` / `assumptions{confirmed,...}` /
`functional_requirements{must_have[],should_have[],...}` / `nfr` / `acceptance_criteria[]` / `scope{in,out}`。
- **scratch**: `requirements/process_state.json`（entropy_progression / cycles / unknowns_* / quality_check）→ 下流非参照。

### 3.2 設計 → 実装の引き渡し: `design/context.json`（最重要・トークン削減の主役）
architecture.md（大）を読ませず、**設計判断だけ**を渡す。
```jsonc
{
  "theme": "...", "design_version": "1.5.0", "designed_at": "YYYY-MM-DD",
  "chosen_strategy": { "name": "...", "summary": "...", "rationale": ["..."] },
  "rejected_alternatives": [ { "name": "...", "reason": "..." } ],
  "key_design_decisions": [
    { "id": "DD-001", "decision": "...", "rationale": "...", "resolves": "UNK-005" }
  ],
  "assumptions_confirmed": ["..."],
  "unresolved": []
}
```
- **verbose**: `design/architecture.md` / `design/api-design.md`（コード片・スキーマ全文・図はこちら）。
- **scratch**: `design/design-progress.json` → 下流非参照。

### 3.2b フェーズ横断台帳: `assurance.json`（機能ディレクトリ直下）

design→requirements 還流の運搬体。設計フェーズが変更要求（`type: "change_request"`）を
append-only で追記し、要件フェーズが決着（`resolution`）を書く。スキーマの正本は
`hahifuhe-entropy-requirements/references/requirement-schema.md` §5（ここに複製しない）。
- 位置づけは research.json と同じ「台帳」型: 特定フェーズの handoff ではなくフェーズ横断。
  manifest の `phases.*` には載せない（還流の発生は `pipeline.md` の手順で処理する）。
- 実装以降の下流フェーズは既定で読まない（上流間の還流専用。下流→上流の還流は P3 で拡張予定）。

### 3.3 タスク分割: `task-split/tasks.json`
```jsonc
{ "meta": {...}, "shared_interfaces": { "fnName": "/* 型・契約 */" },
  "tasks": [ { "id": "be-foundation", "title": "...", "scope": "...", "ac_ids": ["FR-1"], "depends_on": [], "type": "be", "granularity_rationale": "..." } ] }
```

### 3.4 実装 → レビュー/PR の引き渡し: `implementation/context.json`
実装で下した決定・レビュー対応・PR準備・テスト結果の記録。レビューフェーズはこれ＋diff を読む（verbose 本体は読まない）。
```jsonc
{ "theme": "...", "status": "complete",
  "decisions": [ { "id": "D-001", "area": "...", "decision": "...", "rationale": "...", "alternatives_rejected": ["..."] } ],
  "address_items": { "v1_total": 13, "v1_completed": 13, "v2_items": ["..."], "v2_reject": ["..."], "v2_defer": ["..."] },
  "unresolved": [], "pr_readiness": { "PR1": { "tasks": ["..."], "status": "complete" } },
  "test_results": { "...": "259/259 PASS" } }
```

---

## 4. 各フェーズ担当（agent / skill）が守る読み込み規律

1. **入力は manifest → handoff の順**。前フェーズの verbose 本体（`*.md`）を既定で読まない。
   不足時のみ、`design/context.json` が指す DD-id 周辺の architecture.md 該当セクションをピンポイントで開く。
2. **コードベース走査はスコープ限定**。
   - ❌ 旧 architect の「全サービス package.json / apps・packages 全構造 / 全インフラ構成を必ず読む」無条件スキャンは廃止。
   - ✅ 「当該機能が触るパッケージ・近接モジュールに限定して」読む。広域把握が要る時は manifest.context の source/target_system 要約で代替し、足りなければ対象を名指しで追加。
   - コード読解は Serena（シンボル単位）優先。`Read` での全文読みは原則禁止（CLAUDE.md / code-navigation 準拠）。
3. **成果物は本体と distilled を必ず両方更新**し、`manifest.json` の該当エントリ（status / version / handoff / next_action）も更新する。
4. **scratch（process_state.json / design-progress.json）には作業状態のみ**を書き、下流に必要な情報は必ず distilled 側へ昇格させる。
5. **二重読み禁止**: 同一情報を verbose と distilled の両方から読まない。distilled を正とする。

---

## 5. 品質を落とさないための担保

トークン削減で**捨ててはいけない**もの（俺様シリーズの品質の核）:
- 設計判断の **rationale と却下した代替案**（`key_design_decisions` / `rejected_alternatives` に必ず残す）
- 要件の **acceptance_criteria と must_have**（要件↔設計↔実装の整合性レビューの基盤）
- レビュー指摘への **対応/却下/先送りの判断記録**（`address_items`）

distilled は「要約して捨てる」ではなく「**判断に必要な事実を構造化して残し、説明文の冗長性だけ削る**」。
verbose 本体は削除せず保持する（人間レビューと監査のため）。次フェーズが既定で読まないだけ。

---

## 6. 記載規律（全フェーズ共通・本体 / distilled とも）

トークンと読み取り精度の両方を守る書き方の規律（2026-07-22 採用。根拠: workflow-archive の成果物一式で同一事実が約10コピーされ、改訂のたびに全コピーの書き換えが必要になっていた実測）。

1. **単一記載原則**: 1つの事実の正本は1節のみ。他の節からは「§N 参照」で指す。特に概要（What/サマリ）・スコープ・must_have に同一の詳細文を再掲しない。distilled と verbose の「同じ結論の構造化 vs 散文展開」は役割分担であり重複ではないが、**同一ファイル内・同一成果物セット内のコピペ再掲は禁止**。
2. **サマリ欄は2〜3文まで**: `basic.what` / 概要 / 設計方針サマリは2〜3文で言い切る。仕様の詳細（パラメータ値・分岐・保護機構）はサマリに詰め込まず、正本の節に置く。圧縮しすぎた10行級の一文は読み取り精度を落とす。
3. **本文は現在形の最終状態のみ**: 「当初〜だったが〜に変更」等の経緯を現在の仕様記述に織り込まない。経緯・旧案・却下理由は設計判断記録（DD）/ レビュー討議記録の節に隔離する（廃案を実装エージェントが拾う事故の防止）。
4. **レビュー指摘 ID・内部ラベル（【H-2】等）を本文の主語にしない**: 本文は平文で書き、ID は末尾括弧のトレーサビリティ補助（例: 「…を更新する（H-2）」）に限定する。
