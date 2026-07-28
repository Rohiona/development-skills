# hahifuhe-security-reviewer 観点集（lenses）

`hahifuhe-security-reviewer`（= `/hahifuhe:review-all` の観点 G）が **baseline チェックリストに上乗せして読む学習観点**。
`agents/hahifuhe-security-reviewer.md` の「セキュリティ・チェックリスト（体系 sweep）」が安定 core、ここは
**レビュー指摘（人間レビュアー ＋ 本物 Bugbot のうち security に分類された Missed）から蒸留して育つ層**
（`/review-retro` が追記する）。

各観点は **観点（何を見るか）/ 範囲（どこを）/ 目線（守る実害）/ 検出（どう見つけるか）** のユニットで持つ。

- これは「ケースの山」ではなく、過去傾向を**蒸留した有界な観点**。reviewer はこの集合だけを読む（コンテキスト一定）。
- **上限の目安 15 観点**。超過 or 定期で**統合**（近接マージ・陳腐化剪定・安定したものは core `hahifuhe-security-reviewer.md` のチェックリストへ昇格）。
- 生のケース履歴は別ファイル（`agents/hahifuhe-review.cases.jsonl`。プロジェクトごとに retro で育てる学習データで、初期状態では存在しない）に退避し、**ここには溜めない**（provenance もそちら）。
- 目線（実害カテゴリ）= `security`（認証/認可・IDOR・injection・秘密漏洩・SSRF・CORS・署名検証・exposure）。
  **越境/漏洩/exposure の実害**を必須条件にして取り込む（「命名」等の設計観点は quality へ。誤吸着させない）。
- **二重学習回避**: bug 棚（`bugbot-review.lenses.md` の L1 秘密直書き / L2 認可・SSRF・CORS・injection / L7 不正データ保存 / L16 env・secret 誤コミット）に既出の機械的 security は S* に重複追加しない。S* は主に**人間由来の security 観点**（設計・運用・ヘッダ・ポリシー等、bot が拾わない面）を育てる棚。
- 初版は空。retro を回すまでは baseline チェックリストのみで動く。

---

<!-- 蒸留された観点をここに `### S1. …` 形式で追記する（provenance は cases.jsonl へ） -->
