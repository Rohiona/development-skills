# hahifuhe コードレビューオール（canonical workflow）

> **⚠️ 位置づけ（v5・2026-07-10）: フル review-all は既定ではなく「格上げ先」**。既定の重量級レビューは **codex-first プロファイル**（CLAUDE.md「レビューの重さの振り分け（v5）」が正本。Codex 深掘り波＋横断整合波(テンプレE)＋条件付き整合波(C)/セキュリティ波(B)、Claude は scope 切り・一次実読 Verify・統合のみ）。本ファイルの Workflow を起動するのは (a) 誰の目も未着 × 危険領域 (b) 閣下の明示指定 (c) codex-first の必須波が失敗/Codex 起動不可、のときだけ。試行期間（〜2026-08-09 または 5 PR）中の autodev・integration・delta・continue 経路は従来どおり本 Workflow を使う。三者協議合意・実測根拠は memory id 2004。

仕様レビュー（条件付き）+ 変更影響 + コード品質 + テスト健全性 + セキュリティ + BugBot 観点を**バックグラウンド Workflow** で並列実行し、全 Critical/Major を**独立検証（Verify）**してから 1 つの統合レポートにまとめる。

> **このファイルは「メインループ（オーケストレータ）の責務」と「原則」の正本**。
> **観点の起動・並列度・fan-out・Verify・合成のオーケストレーション正本は `~/.claude/workflows/review-all.js`**。`commands/hahifuhe:review-all.md` と `skills/hahifuhe-review-all/SKILL.md` はここを参照する。
> 各 reviewer の詳細プレイブックは agent 定義側（`agents/hahifuhe-*-reviewer.md` / `bugbot-review.md`）。playbook は二重に書かない。
> 設計判断の経緯・却下案は `references/rationale.md`（実行時は読まない）。

## 原則（コンテキスト膨張対策の核）

1. **全文を扱うのはサブエージェント**。各 reviewer はフル所見をファイルへ Write し、返却は compact（schema 強制）のみ。
2. **オーケストレーションはバックグラウンド Workflow**。メインに返るのは最終判定オブジェクト 1 個だけ。
3. **diff はファイル渡し**。Phase 0 でメインが diff をファイルに書き、パスだけ渡す。メインはフル diff を抱えない。
4. **巨大 PR は自動分割＋観点ルーティング**。発火閾値は **review-all.js の定数が正**（`PARTITION_LINE_THRESHOLD` / `PARTITION_AREA_THRESHOLD`。文書に数値を書かない＝乖離事故防止）。分割時は Spec 観点も全体 diff 丸読みをやめ要件駆動の選択読みに切り替わる。

## フル実行の原則（確認なし）

review-all を起動されたら、**適用可能な全観点を 1 回の自走で完遂する**。途中で「どの観点をやるか」「スキップしてよいか」を訊かない。

- 仕様レビュー: 対象仕様（専用 or 関連）が見つかる限り必ず実行。スキップは「関連仕様すら特定できない」場合のみ（理由をレポートに書く。事前相談しない）。
- 変更影響 / 品質 / セキュリティ / BugBot: 常時実行（セキュリティ常時は閣下の決定）。
- テスト健全性: diff にテストファイルが含まれれば確認なしで必ず起動。
- 途中経過の報告は最小限にし、統合レポートで一括報告する。

## 修正後の再フルレビューと GO までのループ（途中で止めない）

**指摘を修正したら、必ずフル review-all を最初からもう一度回す**（Workflow を再起動）。GO（Critical 0 かつ Major 0）に到達するまで「修正 → フル再レビュー」を繰り返し、その前に「レビュー完了」「push 可」「LGTM」と報告・前進しない。

