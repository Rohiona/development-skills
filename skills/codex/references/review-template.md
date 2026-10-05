# Codex レビュー用途別プロンプトテンプレ

`codex exec` に渡すプロンプト本文のテンプレ集。用途ごとに差し替えて使う。

## codex-first プロファイル（v5 既定の波構成と最小トレース規約 C′）

**波構成（CLAUDE.md「レビューの重さの振り分け（v5）」が正本）**: 深掘り波（A/D・差分規模で1〜N波・観点集inline）＋横断整合波（E。多波なら独立必須／単波は3問畳み込み）＋設計書ヒット時は整合波（C）＋認証/テナント等ヒット時はセキュリティ波（B）。Claude = scope切り・全C/Mの一次実読Verify（Codex自己Verify禁止）・統合。

**最小トレース規約 C′（チャット直起動の正式レビューで義務・三者協議 REACHED 2026-07-10）**:
- outDir を `/tmp/review-<PR|branch>-<timestamp>/` に作る（PR レビュー時は `pr.json` も置く）
- `RUN.md`: 対象・base/head SHA・波名と状態・開始時刻。終了時に最終 C/M 件数を追記
- 各波の出力は `wave-<NN>-<名前>.md` へ `-o` で直接書かせる（severity・file:line・事実/推論ラベル込み）
- `VERIFY.md`: C/M 所見ごとに confirmed / demoted / unverifiable / not-run と根拠 file:line（C/M=0 なら1行）
- チャット末尾で outDir パスを1行報告。Workflow の完全 JSON 契約（coverage/verify-*.json/materialize）は Workflow 専用で、ここには課さない。`/bugbot-review` 単発は既存 bugbot-logs 契約を維持

## 共通ヘッダ（全テンプレに付ける）

```
あなたは <repo の役割> のシニアレビュアーです。

# プロジェクト背景（バックボーン）
<CLAUDE.md の要点 / rule ファイル内容 / memory 抜粋を inline 展開>

# レビュー対象
- 特定情報: <PR 番号 / commit SHA / diff target>
- 取得コマンド: <git show ... / gh pr diff ...>
- 範囲絞り（巨大時）: <ファイル or ディレクトリ>
```

## テンプレ A: 一般コードレビュー

```
# レビュー観点（優先順）
1. [critical] セキュリティ: 認証/認可、入力バリデーション、シークレット混入、SQLi/XSS/CSRF
2. [critical] データ整合性: スキーマ変更とマイグレーション、破壊的変更の後方互換
3. [high] API 互換性: 破壊的変更の有無
4. [high] コード品質: 50行超関数、800行超ファイル、深いネスト、mutation、エラーハンドリング欠如
5. [medium] テスト: 新機能の単体/統合テスト有無、カバレッジ
6. [low] コードスタイル違反

# 出力フォーマット
## サマリー
- 変更規模 (ファイル数/追加削除行数/影響領域)
- リリース可否判定: GO / GO-WITH-CAUTION / NO-GO
## 重大度別指摘
### CRITICAL (マージブロック)
### HIGH (マージ前に修正推奨)
### MEDIUM (将来対応)
### LOW (任意)
各指摘: [ファイル:行] - 問題 - 推奨修正
## 良かった点
## フォローアップ推奨タスク
```

## テンプレ B: セキュリティ特化レビュー

```
# セキュリティチェックリスト（~/.claude/rules/common/security.md を inline 展開）
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML)
- [ ] CSRF protection enabled
- [ ] Authentication/authorization verified
- [ ] Rate limiting on all endpoints
- [ ] Error messages don't leak sensitive data
- [ ] No secret exposure in logs
- [ ] Dependencies are vetted (no suspicious packages)

# 指示
1. まず `git show --stat <sha>` で変更ファイル一覧を把握
2. セキュリティ影響の大きいファイルから優先的に差分確認
3. 各チェック項目について 該当あり/なし/不明 を判定
4. 該当あり → ファイル・行・重大度(CRITICAL/HIGH/MEDIUM/LOW)・修正案

# 出力フォーマット
## サマリ
- CRITICAL 件数 / HIGH 件数 / マージ可否
## 指摘詳細（重大度別）
各指摘: [ファイル:行] - 該当チェック項目 - 問題 - 修正案
```

## テンプレ C: 要件↔実装の整合性レビュー

