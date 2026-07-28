---
description: PR に来た全レビュー指摘（本物 Cursor Bugbot ＋ 人間レビュアー）を1パスで収集し、重複除去 → 種類別に振り分け → 各観点集(lenses)へ蒸留する統合 retro。Missed 自動・構造変更は承認制。
argument-hint: "<PR番号> [outDir]"
model: opus
---

# /review-retro — レビュー振り返りの統合入口（収集1本・棚は分離・由来保全）

## 概要

review-all（俺様レビューオール）が出した自分のレビュー（baseline）と、**PR に実際に来た全フィードバック**
（本物 Cursor Bugbot ＋ 人間レビュアー）を同一コミットで突合し、自分が落とした観点（Missed）を
**種類別の観点集(lenses)へ蒸留**する。**収集の入口を1本に統合**しつつ、蒸留先(棚)・ゲートは
種類ごとに分離維持する（混ぜると希釈・上限超過・誤学習になる）。

> これは旧 `/bugbot-review-retro`（お手本＝本物 Bugbot）と `/hahifuhe:review-retro`（お手本＝人間）を
> 統合した入口。両者の中身（オラクル・棚・ゲート）は別物だが、**収集・重複除去・振り分けは1回で済む**。

設計の事実根拠（元プロジェクトの直近25 PR 実測）: PR 指摘は人間レビュアー≈63%・
cursor[bot]≈36%。**人間と Bot は別クラスを拾う**（人間=設計/結合度/責務、Bot=機械的バグ）ので、
お手本の違いは **provenance（`source`/`who`）として cases に保全**し、棚は分ける。

## このコマンドを実行したら初めにやること

「review-retro.md を実行」と出力すること。

## 必須の前提（誤学習の防止）

- **同一コミットで比較する**。merged PR は後続コミットで指摘を修正済みのことがあり、SHA を揃えないと
  「もう直っている指摘を見落とした」と誤って蒸留する（実測済みの罠）。
  - インライン / 総評には `commit_id` が付く。**全体コメントには付かない**ので、本文中に明記された SHA を
    同一コミット判定に使う。無ければ投稿時刻直前の HEAD を推定し、推定である旨を report に明記する。
- **ソースの出し分け**: bot 経路は `cursor[bot]` **のみ**を拾う。人間経路は `*[bot]` と **PR 作成者本人**を
  除外する。これで経路間でソースが混線しない。
- **UTC タイムゾーン罠**（bugbot-loop 既知）: `created_at` 等の時刻比較は UTC で揃える。

## 関連ファイル

- 観点集（reviewer が読む・有界。**棚は分離維持**）:
  - bug（機械的実バグ）: `~/.claude/agents/bugbot-review.lenses.md`（L*・上限 ~30）
  - 変更影響: `~/.claude/agents/hahifuhe-impact-reviewer.lenses.md`（I*・~20）
  - コード品質: `~/.claude/agents/hahifuhe-quality-reviewer.lenses.md`（Q*・~20）
  - セキュリティ: `~/.claude/agents/hahifuhe-security-reviewer.lenses.md`（S*・~15）
  - テスト健全性: `~/.claude/skills/tautology-test-detector/references/learned-lenses.md`（T*・~10）
- 生ケースログ（蓄積専用・reviewer 非読込・provenance はここ）:
  - `~/.claude/agents/bugbot-review.cases.jsonl`（棚が L* の行）
  - `~/.claude/agents/hahifuhe-review.cases.jsonl`（棚が I*/Q*/S*/T*/out-of-scope の行）

## 手順

### 0. baseline（自分が何を捕捉したか）を特定

review-all の出力を単一 baseline にする。選択順:
1. 引数 `$2`（outDir）が渡されていればそれ。
2. 無ければ、当該 PR の `pr.json` が一致し **SHA が揃う**最新の `/tmp/review-*`（SHA 不一致 dir は誤学習源なので使わない）。
3. それも無ければ**軽量モード**: その SHA を checkout せず `git diff <base>...<commit> -- <path>` と現行 lenses ＋
   各 reviewer baseline 観点で「この指摘を自分のレビュー観点なら捕捉できたか」を机上判定（Codex/opus 再実行しない）。

