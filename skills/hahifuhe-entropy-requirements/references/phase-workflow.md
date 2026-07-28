# フェーズ詳細ワークフロー

> 成果物の3分類・読み込み規律は共有契約
> `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md` に従う。
> requirements.json = distilled 引き渡し / requirements.md = 本体（verbose）/ process_state.json = scratch。

## Phase 1: 初期化フェーズ

### 目的
要件情報JSON（distilled）とプロセス状態JSON（scratch）を作成し、初期unknownsを設定する。

### 入力
- ユーザーからの要求（自然言語）

### アクション
1. `design_doc/{機能名}/requirements/` ディレクトリを作成
2. `requirements/requirements.json` を空テンプレートから作成（distilled 引き渡し）
3. `requirements/process_state.json` を作成（scratch・下流非参照）
4. ユーザー要求から初期情報を抽出
   - basic.what, basic.why を設定
   - 初期unknownsを設定

### 出力
- `requirements/requirements.json`（初期状態）
- `requirements/process_state.json`（初期状態）

### 報告例
```markdown
## Phase 1: 初期化完了

- 作成: `design_doc/{機能名}/requirements/requirements.json`
- 作成: `design_doc/{機能名}/requirements/process_state.json`
- 初期unknowns: N件
- 現在のエントロピー: 高

次のPhase: 既存コード分析
```

---

## Phase 2: 既存コード分析フェーズ

### 目的
**当該機能が触る範囲に限定して**既存コードを分析し、制約とパターンを抽出する。

### スコープ規律（共有契約 §4 準拠）
- ❌ 「全サービス・全パッケージ・全インフラを必ず読む」無条件スキャンは禁止。
- ✅ 当該機能が触るパッケージ・近接モジュールに限定して読む。広域把握が要る時は
  `manifest.json` の `context.source/target_system` 要約で代替し、足りなければ対象を名指しで追加する。
- コード読解は **Serena（シンボル単位）優先**（`find_symbol` / `get_symbols_overview` /
  `find_referencing_symbols` / `search_for_pattern`）。型・実装関係・コールグラフが論点なら LSP。
  `Read` での全文読みは原則禁止（CLAUDE.md / code-navigation 準拠）。

### アクション
1. 機能が触る対象モジュールを名指しで特定（広く検索しない）
2. Serena でシンボル単位に該当箇所だけ読む
3. 設計パターン・制約を抽出
4. 新たなunknownsを追加

### 分析観点（対象モジュール内に限定）
- API パターン（エンドポイント形式、レスポンス形式）
- データモデル（既存エンティティ、スキーマ）
- インテグレーションポイント（外部連携）
- ビジネスロジック（ドメイン知識）

### 出力
- 分析の**結論**（制約・前提）を distilled の `constraints` / `assumptions` / `dependencies` に反映
- 関連ファイルの全リストやパターン詳細は本体 `requirements.md` 側に記録（下流は既定で読まない）
- 新たなunknowns追加

### 報告例
```markdown
## Phase 2: 既存コード分析完了

### 関連ファイル
- `src/api/xxx.ts` (high) - API定義
- `src/models/yyy.ts` (medium) - データモデル

### 発見した制約
- 既存のEventBrokerを使用する必要あり
- REST API形式を踏襲

### 新たなunknowns
- EventBrokerの拡張方法は？(must)

次のPhase: 質問生成
```

---

## Phase 3: 質問生成・調査ディスパッチフェーズ

### 目的
優先度の高いunknownsを「人に聞く」か「調査で解く」かに振り分け、
質問提示と Researcher 起動を並行して進める（ツインピークスのらせん）。

### ルーティング分岐（最初に必ず行う）

| unknown の性質 | ルート |
|---|---|
| 人にしか答えられない（意図・好み・ビジネス判断・優先順位） | **grill 質問**（従来通り・1ターン1論点） |
| 調査で解ける（外部 API 仕様・ライブラリ制約・既存コードの実態） | **`investigations_required` に登録 → Researcher 起動** |

