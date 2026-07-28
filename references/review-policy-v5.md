# レビュー運用 v5 — 詳細版（正本）

> 発火条件: レビューの波構成・格上げ判定・トレース義務・試行ゲートの詳細が必要なとき
> （CLAUDE.md 本文は要約版。実測根拠・memory id を含む原文はこちら）。
> 経緯: 2026-07-22 ルールダイエットで CLAUDE.md から全文退避（原文無改変）。
> スナップショット: `~/.claude/backups/rule-diet-20260722/`。

---

## レビュー運用（自己レビュー → PR → retro の学習ループ）【原文】

push/PR 前に `pnpm check` と並んで **`/hahifuhe:review-all`**（または軽量に `/bugbot-review`）を回し、Bugbot・人間レビュアーが指摘しそうな実バグ（ロジック誤り・null/型・競合・DB/セキュリティ・FE↔BE バリデーション乖離 等）を先回りで潰す。Bugbot・人間を初回検出の場にしない。
フロー: 実装 → `pnpm check`/test → `/hahifuhe:review-all` → 修正 → push & PR →（Bugbot＋人間レビュアーが最終ゲート）→ **`/review-retro <PR>`**（本物 Bugbot＋人間の全 PR 指摘を1パス収集し、bug/impact/quality/security/tautology/out-of-scope に振り分けて各観点集へ蒸留。Missed 自動・構造変更は承認制）。
正本: Bugbot 手順=`~/.claude/agents/bugbot-review.md`／プロジェクト固有ルール=`.cursor/BUGBOT.md`／PR 後の Bugbot 対応ループ=`bugbot-loop` スキル／観点集・ログ等の配置図=`~/.claude/references/review-system-map.md`。
review-all 等の重いバックグラウンドレビューは、**閣下の明示依頼または上記フロー（push/PR 前）のときだけ**起動する。機能実装の途中で自発的に回さない（2026-07-04: 頼まれていない起動を閣下が手動停止した実例より）。

**レビューの重さの振り分け（v5・2026-07-10 採用 / codex-first 既定）**: 既定の重量級レビューを「codex-first プロファイル」とし、フル review-all（Claude サブエージェント並列）は格上げ先に降格する（三者協議 REACHED で合意。根拠実測: 過去レビューの実例で Codex 5波+Claude Verify のみが人間多観点機構と互角以上・memory id 2004）。重さ判定は従来どおり 30 秒機械判定・迷ったら重い側 = fail-closed。
- ①**既定（自分/他人 PR とも）= codex-first**: Codex 深掘り波（差分規模で 1〜N 波・観点集 inline・仮想 Bugbot はテンプレ D 4条件で波に統合）＋ 横断整合波（テンプレ E。多波なら独立波必須／単波で済む小 PR は 3 問を同波に畳み込み）＋ 設計書ヒット時（下記②）は整合波（テンプレ C）＋ 認証/テナント/secret/CORS/webhook 署名/IAM に diff が触れる時はセキュリティ波（テンプレ B）。**Claude の役割 = scope 切り／全 C/M 所見の一次コード実読 Verify（Codex 自己 Verify 禁止 = 相関バイアス）／統合・コメント下書き**。
- ②設計書（design_doc/要件書）付きなら整合観点をスキップ不可にする。**判定は fail-closed の機械チェック: レビュー着手時に `gh pr diff <N> --name-only | grep design_doc/` と PR 本文の設計書リンク有無を必ず確認**（スキップして人間レビュアー指摘 2 件を取りこぼした過去レビューの実例・2026-07-10・memory id 2001）。
- ③**フル review-all への格上げ**: 「誰の目も未着 × 危険領域（認証/テナント/課金/データ破壊/移行）」の 2 条件重複時／閣下の明示指定／codex-first の必須波が失敗した時。Codex 起動不可時のフォールバックもフル。
- ④**チャット直起動の正式レビューは最小トレース義務（C′）**: outDir `/tmp/review-<PR|branch>-<timestamp>/` に `RUN.md`（対象・base/head SHA・波名・状態）＋波ごとの markdown レポート＋`VERIFY.md`（C/M 毎の confirmed/demoted/not-run と根拠 file:line。C/M=0 なら 1 行）を残し、チャット末尾でパスを 1 行報告。Workflow の完全 JSON 契約は Workflow 専用。`/bugbot-review` 単発は既存 bugbot-logs 契約を維持。
- ⑤**試行ゲート（〜2026-08-09 または 5 PR）**: review-retro で人間/本物 Bugbot 指摘の取りこぼしを縦断計測（最低 2 件は blind paired = 新旧両方式を同一 PR に回して突合）。取りこぼしがフル時代より増えたらロールバック。**試行中の autodev・integration・delta・continue は現行フル固定**。総トークン削減効果は未証明（品質 = 的中率で比較する）。
- **Codex レビューはどんなに軽い経路でも必ず入れる**（閣下決定。根拠実測: 過去レビューの実例・memory id 1993）。自分の PR は push 前レビュー必須（本物 Bugbot は push 後必ず走るため先回り省略は往復コストで返る）。
- Codex への依頼文にはテスト健全性（トートロジー検出）・横展開チェック・既知指摘の重複除外を毎回明示同梱する（Codex に常設観点は無い。標準形 = 過去レビューの実例 の依頼プロンプト）。経緯: memory id 1992/1993。
- **Codex 単体の bugbot レビュー（実バグ先回りだけ欲しい時）は codex スキルのテンプレ D**（領域スライス × retro 観点集 × 時点指定 × ブラインドの4点セット。正本: `~/.claude/skills/codex/references/review-template.md`）。実績: 当時6者が見逃した実バグ2件をブラインド的中（過去レビューの実例 検証・memory id 1998）。
- **PR をパス/領域で分割レビューするときは、深掘り波と別に「横断整合波」を必ず 1 波足す**（codex スキルのテンプレ E。3つの必須質問 = 旧新経路の往復無損失 / migration×コードの deploy 順両方向 / PR 本文の「影響なし」主張の一次検証）。分割は diff の内側しか見ず横断リスクを構造的に落とすため。実証: 過去レビューの実例 ブラインド再検証で人間レビュアー指摘 3/3 的中＋新発見1件（7分52秒・209k tok・memory id 2001）。
