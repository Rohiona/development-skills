# rationale — review-all の設計判断の履歴・経緯（保守用。実行時には読まない）

> 実行手順の正本は `review-all-workflow.md`（メインループの責務）と `~/.claude/workflows/review-all.js`（オーケストレーション）。
> このファイルはスキルを改訂する人（人間 or AI）だけが読む。

## なぜ Workflow 化したか（2026-06）

旧版はサブエージェントに「レポートを書くな・全文テキストで返せ」と指示していたため、各観点の長文レポート 5〜8 本がオーケストレータ（メイン）の会話履歴に丸ごと積まれ、巨大 PR では破綻していた（フェーズ分割 + handoff + /clear の手運用を強いた）。新版は「全文を扱うのはサブエージェント・ファイル永続化・compact 返却・メインには最終判定1個」の原則（共有契約 token-efficient-handoff.md「読むものを小さくする」）で解消した。

## 大規模 PR 対策「即効版」（2026-06 下旬）

Opus からの「大規模 PR でコンテキスト枠が爆発する」警告を受けた一連の対策: Partition（パッケージ単位スライス化。diff 丸読みせず `git diff -- <paths>` で分割）/ lens routing（スライスの risk タグで観点を絞る。タグ欠落→全 lens・分類不能→軽量 lens の安全側 fallback）/ 探索予算（追加探索の soft budget と「指摘なし/未確認」の分離）/ 多値判定（GO_WITH_UNVERIFIED_RISKS / REVIEW_INCOMPLETE の導入）/ 過分割 fail-fast。
partition 発火閾値は当初 1500 行 → 実測を経て 5000 行（非生成）に較正。**文書に数値を書くと実装と乖離する事故が起きた（1500 のまま2箇所残存）ため、以後、閾値は review-all.js の定数（PARTITION_LINE_THRESHOLD 等）を正とし文書は定数名参照のみ**とする。
領域トリガー（changedAreaCount）は code 領域（apps/<app>・packages/<pkg>・cdk）だけを数える。docs/.github/misc を数えると誤発火する（実測: 過去レビューの実例で 4 に水増し、実コード領域は 2）。

## 2026-07-03: Verify ステージ新設ほか（単体レビューの精度・大規模対策の穴埋め）

Plan エージェント批判検討を経て実装した4点とその理由:

1. **Verify（独立検証）新設**: それまで Claude 由来の Critical/Major は (a)到達性 (b)既存防御 (c)test/prod の系統検証なしで判定に算入されていた（Codex 由来のみ Synthesize が裏取り）。偽 Major 1件で「修正→フル再レビュー」1周（数十エージェント）が無駄になるため、全 C/M をスライス単位クラスタ（1 verifier = 1 スライス・上限 5 件）で独立検証する段を Code/Codex 後に追加。設計判断: finding 単位 fan-out は同一スライスの重複読みで最悪コスト・観点単位は verifier 自身が第2のボトルネック化するため却下。レビュアーの verdict/counts は verifier に渡さない（アンカリング遮断）。**demoted には反証（file:line）を必須**とし「反証を見つけられない」は unverifiable（severity 維持＋blockers 可視化）に落とす非対称設計＝正しい指摘の誤消去に構造的に倒れない。C+M=0 なら skip でコストゼロ。誤 demote の縦断計測は /review-retro の突合（demoted findings × 実 PR の人間/Bugbot 指摘）で行う。
2. **Spec フェーズの分割保護**: conformance / spec-doc は partition 発火時も PR 全体 diff を丸読みしており、20k 行級で per-agent 破綻域だった。分割時は「AC/DD 起点でスライス patch を選択読み」する要件駆動へ変更（conformance の本質は要件↔実装の突合であり全 diff は不要。scope creep 検出は riskTags 優先の選択確認＋unverifiedRisks 可視化で微減を許容）。非分割時は従来文面＝互換。
3. **Synthesize の「組み立て」化**: 統合レポートを「全所見を Read して書き直す」から「サマリーだけ自筆＋観点別所見は cat 連結」へ。階層 rollup 案は agent 追加・rollup 欠落リスクに対し利得が薄く却下（実測で天井なら reviewer 結果数 >15 で再検討）。coverage は jq 抽出。
4. **変更集中型 PR の再分割**: 「行数では割らない」原則に唯一の例外（単一グループ ≥8000 非生成行は第2セグメントで再分割。親パッケージを label に保持）。それでも FORCED_PARTIAL_LINE_THRESHOLD 超のスライスは JS が forcedPartial を synth に注入し complete を機械的に禁止（agent 自己申告に依存しない）。

## delta 再レビュー例外の位置づけ

round≥2 の再レビューで修正が低 blast-radius と機械検証できたときだけ `mode=delta` の縮小を許す計画（gate D0-D6 / M1-M4 / C0-C3）。**gate ロジックは未実装のため、現状 `mode=delta` は常に fail-closed で full に落ちる**。設計正本: `delta-scope-design.md`。

## PDCA 由来の行動契約の出典

「修正後にレビューオールをフルでもう一周行きました？ LGTM をもらうまで止めちゃダメ」「やたら早くないか？？フルで回している？」（2026-06-19 friction）→ 正本の「GO までのループ」「部分再レビュー禁止」「実起動の徹底」節。
セキュリティ観点の常時起動は取りこぼし防止を最優先する閣下の決定（2026-06-17）。