調査で解ける unknown をユーザーに聞かない（grill 作法「コードで分かることは聞かない」の拡張）。
調査はユーザーへの質問と**並行してよい**（待ち時間の有効活用）。verdict の反映は Phase 4 で行う。

### アクション
1. unknownsを優先度でソート
   - blocked_by > must > should > could
2. 各 unknown を上記ルーティングで振り分け
3. 【調査ルート】`investigations_required` の pending 項目を research brief に束ね、
   `hahifuhe-researcher` を Task ツールで起動（下記テンプレート・**最大4並列**）。
   起動した項目は `status: dispatched` に更新し、`research.json` に brief エントリを追記
4. 【質問ルート】最優先のunknownから質問を生成・提示（1ターン1論点）
5. `question_history` に記録

### 調査の終端・回復規則（dispatched を迷子にしない）

- **起動失敗 / timeout / 空応答**: 同じ brief で**1回だけ再起動**（`retry_count` を加算）。
  再失敗したら `status: expired` にし、その調査質問は **grill 質問へ転換**する
  （判明している事実を添えて、ユーザーに判断を仰ぐ）
- 全 brief は最終的に `resolved` / `expired` / `escalated` のいずれかに必ず到達させる。
  `dispatched` のまま次の収束判定に進まない（収束判定時に dispatched が残っていたら未収束扱い）

### Researcher 起動テンプレート

関連する unknown は1 brief に束ねてよい（brief 単位で1エージェント）。

```
Task ツール:
  subagent_type: "hahifuhe-researcher"
  description: "実現性調査: {brief の主題}"
  prompt: |
    あなたは hahifuhe-researcher です。
    ~/.claude/agents/hahifuhe-researcher.md を読み、そのルールに従ってください。

    ## Research Brief
    {
      "brief_id": "INV-XXX",
      "feature_dir": "design_doc/{機能名}",
      "decisionToSupport": "何を決めるための調査か",
      "researchType": "internal | external | mixed",
      "whyResearchNeeded": "なぜ質問でなく調査か",
      "subQuestions": ["具体的な調査質問（1〜5個）"],
      "doneWhen": "どの状態なら要件定義に戻れるか",
      "relatedRequirements": ["FR-001"]
    }

    ## プロジェクトコンテキスト
    {対象機能の1-3行説明・関連パッケージ名}

    最終メッセージは出力契約の verdict JSON + 3行以内のサマリーで返してください。
```

### 質問形式
```markdown
Q{N}（{criticality}）: {質問文}

選択肢（該当する場合）:
- A) ...
- B) ...
- C) ...

または自由回答でお願いします。
```

### 出力
- ユーザーへの質問提示
- Researcher の起動（該当する調査 unknown がある場合）
- `requirements/process_state.json` に質問履歴・investigations_required の状態を記録（scratch・下流非参照）

---

## Phase 4: 回答・verdict 分類フェーズ

### 目的
ユーザーの回答と Researcher の verdict を適切なフィールドに分類し、JSONを更新する。

### アクション
1. 回答を解析
2. 適切なフィールドを特定
   - 機能要件 → `functional_requirements`
   - 制約 → `constraints`
   - 前提 → `assumptions`
   - etc.
