# tautology-test-detector 学習観点集（learned-lenses）

`tautology-test-detector` が **5 類型（SKILL.md）に上乗せして読む学習観点**。
SKILL.md / `detection-criteria.md` が安定 core、ここは
**人間レビュアーの「このテストは何も検証していない」系の指摘から蒸留して育つ層**
（`/hahifuhe:review-retro` が追記する）。

各観点は **観点（どんな無価値テストか）/ 範囲（どこに出るか）/ 検出（どう見分けるか）/ 誤検出ガード（消してはいけない隣接物）** で持つ。

- 過去傾向を**蒸留した有界な観点**。フロー中の adjudicate でこの集合も併読する（コンテキスト一定）。
- **上限の目安 10 観点**。超過 or 定期で**統合**（近接マージ・陳腐化剪定・安定したものは `detection-criteria.md` へ昇格）。
- 生のケース履歴は `~/.claude/agents/hahifuhe-review.cases.jsonl`（`reviewer:"tautology"`）に退避。**ここには溜めない**。
- severity 既定は **Minor**（GO/NO-GO の数式は変えない。SKILL.md「重大度と GO/NO-GO」準拠）。
- 初版は空。retro を回すまでは 5 類型のみで動く。

---

<!-- 蒸留された観点をここに `### T1. …` 形式で追記する（provenance は cases.jsonl へ） -->

_（まだ蒸留された観点はありません。`/hahifuhe:review-retro <PR>` で育てます）_
