---
name: codex
description: Codex CLI実行。コード生成・編集・レビューをCodexに委譲。レビュー時はClaude側のバックボーン（CLAUDE.md/memory/要件書）を同梱。**Claude から起動する時は必ず wrapper `~/.claude/skills/codex/scripts/codex-exec.sh` 経由**（生 `codex exec` は固まりリスク + permission 通らない）。呼び出し後は必ず session ID をユーザーへ末尾で明示し、同一文脈の継続議論は `exec resume <SESSION_ID>` を使う
---

# Codex CLI

Codex CLI は **Claude とは別プロセスで会話履歴ゼロ** の別エージェント。Claude 側で持っている context（CLAUDE.md / rule / memory / 要件書 / 設計書）は黙っていれば届かない。呼び出す前に「Codex が判断に必要な材料が全部プロンプト側に渡っているか」を必ずチェックする。

**必須規約 (3 つ)**:

1. **起動経路は wrapper 一択**: Claude から Codex を呼ぶときは、必ず `~/.claude/skills/codex/scripts/codex-exec.sh` 経由で起動する。subcommand は `exec` / `exec resume` / `review` どれでも wrapper の第 2 引数以降に渡す。生 `codex exec ...` を直接 Bash で叩かない (固まりリスク + permission prompt が発生)。詳細は下記「レビュー用途：最小完成例」節。
2. **session ID 明示**: どの subcommand 経由でも **必ず session ID を抽出してユーザーへ報告末尾に明示** する。ユーザーが Claude Code を介さず直接 `~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec resume <SESSION_ID> "..."` で同一文脈の議論に入るための導線なので、省略は不可。詳細は下記「セッション ID と継続議論」節。
3. **`-C` は必ず「今いる作業ツリー」の絶対パスに固定**: `-C` には **必ず `$(git rev-parse --show-toplevel)` で解決した現在の worktree の絶対パスをコマンド置換でそのまま埋める**。「リポジトリルート」「repo の絶対パス」といった概念で本体リポジトリを手打ちしない。詳細は下記「`-C` は現在の worktree に固定する（最重要）」節。

## `-C` は現在の worktree に固定する（最重要）

Codex は **ブランチを引数で受け取らない**。`-C` で渡したディレクトリに **チェックアウト中のブランチ + 未コミット差分** を、そのままレビュー / 編集の対象にする。つまり Codex が「どこを見て判断するか」は `-C` 一点で決まる。

git worktree を多用するプロジェクトでは（例: `<プロジェクトルート>/.claude/worktrees/*` に複数の作業ツリーが同時に存在し、別ブランチが checkout 済み。本体と同一コミットの worktree すらある）、このため **`-C` に概念上の「リポジトリルート」を手打ちすると、Claude が今編集している worktree とは別のチェックアウト（別ブランチ・その worktree の未コミット差分なし）を Codex が見てしまい、Claude と食い違う対象を判断する**。

防止策（例外なし）:

- `-C` の値は **必ず `"$(git rev-parse --show-toplevel)"` をコマンド置換でそのまま埋める**。Bash ツールの cwd は現在の作業ツリーなので、これで Claude が見ているのと同一の worktree（同一ブランチ + 同一の未コミット差分）に固定される。
- ハードコードの絶対パス（`/Users/.../Projects/<プロジェクト>` 等）や「リポジトリルート」という言葉での手打ちはしない。worktree で作業中だと取り違える。
- diff 取得（`git show` / `gh pr diff` 等）を Claude 側で行ってプロンプトに埋める場合も、その diff を取った cwd と Codex の `-C` が同一 worktree であることを保証する（別の場所で取った diff を別の checkout に対して投げない）。
- `exec resume` は前回の `-C` を引き継ぐ。初回 `exec` が上記で正しく固定されていれば resume も同一対象になる。別 worktree / 別 repo に切り替えたいときだけ resume で `-C` を明示し直す。

## レビュー用途：最小完成例（コピペで動く形）

レビュー依頼を受けたとき、まず下記テンプレから始める。パスや対象を置換するだけで動く。

**重要**: 直接 `codex exec` を呼ばず、必ず **wrapper スクリプト `~/.claude/skills/codex/scripts/codex-exec.sh` 経由**で起動する。wrapper は (1) timeout 適用、(2) stdout の tee 保存、(3) `</dev/null` 強制、(4) session ID 抽出、を一括で行う。生 `codex exec` を使うと「Reading additional input from stdin...」で固まったり、自己判断で止まらず数時間走り続ける（iter 3 実測）。

