# レビュー自己成長システムの配置図（正本）

Global CLAUDE.md「Pre-PR セルフレビュー」「俺様レビュー観点の自己成長」節から退避した詳細。
2つの学習ループの構成・ファイル配置・運用規則を記録する（2026-07-02 に CLAUDE.md ダイエットで移設）。

## 2つのオラクル

- **bugbot 系**（実バグ観点）: 「本物 Cursor Bugbot」の PR 指摘をオラクルに育てる。
- **俺様系**（impact / quality / tautology）: **人間レビュアー（チームのレビュアー・code owner 等）の PR 指摘**をオラクルに育てる。狙いは「自分で LGTM まで回したのに人間レビュアーから出る指摘」＝その差分を観点化して先回りすること。
- 正解源は人間レビュアー全員（`*[bot]` と PR 作成者本人を除外）。個々のレビュアーの login を名指しで知らなくても拾える。

## 学習の統合入口 `/review-retro <PR>`

- 本物 Bugbot と人間レビュアーの**両指摘を1パスで収集**し、同一コミット比較で Missed を判定、由来(`source`)を保全したまま種類別の棚（bug/impact/quality/security/tautology/out-of-scope）へ振り分けて蒸留する。Missed 自動・構造変更は承認制。
- 二重学習回避は dedup（同一箇所は1回）＋ cross-shelf の重複追加禁止で担保（オラクルでの分離ではない）。
- security 由来は専用棚 `hahifuhe-security-reviewer.lenses.md`（S*）で人間/Bot 両方から育てる。
- 旧経路は薄ラッパーとして存続: bot だけ回す `/bugbot-review-retro`、人間オラクルだけ回す `/hahifuhe:review-retro`。
- **Verify（review-all.js の C/M 独立検証）の誤 demote 検証**も対象: 統合レポート「降格済み指摘」節の demoted findings を、同 PR の人間/Bugbot 実指摘と突合し、demote が誤りだったケース（＝人間が後から同じ箇所を指摘）を蒸留する（2026-07-03 Verify 新設に伴う縦断計測。経緯: `~/.claude/skills/hahifuhe-review-all/references/rationale.md`）。

## ファイル配置（全て global `~/.claude/` = プロジェクト非追跡）

チーム非共有・worktree 差分に出さないため、エージェント定義/コマンドも repo でなく global に置く。

### bugbot 系
- 観点集: `~/.claude/agents/bugbot-review.lenses.md`（元プロジェクトの Bugbot 指摘約 2,000 件の分析を蒸留した有界な観点 `観点/範囲/目線/検出`。エージェントが丸読みするため Change Log 等の履歴は溜めない＝コンテキスト一定）
- 手順・実害ゲート: `~/.claude/agents/bugbot-review.md`
- 生ケースログ: `~/.claude/agents/bugbot-review.cases.jsonl`（蓄積専用・エージェント非読込・provenance はここのみ。プロジェクトごとに retro で育てる学習データ＝初期状態では存在しない）
- レビュー出力ログ: `~/.claude/bugbot-logs/`
- プロジェクト固有ルール: `.cursor/BUGBOT.md`（本物 Bugbot / Cursor Agent Review / `/bugbot-review` の単一ソース）

### 俺様系（育つ層・有界・provenance を溜めない）
- `~/.claude/agents/hahifuhe-impact-reviewer.lenses.md`（上限~20）
- `~/.claude/agents/hahifuhe-quality-reviewer.lenses.md`（上限~20。**結合度/疎結合/責務/命名**＝人間レビュアー系を実害扱いで残す）
- `~/.claude/skills/tautology-test-detector/references/learned-lenses.md`（上限~10）
- `~/.claude/agents/hahifuhe-security-reviewer.lenses.md`（上限~15。人間/Bot 両オラクル）
- baseline 観点は各 `agents/hahifuhe-*-reviewer.md` の節 / tautology `SKILL.md` の 5 類型（安定 core）
- 生ケースログ: `~/.claude/agents/hahifuhe-review.cases.jsonl`（`reviewer` 別・蓄積専用・reviewer 非読込・provenance はここのみ。プロジェクトごとに retro で育てる学習データ＝初期状態では存在しない）

### レビュー用ワークツリーの命名・掃除
- 命名規則と掃除トリガーの正本: `~/.claude/CLAUDE.md`「レビュー用ワークツリーの命名と一括掃除」節。作成時は `.claude/worktrees/review/<対象>` ＋ ブランチ `review/<対象>`（EnterWorktree 経由は `claude/review/<対象>`）。
- 一括削除スクリプト: `~/.claude/scripts/review-worktree-clean.sh`（`review/` スコープ限定で強制削除＋prune。`--dry-run` で対象確認のみ）。「レビューのワークツリー掃除して」等の発言で起動。