- **部分再レビュー禁止**: 修正した観点だけの再実行で済ませない（修正は他観点へ波及しうる）。
- **唯一の例外 = 明示 `mode=delta`**（wave 1 ゲート D0/D1/D2/M1/M4 全 pass 時のみ。1 つでも fail / 判定不能 → fail-closed で full）。delta でも**全観点（lens）は従来どおり実行**し、縮小するのは**対象 diff のみ**（前回フル head 以降の差分）。delta を full review と称しない。設計正本: `references/delta-scope-design.md`。
- **GO まで止めない**: 1 周で GO にならなければ、承認を求めず次の「修正 → フル再レビュー」周回へ（修正自体は人間ゲートで判断してよいが、再レビューは自走）。
- **実起動の徹底**: 各観点はサブエージェントを実際に起動する（Workflow が保証）。live 文脈からの自前要約で「回したことにする」のは禁止。
- **報告に周回情報を残す**: 各周の総合判定（Critical/Major 件数）とレポートパスを残し、「フルで回したか」を事後検証できるようにする。

## 入力

ユーザーが PR 番号・PR URL・ブランチ名を指定した場合はそれを対象とする。指定がなければ現在のブランチの diff を使う。

| 入力 | 例 | 対象 diff |
|------|---|--------------|
| PR 番号 / URL | `#1234` / `https://github.com/org/repo/pull/1234` | merge-base(base, head) … head |
| ブランチ名 | `feat/xxx` | `develop...feat/xxx` |
| 指定なし | — | `develop...HEAD` |

---

## Phase 0: メインループの準備（軽量・diff はファイルへ逃がす）

メインは**フル diff・フル所見を文脈に載せない**。次を Bash で実行し、**結果はすべて `/tmp/review-{ts}/` のファイルへ出力**して、Workflow には**パスと小さなメタだけ**を渡す。

```bash
TS=$(date +%Y%m%d-%H%M%S); OUT=/tmp/review-$TS; mkdir -p "$OUT"
ROOT=$(git rev-parse --show-toplevel)
```

**PR 指定の場合:**
```bash
gh pr view <N> --json baseRefName,headRefName,files,title > "$OUT/pr.json"
BASE=$(jq -r .baseRefName "$OUT/pr.json"); HEAD=$(jq -r .headRefName "$OUT/pr.json")
git fetch origin "$BASE" "$HEAD"
BASE_SHA=$(git merge-base "origin/$BASE" "origin/$HEAD")
HEAD_SHA=$(git rev-parse "origin/$HEAD")
git -C "$ROOT" diff "$BASE_SHA" "$HEAD_SHA" > "$OUT/diff.patch"
jq '[.files[].path]' "$OUT/pr.json" > "$OUT/files.json"
```

**ブランチ / 指定なしの場合:**（base は既定 `develop`）
```bash
BASE_SHA=$(git merge-base develop HEAD); HEAD_SHA=$(git rev-parse HEAD)
git -C "$ROOT" diff "$BASE_SHA" "$HEAD_SHA" > "$OUT/diff.patch"
git -C "$ROOT" diff --name-only "$BASE_SHA" "$HEAD_SHA" | jq -R . | jq -s . > "$OUT/files.json"
```

**共通メタ:**
```bash
LINES=$(wc -l < "$OUT/diff.patch")
HAS_TESTS=$(grep -qE '\.(test|spec)\.(ts|tsx)' "$OUT/files.json" && echo true || echo false)
# partition 発火判定の入力（行トリガー＝非生成 diff 行 / 領域トリガー＝非自明 top-level 領域数）。生成物は両方から除外する。
NONGEN_LINES=$(git -C "$ROOT" diff "$BASE_SHA" "$HEAD_SHA" -- . \
  ':(exclude)**/*.gen.ts' ':(exclude)**/*.pb.ts' ':(exclude)**/generated/**' \
  ':(exclude)**/migration/**/*.json' ':(exclude)**/*.snap' ':(exclude)**/pnpm-lock.yaml' | wc -l | tr -d ' ')
AREA_COUNT=$(jq -r '.[]' "$OUT/files.json" \
  | grep -vE '\.(gen|pb)\.ts$|/generated/|/migration/.*\.json$|\.snap$|pnpm-lock\.yaml' \
  | awk -F/ '{ if(($1=="apps"||$1=="packages")&&NF>=2) print $1"/"$2; else if($1=="cdk") print "cdk" }' \
  | sort -u | wc -l | tr -d ' ')
```
**領域は code 領域（`apps/<app>`・`packages/<pkg>`・`cdk`）だけを数える**（docs/.github/misc を数えると誤発火する。経緯は rationale.md）。
（`NONGEN_LINES`/`AREA_COUNT` を渡さない場合、スクリプトは `totalDiffLines` を行閾値で代替＝後方互換だが領域トリガーは効かない。新規 run では必ず渡す。）