```bash
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec \
  -s read-only \
  -C "$(git rev-parse --show-toplevel)" \
  -o /tmp/codex-review-$(date +%s).md \
  "$(cat <<'EOF'
あなたは <repo の役割（例: TypeScript monorepo, LINE OA 管理プラットフォーム）> のシニアコードレビュアーです。

# プロジェクト背景（バックボーン）
<CLAUDE.md の要点 or rule ファイルの内容を inline で貼る>
<過去経緯・既知バグ・関連 ADR があれば memory から抜粋して貼る>

# レビュー対象
- ブランチ/PR/commit: <明確に特定: PR #1234 / commit <sha> / diff target main など>
- 取得コマンド: `git show <sha>` または `gh pr diff <N>`
- 対象範囲（巨大なら絞る）: <ファイルパス or ディレクトリ>

# レビュー観点（優先順）
1. [critical] <セキュリティ / 整合性 など本質項目>
2. [high] <コード品質 / API 互換性>
3. [medium] <テスト / ドキュメント>

# 出力フォーマット
## サマリー
- 変更規模・リリース可否（GO / GO-WITH-CAUTION / NO-GO）
## 重大度別指摘（CRITICAL / HIGH / MEDIUM / LOW）
各指摘は [ファイル:行] - 問題 - 推奨修正
## 良かった点 / フォローアップ
EOF
)"
```

第 1 引数は timeout 秒数、残りは `codex` にそのまま渡る。デフォルトは 1200 秒。短縮なら 600、拡張なら 1800 / 3600 を渡す。

この雛形を埋めるだけで `tool_uses` / 裁量補完を抑えつつ [critical] 要件を満たせる。用途別テンプレは `references/review-template.md` 参照。

実行直後は下記「セッション ID と継続議論」の手順で session ID を抽出し、ユーザーへ末尾で報告すること（必須）。

## セッション ID と継続議論（必須）

Codex 呼び出しは **毎回 session ID を捕捉してユーザーへ末尾で明示** する。目的:

1. ユーザーが Claude Code を介さず自分で `codex exec resume <SESSION_ID>` を叩き、同一文脈の議論に直接入れるようにする（本 skill 導入の背景）
2. 同一レビュー文脈での追加質問・深掘り依頼を、バックボーンを再投入せず `resume` で継続する

### session ID の取り方（必須パターン）

wrapper `~/.claude/skills/codex/scripts/codex-exec.sh` 経由で実行すれば、stdout 末尾に `=== codex-exec.sh meta ===` ブロックが付き、その中の `session_id: <uuid>` 行から ID が読める。Bash tool の戻り値テキストから直接抽出すればよい:

```
=== codex-exec.sh meta ===
exit: 0
log: /tmp/codex-1730000000-12345.log
session_id: 01970f88-7b9e-7d3f-a4c2-9f1e2c3d4a5b
```

取得失敗時は `session_id: 取得失敗 (timeout / pattern unmatched / log truncated)` が出る。**黙って省略せず、ユーザーへの報告に「取得失敗」の旨そのまま転記する**。

`--json` 運用時 (wrapper を使わず直接 `codex exec --json` を叩く必要がある場合) は `session_meta` イベントの `payload.id` を `jq -r 'select(.type=="session_meta") | .payload.id'` で抽出。

**`--ephemeral` は使わない**（セッションが disk に残らず resume 不能）。

### ユーザー報告の末尾フォーマット（必須、テンプレ固定）

Codex 実行結果をユーザーに返す **最後の行** に、必ず下記ブロックを付ける。session ID が取れなかった場合は「取得失敗」と明記すること（黙って省略しない）。

```
---
Codex session id: <SESSION_ID>
同一文脈の継続議論:
  ~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec resume <SESSION_ID> "<追加プロンプト>"
```

session ID を失った / `--ephemeral` で resume できない場合は、下記の **失敗時専用フォーマット** を使う（通常時の resume 行は入れない: 使えないコマンドを出すとユーザーを混乱させる）。

```
---
Codex session id: 取得失敗（<失敗理由: timeout exit 124 / wrapper meta 未出力 / pattern unmatched 等>）
継続議論不可 — 対象を絞り込んだ上で、新規 codex-exec.sh から再開してください。
```

### 継続議論 / 追加レビュー依頼

同一文脈で Codex に追加依頼をする時は **新規 `exec` ではなく `exec resume`** を使う。バックボーン再投入が不要で、Codex 側にも前回の読解結果が残る。wrapper の第 2 引数以降に `exec resume <SESSION_ID> ...` を渡すだけでよい:

```bash
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec resume "<SESSION_ID>" \
  "<追加観点 / 深掘り質問>"
```

resume 側も wrapper が末尾 meta ブロックで session ID を出すので、そこから抽出する（通常は同一 ID が返るが、実装により新規付与されることもあるので毎回抽出）。

`-C` / `-s` / `-o` は resume でも再指定可（省略しても前回相当で動く）。別 repo を触りたい / sandbox を緩めたい時だけ明示する。

### 判断フロー

- ユーザーが「さっきの続きで」「同じ文脈で追加」「追加でこの観点も」と言った → 直前の session ID で `resume`
- 新しい対象・新しい文脈 → 新規 `codex exec`
- session ID が分からない（過去ログを失った） → 新規 `codex exec`（バックボーン再投入）

## バックボーン引き渡しパターン（重要）

Codex は Claude のメモリも CLAUDE.md も自動では読まない。下記 3 方式から選ぶ。

| 方式 | いつ使う | 例 |
|---|---|---|
| **inline 展開** | ルール・要件書・メモリが短い（～数千字）、確実に伝えたい | CLAUDE.md の要点・security.md 全文・要件書のサマリをプロンプト本文に直書き |
| **`--add-dir` + 明示 Read 指示** | 対象が repo 外（`~/.claude/rules/` 等） or 長文ドキュメント複数 | `--add-dir ~/.claude/rules` + プロンプト内で「`~/.claude/rules/common/security.md` を最初に読め」と指示 |
| **パス渡し（repo 内相対）** | 対象が `-C` で指定した repo の中にある | プロンプトに `design_doc/xxx/requirements.md を読んで` と書く。`--full-auto` or workspace-write なら読める |

**重い重い時のコツ**:
- **inline + パス渡しを併用**（二重化）すると、サンドボックス制限や Codex の判断ミスで片方がこけても生き残る。S3 の整合性レビューで実証済み
- Claude の auto memory（`~/.claude/projects/.../memory/*.md`）から関連項目を抜粋して inline 展開するのが最も確実
- プロンプト肥大化を恐れない。Codex の context は広く、**渡さなかった情報は絶対に使われない**

## 実行モードと承認（ユーザー確認の要否）

`-s read-only` でのレビュー / diff 読解 / コード解析は **ユーザー確認を取らず、そのまま Bash で `codex exec` を実行する**。副作用なし（ファイル書き込み・ネット・プロセス破壊なし）なので、事前に「実行していいですか」の問い合わせは不要・冗長。

確認を取るべき例外（これらに該当する時のみユーザーへ事前確認）:

- **巨大 diff**（3000 行超 / 30 ファイル超 / マージコミット）: 分割方針の合意。read-only でも resource 浪費（数時間暴走・session ID 喪失）を防ぐため必須
- **書き込みモード**（`-s workspace-write` / `--full-auto` / `-s danger-full-access`）: 変更範囲・影響対象の合意
- **プロンプト内容が破壊的操作を指示**（ファイル削除、force push、`git reset --hard` 等）: 実行前にユーザーと意図確認
- **外部サービスへの公開を含む**（PR 作成、Slack 投稿、外部 API 呼び出し等）

上記に該当しない「ただのレビュー」「ただの diff 読解」「ただのコード質問」は**即実行してよい**。実行後に結果＋末尾 session ID ブロックを報告する。

## サンドボックスモードの選び方

| 用途 | 推奨モード | 理由 |
|---|---|---|
| 純粋静的レビュー（diff 読解のみ、テスト実行不要） | `-s read-only` + `-o <path>` | 副作用なし。`-o` のファイル書き込みは CLI ドライバ側なので read-only でも最終レポートは生成される |
| レビュー中にテスト実行 / ビルド検証 / 追加ファイル生成を許したい | `codex exec --full-auto` | `-s read-only` だと Codex は「書けない / テスト走らせられない」と判断し**副次作業を自動フォールバックで諦める**（実測で NFR テスト実行が EPERM 失敗した事例あり） |
| ファイル生成・修正 | `codex exec --full-auto` | `--full-auto` = workspace-write + 承認スキップ |
| テスト実行・ネット必要 | `--full-auto` | ネットワーク + 書き込み可 |
| 危険操作（システム変更） | `-s danger-full-access` | 原則使わない。明示承認時のみ |

