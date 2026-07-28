# guards — いつ止まって相談し、いつ自走するか（メインループ用の正本）

2つの停止レジーム:
- **上流（要件・設計）= 承認ゲート**: フェーズ完了ごとに必ず人間承認してから次へ（曖昧点の有無に関わらず）。要件の完全性が自走品質の天井。
- **下流 = 曖昧点だけ停止**: autodev-downstream Workflow が自走し、下記3カテゴリに当たると `NEEDS_HUMAN` を返して終了する。**グレーは停止側**（誤った自走、特に不可逆のコストは過剰停止より大きい）。

> ループ上限（客観ゲート5回・収束3回）・同一エラー再発・エラー増加・回帰の検知は
> **Workflow のコードに実装済み**（散文ルールではない）。上限到達も NEEDS_HUMAN で返る。

## 下流の3カテゴリ（Workflow 内エージェントの停止基準）

| カテゴリ | 代表例 |
|---|---|
| **ambiguous**（解釈が割れる） | 設計に無い振る舞いの選択 / 既存 API が設計前提と食い違う / 同要件で非機能特性が大きく異なる実装方式が複数 / テスト期待値が要件から一意に決まらない / 要件と設計の矛盾 |
| **irreversible**（不可逆） | DB の破壊的 migration / protobuf・公開 API の破壊的変更 / force push・履歴書き換え / 外部送信・課金・本番相当デプロイ・**PR 作成** / 大量削除・メジャーバージョン上げ |
| **subjective**（主観トレードオフ） | レビュー判定が割れる / 「設計自体の問題」に分類される指摘 / `as any`・`@ts-ignore` が要る / テストを通すために要件解釈を緩める / 可読性・性能・工数の優先が設計に無い |

✅ 自走してよい（Workflow が承認なしで進める範囲）: 型/lint の機械的修正（シグネチャ不整合・不足プロパティ・型不一致・import 解決）/ 実装バグ由来のテスト失敗修正 / Biome 自動修正 / minor・info findings / 設計に明記された通りの実装。

> 構造的・不可逆な決定（スキーマ形・契約・結合方針）は下流で拾うのではなく**設計のプランモードで先に固める**。下流の3問が見るのは実装中に新たに顕在化したものだけ。

## NEEDS_HUMAN スキーマ（Workflow の返り値）

```json
{ "status": "NEEDS_HUMAN", "phase": "implement|gate|review|fix|reverify",
  "items": [ { "reason": "...", "category": "ambiguous|irreversible|subjective", "options": ["案A", "案B"] } ],
  "runId": "...", "warnings": [] }
```

## 停止→再開の手順（メインループ）

1. Workflow が `NEEDS_HUMAN` を返す（または上流で不可逆を検知した）。
2. `bucket.sh escalate <run_dir> "<reason>" '<options_json>'` で記録（`.stopped=true`）。
3. **AskUserQuestion** で閣下に items/options を提示（複数 items はまとめて1回で）。
4. 回答を `bucket.sh answer <run_dir> "<回答>"` で書き戻す（`.stopped=false`）。
5. **同じ workflow を `resumeFromRunId` ＋ `args.attempt` を +1 して再投入**。完了済みステージはキャッシュ再生され、停止したステージだけが回答（escalations.jsonl）を読んで再実行される。

## 還流の circuit breaker（design→requirements ループの暴走防止）

design→requirements 還流（`pipeline.md`）は無限ループの芽を持つため、次のいずれかに当たったら
**自走で還流せず停止して相談する**（上流なら AskUserQuestion、autodev 下流文脈なら NEEDS_HUMAN）:

| 条件 | 判定方法 |
|---|---|
| **同一 CR の再発** | 新 CR の `kind` × `target_requirement_ids` が、過去に `rejected` された CR と一致（assurance.json を照合） |
| **還流回数の上限** | 同一機能の 1 run 内で還流サイクルが **3 回目**に達した（要件↔設計が2往復しても収束しない＝要件か設計の枠組み自体に問題がある兆候） |
| **fact evidence の無い CR** | そもそも発行不可（`requirement-schema.md` §5）。発行されていたら処理せず差し戻す |

停止時は CR の内容（summary / evidence / proposed_action）をそのまま添えて提示する。

## 上流の承認ゲート（要件・設計の各完了時）

1. 成果物の要点を提示 → AskUserQuestion「承認 / 修正指示 / 批判レビューを挟む」。
2. 承認を `bucket.sh write <run_dir> approvals.{requirements|design} true` に記録。
3. **未承認では次フェーズを開始しない**（audit.sh が機械検証する）。
4. **承認は承認時の成果物 version に対するもの**。還流等で version が変わったら該当承認を
   false に戻して再承認する（`pipeline.md`「design→requirements 還流」手順 3）。

## メインループだけが行うこと（Workflow・サブエージェントに委譲しない）

AskUserQuestion / PR 作成・外部公開 / 不可逆操作の最終 GO / プランモードでの設計収束。