**仕様検出**: 機能ディレクトリ直下の `manifest.json` を起点に、`requirements/requirements.json`（distilled）と `design/context.json` がそろうか確認する。PR 本文・コミット・コード内コメントの `design_doc` 参照や、diff のファイルパス/機能名で `design_doc/**/manifest.json` を絞り込む。見つかれば `spec.found=true` とパス群を、特定できなければ `spec.found=false` と理由を args に入れる（軽い Read のみ。verbose 本体は開かない）。

## Phase 0.5: 入口トリアージ（2026-07-09 v4・自動ベストエフォート）

起動時にレビューの重さを**機械確認できる事実だけ**で自動決定し、選定と理由を**冒頭で宣言**する（黙って軽くしない）。判断材料は 30 秒で取れるものに限定し、diff の深読みで重さを決めない。

**優先順位（上から順に確定・fail-closed）:**

1. **閣下の明示指定が常に最優先**: mode（full/integration/delta）や観点を指定されたらトリアージせずそれに従う。
2. **危険領域 → 無条件 full**: `files.json` のパスと diff の hunk 本文を D2 と同じパターンで走査（パス: `**/auth/**, **/middleware/**, **/*guard*, **/*auth*, **/*token*, **/*secret*, **/*credential*, **/webhook/**, **/*signature*, cdk/**/iam*, **/*cors*, packages/data-access/**/tenant*` / キーワード: `grep -iE 'auth|authoriz|token|secret|credential|cors|iam|signature|tenantId|webhook'`）。ヒットしたら profile=full。
3. **既存レビューの棚卸し**（PR 番号があるときだけ。無ければこの項は「未着」扱い）: `gh api repos/{owner}/{repo}/pulls/{N}/reviews` と `.../comments` で Bugbot 実行済みか・人間レビュアーのコメントがあるかを数える。PR 本文の自己レビュー記録（review-all 実施の記載）は参考情報（発動条件にしない）。
4. **判定**: 「危険領域なし」かつ「独立レビュー 1 系統以上あり」かつ「小規模（`NONGEN_LINES` が partition 閾値の 1/4 未満目安）」が**すべて機械確認できた**ときだけ `profile=light`。1 つでも不明・取得失敗なら `profile=full`（fail-closed）。

**light の意味（重要・誇張しない）**: light でも**観点は落とさない**（Spec は spec.found に従う / security・BugBot・Codex・Verify は常時。**Codex はどんなに軽いレビューでも必ず入れる**＝2026-07-09 閣下決定）。light の実体は「縮退してよいと機械判定した」というトリアージ記録であり、宣言とレポートに残す。将来観点を縮退する場合もこの knob に集約する。

**宣言（必須）**: Workflow 起動前にチャットへ 1 行宣言する。例: 「トリアージ: profile=light（危険領域なし・Bugbot+人間レビュー済み・実質 320 行）。フルが必要なら mode=full と指定してください」。args には `profile` と `triage: { declaration: "<上の宣言文>", facts: {...} }` を入れる。

## Phase 1: Workflow 起動

**Workflow ツール**を `scriptPath` 指定で 1 回呼ぶ（このコマンドが Workflow を呼ぶ＝ opt-in の正規ルート）。`args` に Phase 0 の結果を詰める:

```
Workflow({
  scriptPath: "~/.claude/workflows/review-all.js",   // 絶対パスに解決して渡す
  args: {
    ts: "<TS>", outDir: "<OUT>", repoRoot: "<ROOT>",
    target: { kind: "pr"|"branch"|"working", ref: "<N or branch>", branch: "<HEAD>" },
    diffPath: "<OUT>/diff.patch",
    filesPath: "<OUT>/files.json",
    totalDiffLines: <LINES>,
    nonGeneratedDiffLines: <NONGEN_LINES>,
    changedAreaCount: <AREA_COUNT>,
    hasTests: <HAS_TESTS>,
    baseSha: "<BASE_SHA>", headSha: "<HEAD_SHA>",
    spec: { found: <bool>, manifestPath, requirementsPath, contextPath, reason },
    profile: "full"|"light",                      // Phase 0.5 の決定（省略時 full）
    triage: { declaration: "<宣言文>", facts: { dangerHit, priorReviews, nonGenLines } },  // Phase 0.5 実施時のみ
    model: "opus"
  }
})
```

