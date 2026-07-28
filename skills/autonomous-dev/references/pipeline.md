# pipeline — 実行の正本（v3: ステージ名ベース・下流は Workflow 隔離）

フェーズは**番号でなく名前**で呼ぶ:
`requirements → design →〔autodev-downstream Workflow: implement → gate → review → fix → reverify〕→ reconcile → pr`

記法: **[Main]** = メインループが実行 / **[WF]** = autodev-downstream Workflow が自走 / ★ = 人間承認ゲート

> 引き渡し規律（全フェーズ共通）: まず `design_doc/{機能名}/manifest.json` を読み、入力は **manifest → 当該フェーズの handoff（distilled）** の順。verbose（`*.md`）は不足時のみピンポイント参照。正本: `token-efficient-handoff.md`。
> コード読解は Serena（フック設定によっては `Read` がコードにブロックされる環境があるため）。停止判断の基準は `guards.md`。

## 全体フロー

| ステージ | 駆動 | 入力 | 成果物 | ゲート |
|---|---|---|---|---|
| (任意) brainstorm/consult | [Main] | テーマ | `design_doc/{f}/brainstorm.json` | 要件へ進む合意 |
| **requirements** | [Main]対話 | アイデア | `requirements.md`（verbose）＋ `requirements/requirements.json`（distilled）＋ manifest 更新 | ★人間承認 |
| **design** | [Main]対話 | 承認済み requirements.json | `design/architecture.md`（＋API時 `api-design.md`）＋ `design/context.json`（distilled）＋ manifest 更新 | ★人間承認 |
| **implement〜reverify** | [WF] | 下記「下流の起動」 | コード＋テスト＋ `implementation/context.json` ＋ `reviews/` ＋ state/manifest 更新 | Workflow が GO を返す（内部: gate 緑 → review-all GO → audit.sh pass） |
| **reconcile** | [Main] | 最終コード＋design/* | `design/architecture.md`・`context.json` を実装と一致するよう**差分更新**（ゼロから書き直さない） | 実装との一致 |
| **pr** | [Main] | push 済みブランチ | `gh pr create --draft` で draft PR（base=既定ブランチ） | URL 取得。チケット URL 不明→AskUserQuestion |

## 上流① requirements（メインループが playbook 追従）

- `~/.claude/agents/hahifuhe-requirements.md`（or `hahifuhe-entropy-requirements` skill）の手順を**自分で実行**。サブエージェントに投げない（人間と対話できるのはメインループだけ）。
- **必ず目的・文脈（何のために・誰が・どの場面で）から始める**。詳細分岐（型・境界・TZ）は目的が固まってから。目的を語れない時は brainstorm/consult へ戻す。
- 質問は **AskUserQuestion でまとめて**（小出し厳禁）。着手前に曖昧カテゴリ（`guards.md`）を洗い出し1回で潰す。
- **不可逆な面（本番パス非侵襲・後方互換・回帰ゼロ）は受け入れ条件＝テスト可能な形で書く**。
- 成果物: verbose `requirements.md` ＋ distilled `requirements/requirements.json`（basic/constraints/functional_requirements/acceptance_criteria/scope。スキーマは共有契約 3.1）＋ scratch `requirements/process_state.json`。
- 完了: `bucket.sh phase <feature_dir> <run_dir> requirements completed requirements/requirements.json` → ★承認ゲート（`guards.md`）→ `bucket.sh write <run_dir> approvals.requirements true`。

## 上流② design（プランモード収束 → 合意した高度で authoring）

- `~/.claude/agents/hahifuhe-architect.md` の手順を追従。**着手時に自動でプランモードへ入り**、本質的分岐（技術選定・スキーマ形・API/メッセージ契約・キュー/worker トポロジ・結合方針）を閣下とのバッチ Q&A で収束させる（headless run では AskUserQuestion バッチで代替）。
- **合意した高度まで**を authoring（実装で揺れる細部は書かず reconcile で埋める）。設計レビューの独立ゲートは無い（設計の品質ゲート＝プランモードの人間収束。経緯は `rationale.md`）。
- 成果物: verbose `design/architecture.md`（コード片・スキーマ全文・図はこちら）＋ distilled `design/context.json`（chosen_strategy / rejected_alternatives / key_design_decisions{rationale,resolves}。スキーマは共有契約 3.2）。
- 完了: `bucket.sh phase ... design completed design/context.json` → ★承認ゲート → `approvals.design true`。

## design→requirements 還流（イベント駆動ループ: 設計知見で要件の前提が崩れた時）

設計中に architect が **must_have に影響する変更要求（CR）** を `design_doc/{機能名}/assurance.json` に
発行したら（発行規律: `agents/hahifuhe-architect.md`・スキーマ: `requirement-schema.md` §5）、
設計を収束させずに次の還流手順を回す:

1. **circuit breaker 判定**（`guards.md`「還流の circuit breaker」）: 該当なら自走せず閣下へ。
2. **requirements へ戻る**: `phase-workflow.md`「変更要求（CR）受領時の再開手順」で再収束
   （feasibility を unverified に戻す → 再検証 → CR に決着を記録 → version bump）。
3. **承認の失効**: 要件 version が変わったら `bucket.sh write <run_dir> approvals.requirements false` と
   `approvals.design false` を**必ず**実行する（**承認は承認時の成果物 version に対するもの** —
   version が変われば旧承認は無効。設計は stale 扱いになる）。
4. **★要件の再承認** → **design を差分更新で再開**（ゼロから書き直さない。CR で崩れた前提に
   関わる DD だけ見直す）→ **★設計の再承認**。
5. 下流が既に起動済みで還流が起きた場合（reverify 中の発覚等）は、下流を止めてから上記を回す
   （承認失効中に下流を走らせない）。

> 版結び付けの機械検証（digest 照合を audit.sh に実装）は P2 で導入予定。現時点では本手順の
> 遵守が正本（承認失効の書き込みを省略しない）。

## 下流の起動（implement〜reverify を Workflow に委譲）

前提: `approvals.requirements` と `approvals.design` が true（未承認では起動しない）。

**selection gate チェック（起動前・必須）**: `design/context.json` の `unresolved` に
`blocks: implementation` の gate が残っていたら**実装を起動しない**（NEEDS_HUMAN 相当）。
`resolution_mode: user_decision` なら AskUserQuestion で `options` を提示して決着させ、
`fact_finding` なら `decision_condition` の材料を取って決着させ、決着を design/context.json の
`resolves`（resolution_evidence 付き）へ記録してから起動する。`blocks: none` の gate は残っていてよい。
（gate 契約の正本: `hahifuhe-entropy-requirements/references/requirement-schema.md`・受領規律は `agents/hahifuhe-architect.md`）

1. run が無ければ `bash scripts/bucket.sh init <機能名>` → `<run_dir>`。develop 直なら先にブランチを切る。
2. **Cursor 経路（既定）の明示許可を閣下から一度取る**（headless `--force` は承認ゲートを切る操作のため。拒否時は `implBackend:'agent'`）。
3. 起動（`date +%Y%m%d-%H%M%S` 等で ts を作って渡す。Workflow 内では時刻取得不可）:

```
Workflow({ name: 'autodev-downstream', args: {
  featureDir: '<repo>/design_doc/<機能名>', runDir: '<run_dir>', repoRoot: '<repo>', branch: '<branch>',
  requirementsPath: '<featureDir>/requirements/requirements.json',
  designContextPath: '<featureDir>/design/context.json',
  implBackend: 'cursor',            // 明示許可が無い時は 'agent'
  model: 'opus',                    // 必須（コスト事故防止）: 未指定だと全 agent がセッションのモデルを継承する。子 review-all にも引き継がれる
  runId: '<run_id>', ts: '<ISO/epoch>', attempt: 0
}})
```

4. **返り値の処理**:
   - `status:'GO'` → warnings を閣下に報告し reconcile へ。
   - `status:'GO_WITH_AUDIT_GAPS'` → audit.missing を確認・充足してから進む。
   - `status:'NEEDS_HUMAN'` → `guards.md` の停止→再開手順（escalate → AskUserQuestion → answer → **resumeFromRunId ＋ attempt+1 で再投入**）。
5. 実装の重い反復・レビュー所見は Workflow 側に隔離される。メインは判定と NEEDS_HUMAN 往復だけを扱い、**所見全文を文脈に読み込まない**（レポートはファイルパスで受け取り、修正も Workflow 内で完結済み）。

## reconcile（設計書の最終化）[Main]

レビュー収束後の最終コードと `design/architecture.md`＋`design/context.json` を突き合わせ、実装で確定/変更された構造を**差分反映**。load-bearing 決定の why（コード内コメント＋DD の却下案）が辿れる状態にする。conformance レビューは要件↔実装で見るため、review はこのステージを待たない。

## pr [Main]

draft PR を作成（`gh pr create --draft`。base=既定ブランチ・既定レビュアー。プロジェクトに PR 作成用スキルがあればそれを使う）。任意で `pr-inline-adr`。PR 作成後に実 Cursor Bugbot のループを求められたら `bugbot-loop`。完了報告の前に `bash scripts/audit.sh <feature_dir> <run_dir>` が pass であることを確認（fail なら不足を埋める。これが完了条件の機械検証）。

## manifest.json との対応（共有契約の 14 フェーズ語彙は変更しない）

`bucket.sh phase` が自動でマッピングする: requirements→`requirements` / design→`design` / implement→`implementation` / review→`review-all` / pr→`create-pr`。**gate・fix・reverify・reconcile は run 内部ステージ**＝state.json のみに現れ、manifest には書かない。brainstorm/consulting/research/test-design/task-split 等は必要時のみ手動更新（俺様の他スキルと共有の語彙）。

## state.json（run の実行制御。成果物の進行は manifest.json）

```json
{ "feature": "...", "run_id": "YYYYMMDD-HHMMSS", "phase": "implement", "stage": "implement",
  "stopped": false, "approvals": { "requirements": true, "design": true },
  "gates": { "typecheck:@yourorg/server-core": { "green": true, "exit": 0, "log": "..." } },
  "review": { "verdict": "GO", "finalVerdict": "GO", "reportPath": "..." },
  "iterations": {}, "escalations": 1 }
```

- 置き場: `design_doc/{f}/autodev/{run_id}/state.json`＋`escalations.jsonl`（`.gitignore` 対象。PR に乗せない）。
- 読み書きは `bucket.sh`（init/read/write/gate/escalate/answer/phase）。`phase` は state と manifest を同時更新する。
- 再開: 起動時に `bucket.sh read <run_dir>` で現在地確認。`stopped:true` なら最新 escalation を AskUserQuestion → `answer` → Workflow を resumeFromRunId で再投入。