```
# 要件書（inline 展開）
<requirements.md の FR / NFR / 受入基準 / スコープ外を inline で貼る。全文でも要点でも可>

# 設計書（inline 展開）
<architecture.md / implementation-plan.md の要点を inline で貼る>

# 整合性レビュー特有の観点
1. [critical] 欠損: 要件にあるのに実装されていない機能
2. [critical] 過剰: 要件にないのに実装されている機能（スコープ外侵犯）
3. [critical] 意味論ズレ: 実装はあるが要件と挙動がずれている
4. [high] テスト充足: 受入基準がテストでカバーされているか
5. [high] NFR: 非機能要件（性能/セキュリティ/可用性）への影響
6. [medium] ドキュメント: 実装と要件書の記述差異

# 出力フォーマット
## FR 別整合性表
| FR ID | 要件概要 | 実装状況 (○/△/×) | 該当ファイル | 備考 |
## 受入基準チェックリスト
- [✓/✗] 基準1: <根拠>
## 欠損 / 過剰 / 意味論ズレ
各項目: 要件 - 実装 - 乖離内容 - 重大度
## テスト NFR 充足
## BLOCK / WARN / INFO
## 最終判定（要件充足度 %、リリース可否）
```

## テンプレ D: bugbot 単体（領域スライス × retro 観点集）

**トリガー**: 「Codex に bugbot レビューを」「実バグの先回りだけ Codex で」「過去 PR のバグを拾えるか検証して」。
**実績**: 2026-07-10、過去レビューの実例で当時 6 者（人間4 + Cursor Bugbot + claude[bot]）が見逃した実バグ 2 件（後続 PR で修正）をブラインドで両方的中。勝因は「モデル単体」でなく下記 4 点セットなので、**どれか 1 つでも省くと再現保証が崩れる**。

**4点セット（全部やる）:**

1. **領域スライスに絞った diff をファイル化**（探索空間の縮小が検出力の核）:
   ```bash
   git diff <base>..<head> -- '*<領域キーワード>*' \
     ':(exclude)design_doc/**' ':(exclude)**/generated/**' ':(exclude)**/pnpm-lock.yaml' > /tmp/slice.diff
   ```
   マージ済み PR でブランチ削除済みなら `git fetch origin pull/<N>/head` で head を取る。目安 1 万行以下。
2. **retro 観点集の Read 指示を同梱**: プロンプトに「`~/.claude/agents/bugbot-review.lenses.md` を最初に Read し、各指摘をこの観点集にも照合すること」を必ず入れる（`/review-retro` が実指摘から蒸留し続ける学習資産。これが「過去に見逃した型」を先回りさせる）。
3. **時点指定**（過去 PR 検証・head が現ワークツリーと違うとき必須）: 「現ワークツリーを判定根拠にせず、PR 適用後は `git show <headSha>:<path>`、変更前/移植元は `git show <headSha>^1:<path>` で読め」と明示（後続修正の混入・リーク防止）。
4. **ブラインド維持**: 正解・期待・仮説を教えない。移植 PR なら「移植元と挙動が変わっていないかが最重要」という一般論の重点付けまでは可。

**プロンプト骨格**（共通ヘッダの背景 + 上記 4 点 + 出力形式）:

```
あなたは <repo> の仮想 Bugbot レビュアーです。本物の Cursor Bugbot が指摘しそうな「実バグ」を
先回り検出してください。スタイル・好み・裏取りなき推測の指摘は出さないこと。
# レビュー対象: /tmp/slice.diff（<PR/領域の1行説明>）
# 時点: <上記3の git show 指示>
# 学習観点: ~/.claude/agents/bugbot-review.lenses.md を最初に Read し照合
# 出力: ## サマリー（件数）/ ## 指摘（severity・file:line・問題・修正案）。
各指摘に「事実（コードで確認済み）/推論/推測」ラベルを付けること。
```

結果の扱い: 指摘は鵜呑みにせず、後続修正の有無（`git log -S`）や実コードで裏取りしてから採用する（Codex 申告は未検証として扱う）。

## テンプレ E: 横断整合レビュー波（分割レビューの必須追加波）

**いつ使う**: PR をパス/領域で分割レビューするとき（Codex 複数波でも review-all の partition でも）、パス深掘り波とは**別に必ず 1 波**これを回す。分割レビューは「diff の内側」しか見ず、旧新経路の継ぎ目・deploy 順・PR 本文の主張という**横断リスクを構造的に見落とす**ため（実証: 過去レビューの実例で、Codex 4波＋Claude Verify が人間レビュアー指摘の「旧経路への再保存によるデータ silent 消失」と「migration 未適用 deploy での全断」を取りこぼした。この横断波単体のブラインド再検証で 3/3 的中＋人間レビュー超えの新発見 1 件・7分52秒・209k tokens。2026-07-10）。