> **model は必ず渡す（コスト事故防止）**: agent() は既定で**呼び出し元セッションのモデルを継承**する。高価なモデルのセッションから起動すると全レビュアー（数十体）がそのモデルで走る。レビューの標準は `"opus"`（このコマンドの frontmatter と同じ）。

Workflow はバックグラウンドで走り、完了時に `<task-notification>` が届く。進捗は `/workflows` で見られる。**メインはここで他の作業に移ってよい**。

### スクリプトの段取り（詳細は review-all.js の `meta.phases` と各 prompt が正本）

Codex 前倒し起動（2026-07-09 改訂: Codex は whole-diff 方式で Partition 不要のため MODE 確定直後 t=0 で起動）→ Partition（閾値超過時のみ・スライス化＋risk タグ）→ Spec＋Code 検出（**全並走**。Spec は barrier にせず Code と並走〔2026-07-04〕。Spec=仕様あり時の整合性＋要件・設計文書の 2 体〔分割時は選択読み〕。Code=security / test-sanity を lens routing で fan-out。**impact / quality / bugbot は Codex が primary 検出器**で、失敗時のみ Claude fallback（bugbot は 2026-07-09 に Cursor から Codex へ統合〔閣下決定・retro が育てた bugbot-review.lenses.md + .cursor/BUGBOT.md を Codex に照合させる〕。`args.bugbotEngine="cursor"` 明示で旧 Cursor（cursor-agent, composer-2.5）primary に即復帰可＝可逆。カバー率は /review-retro の突合で継続計測）。**Cursor と Codex は並走**〔2026-07-09 改訂: 旧「ローカル CLI 同時 1 本」直列を撤廃。根拠 = 直列化の根拠実測の1つ run 20260703-230122 はビデオ会議の外部負荷が交絡、かつ run 20260708-154552 で cursor-agent 4本同時の全数完走を実測。失敗は fail-open で Claude fallback が拾う〕。bugbot の Cursor 一次出力は wrapper agent が構造化し、severity は High→Major / Medium→Minor / Low→Info の機械変換＝採点は後段 Verify）→ **Verify（2026-07-09 パイプライン化: Critical/Major をソース群バッチ〔early=Spec+Claude常設 / codex / bugbot〕ごとに、検出完了し次第スライス単位クラスタで独立検証を起動＝検出と検証が重なって走る。バッチ間の同一箇所重複は別々に検証され突合は Synthesize が行う。既定エンジンは Claude 並列〔API 主体でローカル負荷と無縁。2026-07-04 に Cursor primary から復帰: run 20260703-230122 で外部負荷により cursor-agent が 600s 無出力 timeout → 10 分全損の実測〕。`args.verifyEngine="cursor"` 明示時のみ Cursor 委譲〔バッチ内直列＋失敗タスクのみ Claude fallback＋demoted の file:line 機械ガード。旧 ADR: 三者協議 2026-07-03「C 強化版」〕。降格には反証必須・全バッチ合計 C+M=0 なら skip。検閲成果物 verify-*.json は Cursor 経路のみ永続化〔ファイル名に batch を含む〕＝後追い影監査 `workflows/verify-shadow-audit.js`〔本線非依存・廃止は起動をやめる1手〕が読む）** → Synthesize（verify 結果を集計し、レポートは cat 連結で組み立て）。旧直列レイアウトへ戻すときは `workflows/review-all.js.bak-20260709-pre-parallel-pipeline` を cp で復元。

> **学習（retro）は統合入口 `/review-retro` に集約**: 本物 Cursor Bugbot と人間レビュアーの全 PR 指摘を1パスで収集し、由来(`source`)を保全したまま種類別の棚（bug=L* / impact=I* / quality=Q* / security=S* / tautology=T*）へ振り分ける。**Verify の誤 demote 検証もここで行う**（demoted findings と実 PR の人間/Bugbot 指摘を突合）。

