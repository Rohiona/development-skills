---
name: autonomous-dev
description: アイデアや要件を起点に、要件定義 → 設計 → 実装 → レビュー → draft PR までを俺様シリーズ（hahifuhe-*）準拠で自走させる、開発まるごとの指揮者スキル。上流（要件・設計）はプランモードで対話収束して人間の承認を取り、下流（実装以降）は autodev-downstream Workflow で自走し、曖昧点・不可逆操作・主観的トレードオフを検知した時だけ停止して相談する。「これ作って」「要件から実装して」「自走で PR まで」「あとは任せる」「この機能を実装して」など開発工程を任せたい意図が読めたら必ず起動する。成果物は design_doc/{機能名}/ に置く。pnpm + Turbo 構成のモノレポ プロジェクト向け。
---

# autonomous-dev — 俺様準拠フル SDLC 指揮者（v3）

アイデア/要件を入力に **requirements → design →〔下流 Workflow〕→ reconcile → pr** を駆動する。
実行手順の正本は **`references/pipeline.md`**（必読）。停止判断は `references/guards.md`。

## 鉄則（各1行。詳細と経緯は rationale.md）

1. **俺様フェーズのバイパス禁止**: 要件・設計・実装・レビューを「自分で直接」済ませない。バグ修正でも省略しない。成果物（requirements.md / 設計書 / reviews/）を残さず完了としない。
2. **上流は人間が締める**: requirements と design は各完了時に★承認ゲート（AskUserQuestion → `approvals.*` 記録）。未承認で次へ進まない。design はプランモードで収束させてから合意した高度まで authoring（実装詳細は reconcile で埋める）。
3. **下流は Workflow に委譲**: implement〜reverify は `autodev-downstream` Workflow（実装規律=reuse境界検証・責務自己評価・tautology排除、ループ安全装置、review-all 7観点レビューを内蔵）。メインループが実装・レビューを手ずからやるのはバイパス＝違反。
4. **人間対話はメインループだけ**: Workflow/サブエージェントは質問できない。NEEDS_HUMAN が返ったら AskUserQuestion → `bucket.sh answer` → resumeFromRunId+attempt+1 で再開。
5. **完了 = `scripts/audit.sh` が pass**（成果物存在・承認・ゲート緑・レビュー GO の機械検証）。散文の自己申告で完了と報告しない。
6. **引き渡しは distilled 優先**: manifest.json → handoff（*.json）の順で読み、verbose は不足時のみ。正本: `references/token-efficient-handoff.md`。

## 実行フロー（要約。詳細は pipeline.md）

| ステージ | 駆動 | ゲート |
|---|---|---|
| requirements | [Main] playbook 追従・AskUserQuestion バッチ | ★承認 |
| design | [Main] プランモード収束 → authoring | ★承認 |
| implement→gate→review→fix→reverify | **[WF] autodev-downstream** | Workflow が GO（内部: gate 緑・review-all GO・audit pass） |
| reconcile | [Main] 設計書を最終コードと差分同期 | 一致 |
| pr | [Main] draft PR 作成（`gh pr create --draft`。base=プロジェクトの既定ブランチ） | URL 取得 |

起動前提: 対象ブランチ（既定ブランチ直なら切る）/ `bucket.sh init <機能名>` で run 作成 / Cursor 経路（`--force`）の明示許可を閣下から一度取る（拒否時は implBackend:'agent'）。

## 止まるとき

Workflow が **ambiguous / irreversible / subjective** で NEEDS_HUMAN を返す（グレーは停止側・ループ上限や回帰検知はコード実装済み）。メインループ自身も、上流の未確定・PR 作成・不可逆操作の手前で必ず閣下に確認する。基準の正本: `references/guards.md`。

## バンドル構成

```
references/
  pipeline.md          実行の正本（上流の進め方・下流 Workflow の起動/再開・manifest 対応・state.json）
  guards.md            停止3カテゴリ・NEEDS_HUMAN スキーマ・停止→再開手順・承認ゲート
  token-efficient-handoff.md ★共有契約（manifest / verbose・distilled・scratch 3層。hahifuhe 全体が参照）
  rationale.md         設計判断の履歴・実例（実行時は読まない）
scripts/
  bucket.sh            run 状態管理（init|read|write|gate|escalate|answer|phase）。phase は state+manifest 同時更新
  gate.sh              客観ゲート（build|typecheck|check|test|all --files）。all は一括判定＋error_signatures
  audit.sh             完了条件の機械検証（PASS/FAIL）
  impacted-packages.sh 変更ファイル→影響 pnpm パッケージ
~/.claude/workflows/
  autodev-downstream.js 下流の自走 Workflow（review-all を子 Workflow として内包）
```