```
これは PR #<N> に対する「横断整合レビュー」専用の波です。個々のファイルの深掘りレビューは別途完了済みなので繰り返さないでください。あなたの仕事は、diff の内側だけを見ていると構造的に見落とす「継ぎ目」だけを、下記3つの必須質問に沿って一次コードで検証することです。

# 進め方（厳守）
自前のレビュー系スキルやサブエージェントは起動しない。git diff <base>...HEAD と必要ファイルの Read で直接検証する。深掘りは3つの質問に答えるのに必要な範囲だけに絞る。

# 必須質問（3つ全てに、実コードの file:line を根拠に答える）

## 質問1: 旧経路と新経路が同一データを読み書きする全ての往復シナリオを列挙し、各シナリオでデータが無損失か検証せよ
- 旧実装と新実装が同じレコードを読み書きできる場合、「旧で保存→新で開く→新で保存→旧で開く」「新で保存→旧で（無関係な編集でも）再保存→下流が読む」等の往復を実コードでトレースし、どこかで情報が黙って消える・変質する経路がないか確認する。
- 特に「片方だけが知っているデータ置き場（新列/新フィールド）」を、もう片方の読者・書き手がどう扱うかを必ず確認する。互換が「片方向しか設計されていない」兆候も見る。

## 質問2: DB migration とアプリコードのデプロイ順について、両方の順序で何が起きるか検証せよ
- (a) migration 未適用 × 新コード: 新列参照の read/write は何が起きるか。ORM の SELECT 生成（全列 projection か）を実装レベルで確認し、失敗するなら影響範囲（アプリ・テナント・操作）を特定する。
- (b) migration 先行 × 旧コード: 問題が起きるか。rolling deploy 中の新 writer × 旧 reader 共存も見る。
- 「fallback があるから大丈夫」という推測は禁止。fallback に到達する前に失敗する層がないかをクエリ生成の実装で確認する。

## 質問3: PR 本文の「影響なし」系主張を一次検証せよ
- 「既存 X は差分ゼロ」「本番影響なし」「到達は Y のみ」等の主張を、git diff の機械確認・共有モジュールの移動・ゲート外に到達する挙動変更の列挙で裏取りする。

# 出力ルール
- 事実/推論/推測をラベル区別、事実は file:line 併記。
- 各発見に severity と「この diff 由来か既存か」を付ける。
- 問題が見つからなかった質問も「確認した経路と根拠」を明記する（確認せずに OK と言わない）。
```

## コマンド組み立てパターン

**必ず wrapper 経由**（生 `codex exec` は無言ハング／暴走するためフックでブロックされる）。第 1 引数は timeout 秒数。

```bash
# -C は必ず現在の作業ツリーに固定する（"$(git rev-parse --show-toplevel)"）。
# Codex はブランチを引数で取らず、-C の checkout 中ブランチ + 未コミット差分をそのまま見るため、
# 概念上の「repo ルート」を手打ちすると worktree 作業中に別チェックアウトを見て Claude と食い違う。

# パターン 1: テンプレを heredoc で渡す（短いプロンプト）
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s read-only -C "$(git rev-parse --show-toplevel)" -o /tmp/review.md "$(cat <<'EOF'
<テンプレ本文>
EOF
)"

# パターン 2: プロンプトを別ファイルに書いて渡す（長大プロンプト / 再利用時）
cat > /tmp/codex-prompt.txt <<'EOF'
<テンプレ本文>
EOF
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s read-only -C "$(git rev-parse --show-toplevel)" -o /tmp/review.md "$(cat /tmp/codex-prompt.txt)"

# パターン 3: repo 外のルールを読ませる
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write \
  -C "$(git rev-parse --show-toplevel)" \
  --add-dir ~/.claude/rules \
  -o /tmp/review.md \
  "<プロンプト本文、~/.claude/rules/common/security.md を読めと指示>"
```

## 「渡さなかった情報は使われない」原則

- Claude 側のメモリ・CLAUDE.md・過去の決定は、Codex には届かない
- 迷ったら inline 展開。冗長でも「届かない」よりマシ
- 特に [critical] 指摘の判定根拠になる情報（規約・要件）は必ず inline 化
