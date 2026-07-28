# verify-regression — Verify 回帰再演セット

review-all の Verify（独立検証）が過去に誤判定した実事例を「模擬試験」として保存し、
プロトコル（review-all.js verifyCore）を改造したときに再演して合否を確認する。

- 実行: メインセッションから `Workflow({scriptPath: "~/.claude/workflows/verify-regression/verify-replay.js"})`（自動では走らない・改造検収時のみ手動実行）
- 合否: 各ケースの期待判定（下表）と再演結果を突合。**1 件でも FAIL なら改造を見直す**。
- ケースは元プロジェクトのリポジトリの固定 SHA を参照する（そのリポジトリの履歴が手元に残る場合のみ再演可能。導入先では自プロジェクトの誤判定事例でケースを作り直す）。

| ケース | 過去の誤り | 期待 |
|---|---|---|
| case-1335-stale-memo | 誤 confirmed（参照同一性の混同） | confirmed 以外（refuted が満点・inconclusive は準合格） |
| case-1322-worktree-read | 誤 confirmed（作業ツリー直読みで削除済みファイルを残存と誤認） | refuted |
| case-1294-composite-consequence | 誤降格（機構が base 既存という理由で preexisting 扱い） | confirmed かつ diffCausality=composite-new-consequence |