baseline の所見は `<outDir>/<lens>-<slice>.md`、カバレッジ全件は `<outDir>/<lens>-<slice>.coverage.json`
（5観点: impact/quality/security/bugbot/test-sanity）。突合は手順5で行う。

### 1. 収集（4経路を1パス・ソースタグ付与）

> `gh api --jq` は `--arg` を受け取らない（jq のフラグ）。人間経路は**必ず素の `jq` にパイプ**して `--arg me` を渡す。

```bash
PR="$1"
REPO="<owner>/<repo>"  # 対象リポジトリに合わせて設定（例: gh repo view --json nameWithOwner で取得）
AUTHOR=$(gh pr view "$PR" --repo "$REPO" --json author --jq '.author.login')

# (A) 本物 Bugbot のインライン指摘（commit 付き）。source=bot
gh api --paginate "repos/$REPO/pulls/$PR/comments?per_page=100" \
  --jq '.[] | select(.user.login=="cursor[bot]") | select((.body|contains("Unable to authenticate"))|not)
        | {source:"bot", who:"cursor[bot]", path, line, commit: .commit_id,
           sev: (.body|capture("\\*\\*(?<s>High|Medium|Low) Severity\\*\\*").s // "?"),
           title: (.body|gsub("<!--.*?-->";"")|ltrimstr("\n")|split("\n")[0])}'

# (B) 【一次信号源】人間の PR 全体コメント（人間レビュアーの構造化レビュー。commit は本文の SHA を参照）。source=human
gh api --paginate "repos/$REPO/issues/$PR/comments?per_page=100" \
  | jq --arg me "$AUTHOR" '.[]
    | select((.user.login|endswith("[bot]"))|not) | select(.user.login != $me)
    | {source:"human", who: .user.login, created: .created_at, body: (.body|gsub("\r";"")) }'

# (C) 人間のレビュー総評（LGTM のみ除外・commit 付き）。source=human
gh api --paginate "repos/$REPO/pulls/$PR/reviews?per_page=100" \
  | jq --arg me "$AUTHOR" '.[]
    | select((.user.login|endswith("[bot]"))|not) | select(.user.login != $me)
    | select(.body != "" and (.body|test("LGTM|👍|🎉")|not))
    | {source:"human", who: .user.login, commit: .commit_id, state, body: (.body|gsub("\r";"")) }'

# (D) 人間のインラインコメント（path/line/commit 付き・作成者/bot 除外）。source=human
gh api --paginate "repos/$REPO/pulls/$PR/comments?per_page=100" \
  | jq --arg me "$AUTHOR" '.[]
    | select((.user.login|endswith("[bot]"))|not) | select(.user.login != $me)
    | {source:"human", who: .user.login, path, line, commit: .commit_id,
       body: (.body|gsub("<!--.*?-->";"")|gsub("\r";"")) }'
```

`commit` 付き（A/C/D）は **baseline と同じ SHA のものだけ**を正解に使う。全体コメント（B）は本文の SHA で揃える。

### 1.5 人間の構造化レビューを finding 単位に分解（human 経路のみ）

全体コメント（B）は 1 投稿に複数 finding を内包する（人間レビュアーの `## レビュー結果 … Major n / Minor n`、
`CLUSTER-A〜E`、`DR-002` のような構造化レビュー等）。**コメント全体を 1 件にせず finding 単位に割る**。各 finding について本人が
付けた軸（impact/quality/conformance/security/design）と重大度を読み取る（手順5の振り分けヒント）。
「対応済み」「再レビューで解消」と本人が書いた finding は最終 commit で解決済みなら Missed から外す。

### 2. ノイズ除去（human 経路のみ・前処理）

人間コメントには質問・賞賛・雑談・「後で」・好みが混ざる。蒸留対象は**一般化でき再発しうる、レビューで
先回りすべき指摘**だけ。次は除外: 賞賛/相槌、純粋な質問、その PR 固有で再発しない一回性、スタイル/フォーマット
（Biome の責務）。bot 経路（A）はノイズ除去不要（機械的指摘）。

### 3. 重複除去（dedup）

