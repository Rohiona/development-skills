# review-all: delta スコープ再レビュー設計（gating 基準）

由来: 三者協議（Claude 進行＋Codex⇄Cursor、2026-06-25）。friction「4ファイルしかないのに review-all が 865s / 752K tokens / 11 agents と遅い」。
ステータス: **設計確定／wave 1 実装済み（2026-07-04）**。
- ✅ 2026-06-25 骨格（最小増分）着地: `review-all.js` に mode 解決を拡張（`mode=delta` 受け口・integration/delta 相互排他・`isFullReview` 伝播・`modeNote` ログ）。
- ✅ 2026-07-04 wave 1 着地: Partition 前の pre-gate エージェント（DeltaGate）で D0/D1/D2/M1/M4 を決定論判定し `deltaDecision.json` 生成。全 pass で `MODE='delta'`＋`effectiveDiffPath` に delta diff を差し替え（**全観点は従来どおり実行、縮小軸は対象 diff のみ**）。1 つでも fail / 判定不能 → fail-closed で full。
- ⬜ 残（wave 2 以降）: D4/M2/M3。凍結: D3/D5/C0–C3（wave 1 では fail-closed に寄与しない）。

## 実装ウェーブ表

| ウェーブ | ゲート | 状態 |
|---------|--------|------|
| **第1波（実装済み）** | D0 / D1 / D2 / M1 / M4 | ✅ `review-all.js` DeltaGate |
| **第2波（未実装）** | D4 / M2 / M3 | ⬜ |
| **凍結（wave 1 では not-implemented・fail-closed 非寄与）** | D3 / D5 / C0–C3 | 🔒 |

## 却下した削減案

「前回発火した観点だけ再実行」は **2026-07-04 の批判レビューで却下**。理由: 修正が別観点領域に新規 Critical を持ち込むのを構造的に見逃す。delta の縮小軸は**対象 diff のみ**（lens は削らない）。

## wave 1 の許容リスク

D3/D4/D5 未実装のまま delta を許可する。緩和策:
- 全観点を delta diff で実行（lens 削減なし）
- security / bugbot 常時
- Verify フェーズ維持
- D2 パス名簿＋キーワード走査による auth/security カーブアウト
- 明示 `mode=delta` のみ（既定は full）
- アーキ決定（2026-06-25・閣下承認）: ゲート評価は **review-all.js 内の pre-gate エージェント（案A）**＝メイン文脈を膨らませずサブエージェント側に隔離。1つでも未検証/失敗なら fail-closed で full。

## 大原則
- 原則は full。`integration` 以外は現状どおり full がデフォルト。security / BugBot は常時実行が正本。
- **delta は full の別名ではない**。round≥2 の再レビューで D0–D6・M-gates を全 pass したときだけの明示 opt-in 例外。1つでも未検証/失敗なら fail-closed で full。
- `delta` を `full review` と称さない（`isFullReview:false` を各所に伝播）。
- AND 構成: `modeResolved=delta` は `modeRequested==="delta"` ∧ D0–D6 ∧ M-gates 全 pass のときだけ。`codexSkipped=true` は `modeResolved=delta` ∧ C0–C3 全 pass のときだけ。C 失敗時は「delta + Codex 実行」、D/M 失敗時は full。
- `integration` と `delta` は相互排他（両方指定 → full ＋ `mode_conflict`）。

## delta 許可ゲート D0–D6（検証手段／fail-closed=full）
- **D0 初回 full baseline**: round≥2、直前/指定 baseline に `isFullReview:true` 統合レポートが存在。検証: `deltaDecision.previousFull.reportPath` 読取 + head/base 照合。未確認→full。
- **D1 対象 diff 固定**: base/head/前回 full head/current head が確定し `git diff <prevFullHead> <headSha>` で再現可。検証: `gh pr view` / `git merge-base` / `git diff --name-only`。不一致→full。
- **D2 auth/security カーブアウト**: 認証・認可・テナント/WS スコープ・token/secret・CORS・webhook 署名・IAM/Secrets に触れない。**主判定 = パス名簿**（下記）。**補助判定 = delta.diff の hunk 本文キーワード走査**（`auth|authoriz|token|secret|credential|cors|iam|signature|tenantId|webhook`、大文字小文字無視）。いずれか該当または判定不能 → full（security/BugBot 省略不可）。
  - **D2 パス名簿（正本・主判定）**:
    - `**/auth/**`
    - `**/middleware/**`
    - `**/*guard*`
    - `**/*auth*`
    - `**/*token*`
    - `**/*secret*`
    - `**/*credential*`
    - `**/webhook/**`
    - `**/*signature*`
    - `cdk/**/iam*`
    - `**/*cors*`
    - `packages/**/*tenant*`
  - ※過去ブランチの実例: 外部サービスの PAT 返却/保存（API サービス層と DB スキーマ）、認証 middleware、Secrets Manager を触る diff がここに該当した。