3. `requirements/requirements.json`（distilled）を更新
4. 回答経緯は `requirements/process_state.json`（scratch）に記録
5. 関連するunknownを解決済みにマーク
6. 【Researcher の verdict 反映】完了した調査ごとに:
   - verdict を `research/research.json`（distilled 集約・親が書く）の該当 brief エントリへ
     **そのまま格納**（原子性: 1 brief = 1 エントリ・親が要約・改変しない）。
     manifest の `research` エントリも更新
   - 対応する must_have の `feasibility` を更新
     （verdict: feasible → `verified` / conditional → `verified_conditional` + conditions 転記 /
     infeasible → `infeasible_rejected` → **リカバリへ**（Phase 5 末尾参照））
   - **verdict: unknown の脱出経路（無限ループ禁止)**: 再調査（subQuestions の再設計）は
     **1 brief につき1回まで**。それでも unknown なら brief を `status: escalated` にして
     ユーザーへ提示し、次のどちらかで終端する:
     (i) ユーザーがリスク承知で受け入れ → feasibility を `risk_waived` に
     （受け入れの日付・要旨を evidence に記録。**`verified` にはしない**）
     (ii) 要件を変える → 要件を書き換えて feasibility を `unverified` から再スタート
   - `investigations_required` の該当項目を `status: resolved`、`verdict_ref` を記録
   - verdict の `impact_on_requirements` が constraints / scope に及ぶ場合はそちらも更新

### 分類マッピング
| 回答内容 | 分類先 |
|----------|--------|
| 機能の説明 | functional_requirements |
| 技術的制約 | constraints.technical |
| ビジネス制約 | constraints.business |
| 前提条件 | assumptions |
| スコープ判断 | scope |
| 成功基準 | success_criteria |

### 出力
- `requirements/requirements.json` 更新（distilled が正本）
- `requirements/process_state.json` の作業状態更新（scratch）

---

## Phase 5: 不足検知・実現可能性チェックフェーズ

### 目的
新たなunknownsを検出し、既存コードとの整合性と must_have の実現可能性をチェックする。

### アクション
1. 回答から派生する新たな疑問を検出
2. 既存コードとの整合性をチェック
3. **実現可能性チェック**: must_have 各項目の `feasibility.status` を確認し、
   `unverified` は下記ルーブリックで判定
4. 新たなunknownsを追加
5. 既存unknownsの優先度を更新

### 実現可能性の要調査ルーブリック

`unverified` の must_have が以下の**いずれか**に該当したら、調査 unknown を
`investigations_required (must)` に登録する（→ 次の Phase 3 で Researcher 起動）:

1. **外部プラットフォーム/サービスの仕様に依存**（例: LINE Messaging API の制約、AWS クォータ）
2. **プロジェクト未使用のライブラリ / AWS サービスに依存**
3. **既存コードに前例パターンが無い**実現方式を前提にしている

**自己完結 verified パス（調査の過剰起動を防ぐ）**: Phase 2 の既存コード分析で
同等の前例（file:line）が確認できている場合は、それを `label: fact` の evidence として
`verified_by: "existing-code"` で直接 `verified` にしてよい。Researcher 起動は不要。
**排他条件**: ルーブリック1（外部プラットフォーム/サービス仕様依存）に該当する要件には
このパスを使えない — 内部の前例は外部仕様の現行有効性を保証しないため、external 調査必須。
existing-code が使えるのは内部実装だけで完結する要件（ルーブリック2・3のみ該当）に限る。

### infeasible_rejected のリカバリ（必須）

verdict が infeasible / conditional で must の成立が崩れた場合は、収束へ進まず以下のいずれかを行う:

- **(a) トレードオフ提示**: verdict の evidence を添えて、要件の緩和・代替案・wont_have 化を
  ユーザーに提示する（grill 作法維持・1ターン1論点・推奨案を必ず添える）
- **(b) 代替案の発散**: 選択肢が思いつかない場合、`hahifuhe-brainstorm-participant` を
  Task ツールで起動（**最大2並列**・テーマ「{要件} の代替実現方式」・
  `~/.claude/agents/hahifuhe-brainstorm-participant.md` を読ませる既存パターン踏襲）し、
  出てきた案を verdict の事実と突き合わせてから (a) の形でユーザーに提示する

ユーザーが要件を取り下げたら `wont_have` へ移動（理由を requirements.md に記録）。
緩和・代替で継続する場合は要件を書き換え、feasibility を `unverified` に戻して再検証する。
ユーザーが「fact の裏付けなしでもこのまま進める」と明示した場合のみ `risk_waived`
（受け入れの日付・要旨を evidence に記録。`verified` にはしない）。