キー = **`正規化path + line-bucket（関数/シンボル単位）+ 問題核（正規化 title/本文）`**。
- 正規化: path はリポジトリ相対。問題核は記号/全半角/敬体・助詞を落として縮約。
- line-bucket: 完全一致でなく同一関数/シンボル単位（bot は機械 line、人間は曖昧 line。厳密一致だと寄らない）。
- **commit 跨ぎ・source 跨ぎ**とも1問題へ寄せる（同一 SHA 判定は手順5の突合側で別途守る。dedup は学習回数を1にするため）。
- **bot と人間が同箇所** → 1 件にマージし `source:"both"`、`who` を配列、`sources[]` に全由来を残す（provenance を捨てない）。
- 緩め過ぎ注意: line-bucket を広げ過ぎると別問題が潰れる。核は path+関数単位に寄せ、title は核を残す。

### 4. 突合（同一コミット・単一 baseline）

各指摘を baseline（手順0）と突合:
- **Missed**: PR に来た○・自分(baseline)× → 蒸留対象（最重要）。baseline の `<lens>-<slice>.md` ＋
  `coverage.json` の `reviewedFiles` に path/line が無ければ Missed。`skippedFiles`/`unverifiedRisks` に
  該当があれば **Missed-but-flagged**（認識はしたが深掘りせず＝蒸留優先度は低め）。
- **Matched**: 両方○ → カバー済み（蒸留しない）。
- **Extra**: 自分○・PR×（誰も触れず）→ レポートのみ（観点化も抑制もしない）。

### 5. 分類 → 振り分け（router・棚は分離維持）

残った各 Missed を**種類で**棚へ振り分ける（1つの巨大リストに混ぜない）。複数該当は主担当1つに寄せる:

| Missed の性質 | 棚 | 蒸留先 lenses | cases |
|---|---|---|---|
| 機械的バグ（null/分岐/async/シグネチャ不整合/競合/二重配信） | bug | `bugbot-review.lenses.md` (L*) | bugbot-review.cases.jsonl |
| 波及漏れ（呼び出し元/依存先/スキーマへの影響見落とし） | impact | `hahifuhe-impact-reviewer.lenses.md` (I*) | hahifuhe-review.cases.jsonl |
| アーキ準拠・結合度/疎結合/責務分割/命名・エラー処理・性能 | quality | `hahifuhe-quality-reviewer.lenses.md` (Q*) | hahifuhe-review.cases.jsonl |
| 何も検証しないテスト・mock-only・メタテスト | tautology | tautology `learned-lenses.md` (T*) | hahifuhe-review.cases.jsonl |
| security（秘密/認可・IDOR/injection/SSRF/CORS/署名検証/exposure） | security | `hahifuhe-security-reviewer.lenses.md` (S*) | hahifuhe-review.cases.jsonl |
| 要件整合性・純設計・仕様判断 | out-of-scope | 蒸留せずレポート＋案内のみ（conformance/review を案内） | hahifuhe-review.cases.jsonl |

> cases の書き込み先は **振り分け先の棚オーナー**で決める（L*→bugbot cases、それ以外→hahifuhe cases）。
> human 由来でも bug 棚に行く機械バグは bugbot cases に集約され、棚と cases が一致する。

**誤分類ガード（判定順）**:
1. 「**未対応だと実行時に壊れる/誤動作/データ不整合/二重配信するか？**」Yes → **bug**。
2. No だが「**設計/結合度/命名/責務/テスト健全性の劣化**か？」Yes → **quality**（テスト健全性は tautology）。
3. **越境/漏洩/exposure（認可・秘密・SSRF・署名）は最優先で security**（「命名」等が誤吸着しないよう
   「越境/漏洩/exposure の実害」を必須条件にする）。
4. 迷ったら out-of-scope に落として人間確認（機械的に決めない）。
- レビュアー個人の指摘傾向（例: quality（結合度/命名/責務）寄り）は振り分けのヒント止まり（本人の軸分類も鵜呑みにしない）。

### 6. ケース蓄積（生ログ・自動・統合スキーマ）

全 Missed（必要なら Matched/Extra も）を、振り分け先の棚オーナーの cases.jsonl に1行1ケースで追記。
**既存キーは温存し、`shelf`/`source`/`who`/`sources[]` を追加**する（旧行は欠落許容＝移行不要）。