**罠**: `-s read-only -o <path>` は結果レポートは書き出せるが、Codex プロセス自身は「書き込みブロックされた」と判断して**レポート 1 行目に「sandbox が read-only のため書けませんでした」という注記を残す**ことがある。副次検証（テスト実行等）まで求めるなら迷わず `--full-auto`。

`--full-auto` と `-s read-only` は併用しない（意図が矛盾）。用途が割れるなら `-s` を優先して使い分ける。

## 巨大 diff / 長時間実行への対処

デフォルト `timeout 1200`（20 分）で収まる規模（〜3000 行 / 〜30 ファイル）ならそのまま 1 回で OK。**3000 行超 / 30 ファイル超 / マージコミット** は完走しない可能性が高いので、そのまま投げず**ユーザーに絞り込み合意を取ってから**呼ぶ。

事前判定: `git show --stat <target>` / `gh pr diff <N> --stat` で規模を俯瞰してから Codex を呼ぶ。

詳細（規模別目安表・分割パターン・タイムアウト対策・実測失敗ケース）は `references/large-diff.md` を参照。巨大 diff を扱うタスクの**最初に必ず読む**こと。

## テンプレ A/B/C/D の選び方

`references/review-template.md` に 4 種のテンプレあり。レビュー依頼内容で機械的に選べる:

| 依頼の形 | 使うテンプレ |
|---|---|
| 「この diff/PR をレビューして」「コード見て」（観点指定なし） | **テンプレ A**（一般コードレビュー） |
| 「セキュリティ観点で」「脆弱性チェックして」「security.md に沿って」 | **テンプレ B**（セキュリティ特化） |
| 「要件↔実装の一致」「要件書との突き合わせ」「欠損/過剰を見て」「整合性レビュー」 | **テンプレ C**（要件↔実装整合性） |
| 「Codex に bugbot レビューを」「実バグの先回りだけ」「過去 PR のバグを拾えるか検証」 | **テンプレ D**（bugbot 単体: 領域スライス × retro 観点集。4点セットを省略しない） |

迷ったら A。途中で観点が絞れてきたら B/C に切り替える。複合依頼は A を基盤に B/C のチェック項目を追加する。

## `codex exec` vs `codex review` の使い分け

| 状況 | 使うコマンド |
|---|---|
| 背景（ルール・要件・設計書）を渡したい / 観点を細かく指定したい | `codex exec`（本 skill はこれが主） |
| main との diff を素の観点で見るだけでよい | `codex review --diff-target main` |
| 特定 commit / PR を観点付きでレビューしたい | `codex exec`（`codex review` は observer 的で柔軟性が劣る） |

迷ったら `codex exec` を選ぶ。

## 詳細リファレンス

基本コマンド・JSONL 出力・注意事項は下記参照:

- `~/.claude/skills/codex/references/instructions.md`（CLI フラグ集）
- `~/.claude/skills/codex/references/review-template.md`（レビュー用途別プロンプトテンプレ）

## 呼び出し手順（チェックリスト）

レビュー系タスクで Codex を呼ぶ前に:

- [ ] Codex に渡す対象（diff / PR / commit / ファイルパス）を特定したか
- [ ] プロジェクト背景（CLAUDE.md / rule / 要件書）を inline or `--add-dir` で渡せているか
- [ ] Claude の auto memory に関連エントリがあれば抜粋して inline 展開したか
- [ ] サンドボックスモードを用途に合わせて明示したか
- [ ] 出力の受け取り方（`-o` or stdout or `--json`）を決めたか
- [ ] **wrapper `~/.claude/skills/codex/scripts/codex-exec.sh` 経由で起動しているか**（生 `codex exec` は固まりリスク + permission 通らない）
- [ ] **`--ephemeral` を付けていないか**（付けると resume 不能）
- [ ] レビュー観点・出力フォーマットをプロンプトに明記したか（「レビューして」だけで丸投げしていない）
- [ ] ユーザーが同一文脈の追加依頼をしていた場合、新規 `exec` ではなく `exec resume <SESSION_ID>` を使ったか

呼び出し後（報告時）:

- [ ] wrapper の末尾 `=== codex-exec.sh meta ===` ブロックから session ID を抽出したか
- [ ] ユーザーへの報告末尾に `---\nCodex session id: <SESSION_ID>\n同一文脈の継続議論:\n  ~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec resume <SESSION_ID> "<追加プロンプト>"` ブロックを付けたか
- [ ] session ID 取得失敗時、黙って省略せず「取得失敗」と明記したか