### 検出パターン
- 「〜の場合はどうする？」→ 新たなunknown
- 「〜と矛盾する」→ 整合性課題
- 「〜が未定義」→ 完全性課題
- 「must なのに feasibility が unverified」→ 調査 unknown（上記ルーブリック）

### 出力
- 新たなunknowns追加（調査 unknown 含む）
- 課題リスト更新

---

## Phase 6: 品質検証フェーズ

### 目的
4要素のチェックリストを評価し、問題があればフィードバックする。

### アクション
1. 一貫性チェック
2. 完全性チェック
3. 整合性チェック
4. 明確性チェック
5. 品質サマリーを作成

### チェック詳細
`references/quality-criteria.md` を参照

### 出力
- 品質チェック結果
- 改善が必要な項目リスト

### 報告例
```markdown
## Phase 6: 品質検証結果

| 要素 | 状態 | 課題 |
|------|------|------|
| 一貫性 | ✅ | - |
| 完全性 | ⚠️ | 非機能要件が未定義 |
| 整合性 | ✅ | - |
| 明確性 | ⚠️ | 受け入れ基準が曖昧 |

### 改善が必要な項目
- 非機能要件（performance, security）を定義
- 受け入れ基準を測定可能な形式に
```

---

## Phase 7: 収束判定

### 目的
エントロピー評価を行い、収束条件を満たせば完了とする。

### アクション
1. エントロピーレベルを評価（高/中/低）
2. 収束条件をチェック
   - critical unknowns が空
   - must_have が完了
   - 品質基準達成
   - **実現可能性検証済み**（全 must_have の feasibility が verified / verified_conditional・条件⑤）
3. 収束判定を行う
4. 収束の場合：成果物確定へ（下記「収束時の必須アクション」）
5. 未収束の場合：Phase 3へ戻る

### 収束条件詳細
`references/entropy-evaluation.md` を参照

### 収束時の必須アクション（成果物確定）
1. **distilled 確定**: `requirements/requirements.json` の `status` を `completed`、`version` を確定、
   `entropy` を `low` に更新。下流（設計）が必要とする結論がすべて反映済みか確認する。
   - **条件の下流トレース（必須）**: `verified_conditional` の各 must_have は、`conditions[]` の
     内容を該当 FR の `acceptance` に転記する（例:「〜であること（前提: {condition}）」）。
     設計フェーズは feasibility を読まなくても acceptance は必ず読むため、条件が確実に届く。
     `risk_waived` の must_have は、受け入れの経緯を requirements.md（verbose）に記録し、
     `assumptions.unconfirmed` に「{FR-id}: 未検証のまま受け入れ（{日付}）」を追加する。
2. **selection gate の完全化（質問文だけの宿題は禁止）**: `unknowns_deferred_to_design` の各エントリに
   `resolution_mode`（fact_finding / user_decision）・`decision_condition`（何が揃えば決められるか＋材料の取り方）・
   `blocks`（design / implementation / none）を必ず埋める（schema と契約の正本: requirement-schema.md）。
   - `user_decision` のエントリは `options[]`（選ぶと何が起きるか）まで用意する。
   - 埋められないエントリは収束不可 — unknown に戻して Phase 3 へ（決める条件すら言えない論点を下流へ流さない）。
   - 解決状態はここに書かない（決着の記録は設計側 `resolves` / `unresolved` が正本）。
3. **本体生成**: `requirements/requirements.md`（verbose）を生成。distilled の各項目を散文展開し、
   既存コード分析の詳細・リスク・意思決定の経緯を含める。**下流は既定で読まない**。
4. **scratch 更新**: `requirements/process_state.json` の `status` を `completed`、`completed_at`・
   `entropy_progression`・`cycles_completed`・`unknowns_resolved`・`unknowns_deferred_to_design`・
   `quality_check` を確定（下流非参照）。