```jsonl
{"date":"2026-06-24","pr":1271,"commit":"36ce0fc","shelf":"bug","lens":"L8","kind":"missed","source":"both","who":["cursor[bot]","reviewer-a"],"sources":[{"source":"bot","who":"cursor[bot]"},{"source":"human","who":"reviewer-a"}],"sev":"Medium","path":"apps/.../x.ts","line":176,"title":"…","impact":"correctness","note":"dedup: bot+human 同一箇所"}
{"date":"2026-06-24","pr":1250,"commit":"ab12cd3","shelf":"security","lens":"S-new","kind":"missed","source":"human","who":"reviewer-a","sources":[{"source":"human","who":"reviewer-a"}],"path":"apps/.../config.ts","title":"CSP ヘッダ欠如","impact":"security"}
```

- `shelf` = `bug | impact | quality | tautology | security | out-of-scope`。`lens` = 該当観点 ID（新規なら `"new"` / `"S-new"` 等）。
- `source` = `bot | human | both`。`who` は login のまま（login と実人物の同定は分析時）。`sources[]` は dedup 前の全由来。
- `date` は `date +%F`。後方互換: bugbot 行の `sev`、旧 hahifuhe 行の `reviewer` は温存（`reviewer` は `shelf` と同義）。

### 7. 蒸留 → 各 lenses を更新（Missed の取り込みは自動・構造変更は承認制・**ゲートは棚ごと**）

各 Missed に棚オーナーのゲートを適用してから蒸留する:

| 棚 | ゲート（既存規律を流用） |
|---|---|
| bug (L*) | 実害ゲート: security/perf/UX/correctness のみ蒸留。**保守性のみは「参考」に落とす**。 |
| quality (Q*) | 再発ゲート ＋ **結合度/保守性の劣化を実害扱いで残す**（bug と逆）。 |
| impact (I*) | 再発ゲート（一般化でき次 PR でも先回りすべきか。一回性は除外）。 |
| security (S*) | 実害ゲート: 越境/漏洩/exposure に実害。保守性のみは参考。 |
| tautology (T*) | severity 既定 Minor。GO/NO-GO 数式は変えない。 |

- 既存観点で**カバー済み** → lenses は変えない（cases の `lens` 記録に任せる＝重複追加しない）。
  **cross-shelf でも**: bug の機械 security が L* に既出なら S* に重複追加しない（二重学習回避）。
- **未カバー** → PR 固有を**一般化**し、各 lenses の形式（`観点 / 範囲 / 目線 / 検出`、tautology は learned-lenses 形式）で
  **自動で新観点を追加**。**provenance は lenses に書かず** cases.jsonl（手順6）にのみ記録（reviewer が丸読み＝コンテキスト一定）。
- **out-of-scope / Extra はレポートのみ**（蒸留しない）。
- **上限超過 or 定期** → 統合パス（近接マージ・陳腐化剪定・安定観点の baseline 昇格・棚の再編）を**提案**し、
  承認後に実施（＝Missed の新規追加以外の**構造変更は承認制**）。

## レポート（最後に提示）

```
レビュー観点 retro 完了（PR #<n> / commit <sha> / baseline=<outDir or 軽量>）

収集: bot B 件 / human H 件 → dedup 後 N 件（うち both M 件）
突合: Missed = bug a / impact b / quality c / security d / tautology e / out-of-scope f｜Matched g｜Extra h
蒸留: 新観点 L+a' / I+b' / Q+c' / S+d' / T+e'（既存カバー済み k 件は追記せず）
out-of-scope f 件 → 案内: conformance/review のどれか
cases.jsonl 追記: bugbot +p 行 / hahifuhe +q 行（source 内訳: bot x / human y / both z）
```

## 補足

- 完全一致は目標にしない。「同種の見落としを減らす」のが目的。
- 効果の縦断確認: 後続 PR で同じ観点が再 Missed しないか、cases の `shelf`/`lens`/`source` 分布で追える。
- provenance（`source`/`who`/`sources[]`）は捨てない＝将来 author 別の重み付けの素地（当面は全 Missed 等価）。