## Phase 2: 完了時の報告

Workflow の戻り値から報告する。**統合レポートはディスクにあり、メインは判定しか持たない**ので、詳細が要るときだけ `reportPath` を開く。

戻り値の判定は**多値**（`finalVerdict`）:

| finalVerdict | 意味 | overallVerdict（互換） |
|---|---|---|
| `GO` | Critical=0・Major=0・high 未確認リスクなし | GO |
| `GO_WITH_UNVERIFIED_RISKS` | C/M ゼロだが high の未確認リスク残 | GO |
| `NO_GO` | actionable な Critical/Major あり | NO-GO |
| `REVIEW_INCOMPLETE` | 予算超過・tool failure で重要領域が未確認 | NO-GO |

GO の条件は **Critical = 0 かつ Major = 0**（machine gate が通っていても本レビューが NO-GO ならリリースしない）。`demotedCount` / `demotedFromCritical` が返る場合、Verify が降格した指摘（詳細はレポートの「降格済み指摘」節）。**元 Critical の降格は人間確認に値する**ので報告に含める。

**NO-GO の報告テンプレ:**
```
hahifuhe コードレビューオールが完了しました（Workflow）。
総合判定: {finalVerdict} / Critical: X, Major: Y, Minor: Z（Verify 降格: D 件）
ブロッカー: {blockers の見出し}
統合レポート: {reportPath}

選択肢:
1. `/hahifuhe:implementer` - 指摘箇所を修正 → 修正後 review-all を再起動（GO まで）
2. `/hahifuhe:discuss-review` - 対応方針を討議
3. 許容して PR へ進む（リスクを理解した上で）
```

**GO の報告テンプレ:**
```
hahifuhe コードレビューオールが完了しました（Workflow）。
総合判定: GO（Critical = 0 かつ Major = 0） / Minor: Z
統合レポート: {reportPath}
✅ 重大な問題は検出されませんでした。PR 作成に進めます。
```

**伝達が必要なとき（他人の PR レビュー等）**: PR コメントや Slack 向けサマリが要る場合、**メインが reportPath を丸読みして自前要約しない**。general-purpose サブエージェントに「`{reportPath}` を読み、宛先向けの下書きを `{outDir}/draft-<宛先>.md` に Write してパスだけ返せ。下書きは下記『PR コメント下書き規約』に従うこと」と依頼する。**メインは受け取った下書きファイルを必ず Read し、承認依頼時にチャットへ全文を貼って提示する（パスだけの提示は禁止）**。閣下はチャット上で全文を読んで投稿可否を判断する（CLAUDE.md「他人の PR」ルール②の「成果物は投稿予定のコメント案として会話に出す」と同義。2026-07-11 閣下指示で明文化）。トークン節約でファイルへ逃がすのはレポート・所見類であり、承認対象の下書き本文はその例外。

### PR コメント下書き規約（他人の PR への指摘は必ずこの形）

指摘は「感想の羅列」にせず、**各項目の先頭に修正要否ラベルを付けて仕分けする**。レビュイーが「何を必ず直すか / どれは任意か」を一目で判断できるようにするため。