- **D3 export 型表面不変**: export された型/関数/クラス/メソッド signature が base/head で不変。検証: LSP `document_symbols` + `hover` を base/head worktree で比較（regex 不可）。補助で declaration emit diff。変化/取得不可→full。
- **D4 public/runtime 契約不変**: route/proto/OpenAPI/schema/migration/CDK/env/queue/job 等の外部契約・実行基盤が不変。検証: path classifier + `git diff`（例: route 登録はアプリのエントリポイントにある public surface）。該当→full。
- **D5 blast radius bounded**: 影響範囲を全列挙でき delta fan-out に含められる。検証: LSP references/incoming calls + `rg` cross-check の二段。共有 package は即 full ではないが、全 consumer を列挙できなければ full。
- **D6 previous findings mapping**: delta hunk が前回 full の finding 修正/同一局所の再調整に対応。検証: previous report/blockers と changed hunks の file:line/シンボル対応。新機能・未対応領域→full。※blockers の file:line 対応 schema を要定義（Cursor 指摘）。

## 機械担保ゲート M1–M4
- **M1 local machine checks**: 変更 package の build/check/test が当該 HEAD で exit 0（例: root の `pnpm build/check`、対象パッケージの `pnpm --filter <pkg> build/check/test:unit`）。未実行/失敗→full。
- **M2 generated consistency**: generated surface があれば生成して差分ゼロ（例: CI がコード生成後の `git diff --exit-code <生成物パス>` を要求する構成）。未実行/差分→full。
- **M3 CI credit**: CI を根拠にするなら `gh run list --head-sha "$HEAD_SHA"` / `gh pr checks` で**同一 HEAD の `success` だけ**数える。Draft PR では走らない workflow はそれを未実行扱いにする。未 green→full。per-run で run 有無を見る（draft でも走る workflow は拾う）。
- **M4 evidence persisted**: `machineChecks[]` に command/check 名・headSha・conclusion・log URL/path を保存。欠落→full。

## Codex skip 追加ゲート C0–C3（delta 成立後の別判定・より厳格）
- **C0**: 前回 full の Codex artifact が存在し、対象 slice に Codex-only Critical/Major が未解消で残っていない。検証: previous `codex-*.txt`/統合レポート読取。未確認→Codex 実行。
- **C1**: shared/public/security/DB/infra/async ではない。検証: D2/D4/D5 の riskTags。**複数アプリから consume される共有 DB repository のメソッド（過去ブランチの実例: 共有 repository の一括更新メソッドを 2 アプリが consume）はここで skip 不可**。
- **C2**: current HEAD の M-gates が green かつ前回 coverage に対象 slice の high/medium unverified risk が残っていない。検証: `coveragePath` JSON + machine results。未確認→Codex 実行。
- **C3**: skip 理由が `deltaDecision.json` に機械可読で残る。検証: schema validate。欠落→Codex 実行。

## review-all.js 実装状況
- ✅ wave 1 着地: `modeRequested==="delta"` ∧ `!A.integration` のとき Partition 前に DeltaGate エージェントが D0/D1/D2/M1/M4 を評価し `deltaDecision.json` を書く。全 pass で `MODE="delta"`＋`effectiveDiffPath` 差し替え。fail → full + `modeNote`。
- 起動契機: `A.mode === "delta"` ∧ wave 1 ゲート全 pass のときだけ `MODE="delta"`。`integration`/`delta` 相互排他。
- `deltaDecision.json` schema: `version, modeRequested, modeResolved, isFullReview, round, baseSha, headSha, previousFull, deltaDiffPath, files, gates.D0-D6, machineGates, codexSkip.C0-C3, riskTags, fanOutPlan, failClosedReason`。
- fan-out 縮小: delta diff の impacted slices のみ。Spec は仕様不変なら skip、Code は impact/quality + 必要時 test-sanity。**D2 に触れたら delta でなく full なので security/BugBot は full 側で必ず走る**。Codex は C0–C3 pass 時だけ skip。
- `isFullReview:false` の伝播先: Workflow args / 各 reviewer prompt / payload（`~/.claude/workflows/review-all.js:487-495`）/ synth prompt / 統合レポート冒頭 / 戻り値。

## 正本ドキュメントの改訂
- ✅ `~/.claude/skills/hahifuhe-review-all/references/review-all-workflow.md` の「部分再レビュー禁止」節に delta 例外（wave 1 実装済み）を追記済み（2026-07-04）。
- `~/.claude/CLAUDE.md` レビューゲート節に運用原則（明示宣言形式・レポート必須項目）を反映済み（2026-06-25）。

## エピステミック注記
- 本設計は三者協議の【AI 自己申告結論】＋ Claude が読んだのは結論要約と Codex のゲート定義（`r1.codex.md`）のみ（生の全 transcript は未読）。file:line は Codex が echo repo を read-only で参照して提示したもの。**実装時は各 file:line を一次情報で再確認**してから着手する。