5. **manifest.json 更新（共有契約 §2 必須）**: `design_doc/{機能名}/manifest.json` の `requirements`
   エントリを `{ "status": "completed", "version": "x.y.z", "handoff": "requirements/requirements.json" }`
   に更新（無ければ作成）。`current_phase` / `current_phase_status` / `next_action` も更新する。
   `phases.*` には本文を入れない。

### 出力
- 収束判定結果
- 確定した distilled / verbose / scratch / manifest
- 次のアクション

### 報告例（収束時）
```markdown
## Phase 7: 収束判定

### ステータス: ✅ 収束

| 条件 | 状態 |
|------|------|
| Critical Unknowns | ✅ 0件 |
| Must-Have | ✅ 5件定義済み |
| 品質基準 | ✅ 全項目達成 |
| エントロピー | 低 |
| 実現可能性 | ✅ verified: 4, conditional: 1, waived: 0, unverified: 0 |

### 次のアクション
要件書（requirements.md）を生成し、設計フェーズへ移行します。
```

収束時は manifest の `research` エントリも確認する（調査を1件でも実行した場合は
`{ "status": "completed", "handoff": "research/research.json" }` になっているか）。

---

## 変更要求（CR）受領時の再開手順（design→requirements 還流）

設計フェーズが `design_doc/{機能名}/assurance.json` に発行した変更要求（CR）を処理して
要件を再収束させる手順（CR スキーマの正本: `requirement-schema.md` §5。還流の全体フローと
承認失効の規律: autonomous-dev `pipeline.md`「design→requirements 還流」）。

### 起動時チェック（毎回必須）

要件フェーズの開始・再開時は、Phase 1 の前に `assurance.json` の存在を確認し、
`status: open` かつ `type: change_request` のエントリがあれば**最優先で本手順に入る**
（新規 unknown より先に処理する — 還流は既承認の前提が崩れた状態であり、放置したまま
積み増した要件はすべて再収束の対象になるため）。

### 手順

1. **circuit breaker 判定（処理前に必ず）**: 該当 CR が autonomous-dev `guards.md` の
   還流 circuit breaker（同一 CR の再発 / 還流回数上限）に当たる場合は自走で処理せず、
   CR の内容を添えてユーザーへ相談する（autodev 文脈では NEEDS_HUMAN）。
2. **要件への反映**: 各 open CR について:
   - `target_requirement_ids` の各 FR の `feasibility.status` を `unverified` に戻す
   - CR の summary / evidence から unknown を追加（criticality: must。CR-id を記録して追跡可能にする）
   - `kind: contradiction` で要件同士の矛盾なら、矛盾する両 FR を unknown 化する
3. **再収束**: 通常の Phase 3〜7 ループを回す（収束条件⑤=実現可能性ゲートがそのまま効く。
   ユーザー判断が要る緩和・wont_have 化は Phase 5 の infeasible リカバリと同じ作法で提示する）
4. **CR の決着記録**: 収束時に各 CR の `status` を `accepted` / `rejected` にし、`resolution`
   （action / resolved_at / requirements_version_after）を埋める。決着を書くのは要件フェーズのみ。
5. **version bump と承認失効**: 要件を変更したら `requirements.json` の `version` を必ず上げる。
   version が変わった時点で既存の要件承認・設計承認は**失効**する（承認は承認時の版に対するもの）。
   失効の記録と再承認の段取りは `pipeline.md` の還流手順に従う。

---

## 他の役割への移行

### → Researcher（調査）
- 技術調査が必要になった場合（`investigations_required` に調査項目がある場合）
- 別役割への「移行」ではなく、**Task ツールで `hahifuhe-researcher` を起動する**
  （Phase 3 の起動テンプレート参照・最大4並列・要件定義は継続したまま）

### → Architect（設計）
- 収束条件を満たした後、設計に進む場合
- 条件: エントロピーが「低」、要件書が作成された

### → Implementer（実装）
- 要件が明確で、設計が不要な小規模変更の場合
