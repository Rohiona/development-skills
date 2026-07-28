---
description: ローカル差分を Cursor Bugbot と同じ観点でセルフレビュー（push/PR 前の最終チェック）
argument-hint: "[base-branch | PR番号 | PR URL] (省略時 develop = ローカル差分)"
---

# /bugbot-review — 仮想 Bugbot セルフレビュー（Cursor 実行版）

## 概要

push / PR を上げる前に、ローカルの変更差分を **GitHub の Cursor Bugbot と同じ観点**でセルフレビューする。
Bugbot を初回検出の場にせず、PR 前に実バグを潰すためのコマンド。

**実行役は Cursor（`cursor-agent`）**。観点集 `~/.claude/agents/bugbot-review.lenses.md` を丸ごと渡して
Cursor に一次レビューさせ、その出力を保存して提示する。
実測（過去レビューの実例, 2026-07-03 / memory 1947）で「Cursor は速い・Claude トークンをほぼ使わない・精度も遜色なし」
だったための構成。**Claude の採点（実害ゲート／到達性の再検証, 手順3）は任意**（既定では回さない）。
ただし、この作業の真のコストは検出でなく出た指摘の採点にあるため、**修正に着手する前・High 指摘を扱う前には
採点を回すことを推奨**する。

## このコマンドを実行したら初めにやること

「bugbot-review（Cursor 実行版）を実行」と出力すること。

## 手順

### 1. 対象差分の把握

引数 `$1` は「基準ブランチ」（省略時 `develop`）または「PR 番号 / PR URL」。
PR 指定のときは checkout せず、その PR の差分をレビュー対象にする。

```bash
ARG="${1:-develop}"
if [[ "$ARG" =~ ^[0-9]+$ || "$ARG" == */pull/* ]]; then
  # PR モード: checkout 不要で PR の head を専用 ref に取得
  PR="${ARG##*/}"
  BASE="origin/$(gh pr view "$PR" --json baseRefName -q .baseRefName)"
  git fetch origin "pull/${PR}/head:refs/bugbot/pr-${PR}" --force --quiet
  HEAD_REF="refs/bugbot/pr-${PR}"
else
  # ブランチモード（従来どおり）
  BASE="$ARG"; HEAD_REF="HEAD"
  git fetch origin "$BASE" --quiet 2>/dev/null || true
fi
git diff "$BASE"..."$HEAD_REF" --stat
```

差分が空なら、未コミットの作業ツリー（`git diff` / `git diff --staged`）を対象にする旨を伝えて続行する
（その場合は下の DIFF_CMD を `git diff` に読み替える）。

### 2. Cursor に一次レビューさせる

Cursor 用プロンプトを「動的ヘッダ（対象差分の指定）＋ 固定プリアンブル ＋ 観点集」の順で組み立て、
`cursor-agent` を **現在のリポジトリ（cwd）** で実行する。観点集を実行時に `cat` するので、
`/review-retro` による観点集の更新が自動で反映される。

```bash
# BASE / HEAD_REF / PR は手順1で設定済み
DIFF_CMD="git diff ${BASE}...${HEAD_REF}"          # 差分が空なら "git diff" に置換
PROMPT="$(mktemp -t bugbot-prompt.XXXXXX.md)"
{
  echo "## レビュー対象の差分（この worktree 内で実行して差分を取得すること）"
  echo ""
  echo '```bash'
  echo "${DIFF_CMD}"
  echo '```'
  echo ""
  echo "基準ブランチ: ${BASE}"
  if [ "$HEAD_REF" != "HEAD" ]; then
    echo ""
    echo "注意: これは PR #${PR} の差分であり、作業ツリーのファイル実体は PR の内容と一致しない。"
    echo "cross-file 検証でファイルの中身を見るときは 'git show ${HEAD_REF}:<path>' で PR 側を読むこと。"
  fi
  echo ""
  cat ~/.claude/agents/bugbot-review.cursor-preamble.md
  cat ~/.claude/agents/bugbot-review.lenses.md
} > "$PROMPT"