- **先頭に総合判定を H2 見出しで置く**：`## 総合判定: GO` または `## 総合判定: NO-GO（MUST N件）`。直後に1〜2文で結論サマリ（何が問題／何が良いか）を平文で添える。
- 見出しサマリの後に `---` を1本引き、**凡例の一行**を必ず置く：`各指摘に修正要否ラベルを付けています（MUST=要修正 / IMO=推奨・任意 / NITS=些細・任意 / Q=要確認 / FYI=対応不要）。`
- **各指摘は `### {絵文字} {ラベル}（{日本語の要否}） — {一言サマリ}` の見出しで節にする**。絵文字は固定：🔴 MUST / 🟡 IMO / ⚪ NITS / 🔵 Q / 🟢 FYI。**英ラベルの直後に日本語で要否を必ず併記**する（読み手がラベル体系を知らなくても「やる/やらない」が一目で分かるように）。severity からの対応:
  - **🔴 MUST（要修正）** — マージ前に必ず対応（ブロッカー）。Verify で `confirmed` かつ **本 PR 由来**（epistemic-honesty 軸(d)で「この diff が導入/悪化させた」と言える）かつ **修正が本 PR のスコープ内で完結する**（軸(f)/epistemic-honesty 軸(e)）Critical / Major。
  - **🟡 IMO（推奨・任意）**（In My Opinion） — 対応を推奨するが**著者判断に委ねる**。設計・保守性の改善提案、弱い Major〜Minor。**全体波及の構造課題**（deploy パイプライン・共有基盤など、修正すると PR スコープが膨れるもの）は機構が実在でも MUST にせず、**「別 issue の起票を推奨」を添えてここに置く**のが既定（過去レビューの実例（unified deploy 順序の構造課題）で採用・2026-07-14）。
  - **⚪ NITS（些細・任意）**（nitpick） — 些細・任意。typo / 命名 / 体裁 / メタデータの食い違い等。
  - **🔵 Q（要確認）**（質問・意図確認） — 断定せず問う。**既存事項（軸(d)で demoted＝本 PR 非由来）や意図確認**はここ。全体波及課題のうち、その PR 固有の運用手当て（既存 runbook の実行確認等）で足りるものの確認もここでよい。「バグだ」と断定せず「これは意図的ですか？対処するなら別 issue が良さそう」の温度で書く。
  - **🟢 FYI（対応不要）** — 情報共有のみ（良かった点や補足）。
  - （日本語の要否文言・絵文字は上記を既定とする。他ラベルを足す場合も必ず `{絵文字} 英（日本語の要否）` 形式にする。）
- **NO-GO を出す＝ MUST が1件以上**。demoted / 既存事項を MUST に混ぜない（言いがかりになる）。逆に MUST が0なら GO。
- 各指摘は **場所（file:line）+ 何が・どうなる + 対応案** を1セットで書く。ラベルだけ付けて中身が曖昧、をやめる。
- **末尾に締めの一行**：GO なら `Approve します。お疲れさまでした 🙏` 等、NO-GO なら `MUST の {要点} だけ早めに対応いただけると助かります 🙏` の温度で1行。
- 文体は敬語・建設的に。良かった点（FYI）も1つは添える。
- **再レビュー時**：前回 MUST が解消されていれば `### 🟢 解消済み（前回 🔴 MUST） — {要点}` の節で明示する。前回の IMO/NITS が今回 diff 外なら「据え置き・著者判断」と書いて**黙って落とさない**。

**固定テンプレート（この骨格をそのまま使う。既存 PR コメント issuecomment-4871839990 が範例）**：

```markdown
## 総合判定: {GO | NO-GO（MUST N件）}

{結論を1〜2文。コード本体の評価＋ブロッカーの有無}。

---

各指摘に修正要否ラベルを付けています（MUST=要修正 / IMO=推奨・任意 / NITS=些細・任意 / Q=要確認 / FYI=対応不要）。

### 🔴 MUST（要修正） — {一言}
`path:line` … {何が・どうなる}。**対応**: {対応案}

### 🔵 Q（要確認） — {一言}
`path:line` … {断定せず意図確認}。

### 🟢 FYI（対応不要） — 良かった点
- {良かった点を1つ以上}

---

{締めの一行 🙏}
```

## 補足

- **Codex の扱い**: スクリプト内のステージ。`codex-exec.sh`（許可済み）で取得し、失敗/未ログイン/timeout なら `ok:false` で素通り（レビュー全体は止めない）。
- **再開**: Workflow が途中で止まったら `Workflow({scriptPath, resumeFromRunId})` で未変更プレフィックスはキャッシュ再利用できる。
- **`review-all-continue.js` は縮退版**（中断 run の残りを完走させる用。**Verify 未実行のまま合成する**ため、判定の信頼度は full 実行より低い。SYNTH_SCHEMA・ファイル命名規約を複製しているので review-all.js の契約変更時は同期を確認する）。
- **権限**: 各 reviewer の `/tmp/review-*` への Write は settings.json の allow で事前承認しておく（背景実行でダイアログが出ないように）。