if [ "$HEAD_REF" = "HEAD" ]; then
  TAG="$(git rev-parse --abbrev-ref HEAD | tr '/' '-')-$(git rev-parse --short HEAD)"
else
  TAG="pr-${PR}-$(git rev-parse --short "$HEAD_REF")"
fi
mkdir -p ~/.claude/bugbot-logs
LOG=~/.claude/bugbot-logs/"${TAG}".md
{
  echo "<!-- base=${BASE} fullsha=$(git rev-parse "$HEAD_REF") engine=cursor(composer-2.5) generated=$(date -u +%FT%TZ) -->"
} > "$LOG"

cursor-agent -p --force --model composer-2.5 --output-format text "$(cat "$PROMPT")" >> "$LOG" 2>&1
echo "exit=$? / saved: $LOG"
```

- モデルは既定 `composer-2.5`（実装委譲の既定と同じ。2026-07-10 コスト見直しで Fast 版 `composer-2.5-fast` から変更）。速度を優先したいときだけ `--model composer-2.5-fast` に戻す。
- **`cursor-agent` が使えない／異常終了したときはフォールバック**: Agent ツールで `subagent_type: bugbot-review`
  を起動し（基準ブランチと「観点集で全件・重大度順・読み取り専用」を渡す）、その出力を同じ `$LOG` に保存する。
  領域が分かれる巨大差分では領域別（frontend / engine / migration / cdk 等）に並列起動してよい。

### 3-a. 既定: Cursor の一次出力をそのまま提示

`$LOG` に保存された Cursor の一次レビューを、**「Cursor 一次出力（未採点）」と明示**した上で重大度順に提示する。
末尾の「High n / Medium n / Low n」サマリと「要目視」も Cursor の出力のまま伝える。
このとき Claude 側で深い実害ゲート／到達性検証は行わない（トークン節約のため）。**自動修正はしない。**

提示の最後に「採点（実害ゲート／到達性の再検証）を回すか、特定の指摘だけ採点するか」を一言確認する。

### 3-b. 任意: 採点（求められた時、または修正着手前・High 指摘を扱う前に推奨）

利用者が採点を求めた／特定指摘を指定した／修正に入るときは、対象の指摘について次を**一次情報で**確かめる:

- **実害ゲートの再適用**: 「未対応で本当に実害が出るか」。到達しない・過剰防御は「参考」へ落とす。
- **到達性・発火条件の検証**: 「再実行・異常系・到達性に依存する指摘」は、その条件が production で現実に起きるかを
  コードで確認し、無条件成立でないなら severity を上げすぎない（memory 1947 の教訓：静的に成立する不整合＝高、
  条件依存＝中以下が目安）。
- **誤検知の除去**: 「機構が成立しない」「参照先が実は使われている」等はコード参照（Serena/grep）で確認して落とす。
- 事実・推論・推測を区別し、severity を確定する前に epistemic-honesty ルールの (a)〜(d)（意図的か/本番到達か/
  test-prod/この diff 由来か）を満たす。

採点で Cursor の一次 severity を変更した場合は、その旨（元→修正・理由）を1行添える。

## 補足

- 本物の GitHub Bugbot とは非決定的かつ非同一。LGTM は保証しない（PR 後の Bugbot が最終ゲート）。
- スタイル/フォーマットは指摘しない（`pnpm check` / Biome の責務）。
- 観点・実害ゲート・出力形式の実体は `~/.claude/agents/bugbot-review.cursor-preamble.md`（固定部）＋
  `~/.claude/agents/bugbot-review.lenses.md`（観点集）＋ `~/.claude/agents/bugbot-review.md`（フォールバックのサブエージェント定義）に定義。
- 保存ログ `~/.claude/bugbot-logs/<branch>-<shortsha>.md` は `/review-retro` の同一コミット比較に使う（形式維持）。
- GitHub PR 上の本物 Bugbot の対応ループは別スキル `bugbot-loop`（役割分担）。
