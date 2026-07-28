---
name: handoff
description: >-
  現在の会話を、別のエージェント（新しい Claude Code セッション / Codex / サブエージェント）が
  そのまま引き継げる「ハンドオフ・ドキュメント」に圧縮して書き出すスキル。
  長くなったセッションを別プロセスへ渡したい、コンテキスト上限が近い、作業を中断して後で / 別の人や
  エージェントに続けてもらいたい、というときに使う。
  「ハンドオフして」「引き継ぎ資料を作って」「別セッションに渡したい」「ここまでをまとめて次に渡して」
  「コンテキストを圧縮して引き継ぎ」等で発火する。
  Matt Pocock の handoff を移植（日本語・敬語・成果物参照・秘匿情報の redaction）。
---

# Handoff

現在の会話を、文脈ゼロの別エージェントが拾って続行できる**自己完結したタスク handoff JSON**に圧縮する。

**系統**: 本スキル（AI 生成）= **JSON**（`task-*.json`）。SessionEnd 自動 dump（`handoff-dump.sh`）= **md**（`{session_id}.md`）のまま変更なし。役割が別なので併存してよい。

## 原則

- **再述より参照**。既にある成果物（要件書・設計書・PR・ADR・コミット・diff・チケット・memory）は中身をコピーせず、**パス or URL で参照**する。
- **事実 / 推論 / 推測を分ける**。確定事実には出典（file:line / コマンド結果 / SHA）を付け、未確認は「要確認」と明示する。
- **精密ポインタ**:
  - 対象の一次情報 URL を必ず添える（Notion / PR / Issue）。新旧で紛らわしいリソースは `{url, note}` の note で同一性を1行区別する。
  - **コード位置は `file:line` で固定**（内容説明での代用禁止。機械検証はしない — 規律依存）。
  - 各前提に検証ラベル（事実 / 未確認）を付ける。
- **秘匿情報は redact**。API キー・トークン・キーチェーン値等は書かない。
- **保存先**: `~/.claude/handoff/<cwd-slug>/task-<topic-slug>-<UTC ts>.json`（リポジトリ内には置かない）。`<cwd-slug>` = cwd の `/` を `-` に置換（自動 dump と同じ規則）。
- **「どこで」は機械収集**: branch / worktree / headSha / prUrl / prHeadSha は **AI が書かず** `collect-facts.sh` が埋める。
- **連鎖 handoff**: 新版は `supersedes` に旧版パスを列挙。旧版の `invariantsAdr` は **verbatim コピー**（言い換え禁止）。意図的に外す場合は `dropped-invariants.json` に `{text, reason}` で旧文言＋理由を書く（照合は文字列完全一致）。
- **フィールド境界**:
  - `invariantsAdr` = 触ってはいけない核・確定判断（ADR 相当）
  - `envNotes` = 環境の再現手順・接続情報（秘匿値は redact）
- ユーザーが「次に何をするか」を渡したら、それを `goal` の焦点とする。

## スキーマ（schemaVersion: 1）

```json
{
  "schemaVersion": 1,
  "topic": "string",
  "createdAt": "ISO8601（collect-facts.sh が書く）",
  "place": { "branch": "", "worktree": "", "headSha": "", "prUrl": "URL|\"none\"", "prHeadSha": "sha|null" },
  "goal": "md string",
  "scope": { "do": ["..."], "dontDo": ["..."] },
  "invariantsAdr": ["md string"],
  "summary": "md string",
  "primarySources": [{ "url": "", "note": "新旧・同一性の1行区別" }],
  "doneArtifacts": [{ "kind": "pr|commit|file|doc", "ref": "", "note": "" }],
  "openQuestions": ["..."],
  "envNotes": ["..."],
  "recommendedSkills": ["任意"],
  "supersedes": ["同ディレクトリ内の旧版パス"],
  "staleness": { "parallelEditors": false, "note": "" },
  "needsCompletion": false,
  "droppedInvariants": [{ "text": "旧文言 verbatim", "reason": "外した理由" }]
}
```

`droppedInvariants` は supersede 時のみ任意。検証通過後も監査用に残してよい。

## 生成フロー（AI は生 JSON を書かない）

スクリプト正本: `~/.claude/skills/handoff/scripts/`

### 1. 機械事実の収集

```bash
bash ~/.claude/skills/handoff/scripts/collect-facts.sh > /tmp/handoff-facts.json
```

### 2. 散文フィールドを md 断片に書く（workdir）

作業ディレクトリ例: `/tmp/handoff-work-<topic>/`

| ファイル | 内容 |
|---|---|
| `goal.md` | **先頭行に着手モード必須**: `即着手可` または `要確認（何を確認するか）`。続けて次にやること |
| `summary.md` | 現状サマリー（file:line・検証ラベル付き） |
| `scope-do.txt` | やること（1行1項目） |
| `scope-dont.txt` | やらないこと（1行1項目） |
| `invariants/*.md` | 不変条件（supersede 時は旧版から verbatim コピー） |
| `primary-sources.json` | `[{"url":"...","note":"..."}]`（対象が本当に無い場合のみ `[{"url":"none","note":"理由"}]`） |
| `done-artifacts.json` | `[{"kind":"pr","ref":"...","note":"..."}]` |
| `open-questions.txt` | 未解決（1行1項目） |
| `env-notes.txt` | 環境メモ（1行1項目） |
| `recommended-skills.txt` | 推奨スキル（1行1項目・任意） |
| `dropped-invariants.json` | supersede で外す不変条件 `[{"text":"...","reason":"..."}]`（任意） |
| `parallel-editors.flag` | 並列編集ありなら空ファイルを置く |
| `staleness-note.txt` | 鮮度注意（任意） |

**エスケープを AI が扱わない** — 本文はすべてファイルに書き、JSON 組み立ては jq に任せる。

### 3. JSON 組み立て

```bash
slug=$(pwd | sed 's#/#-#g')
ts=$(date -u +"%Y%m%dT%H%M%SZ")
topic_slug="<トピックのファイル名安全な形>"
out="$HOME/.claude/handoff/${slug}/task-${topic_slug}-${ts}.json"
mkdir -p "$(dirname "$out")"

bash ~/.claude/skills/handoff/scripts/assemble-handoff.sh \
  --topic "<トピック>" \
  --facts /tmp/handoff-facts.json \
  --workdir /tmp/handoff-work-<topic> \
  --output "$out" \
  --supersedes "$HOME/.claude/handoff/${slug}/task-旧版.json"   # 連鎖時のみ・複数可
```

### 4. 検証（fail-closed）と再生成ループ

```bash
bash ~/.claude/skills/handoff/scripts/validate-handoff.sh "$out" --git-dir "$(pwd)"
```

- 失敗したら stderr の指摘を直し、**最大3回** 2→3 を繰り返す。
- **3回目も失敗** → 機械フィールドのみの最小 JSON を `--needs-completion` で保存:

```bash
bash ~/.claude/skills/handoff/scripts/assemble-handoff.sh \
  --topic "<トピック>" --facts /tmp/handoff-facts.json \
  --workdir /tmp/handoff-work-minimal --output "$out" --needs-completion
```

（minimal workdir は空の goal/summary 等で可）。ユーザーへ **「handoff は不完全（要補完）」** と報告し、**「完了」と言わない**。

形式検証で拾えない欠陥（中身の空疎・誤り）は検証では防げない — 引き継ぎ先は一次情報で裏取りすること。

### 5. ユーザー報告

- 書き出した JSON パス
- topic / branch / 引き継ぎ先が最初に Read すべき内容
- 検証結果（完全 / needsCompletion）
- **コピー可能ブロック（毎回必須）**: 下記「コピー可能ブロック」の形式で必ず出力する（2026-07-04 閣下要望: 貼り付け運用が既定。自動注入は保険）

## 自動復元（SessionStart・操作ゼロ）

`handoff-restore.sh` が同一 cwd-slug 内の **task-*.json を md より優先**して注入する。

| createdAt からの経過 | 注入内容 |
|---|---|
| ≤ 14 日 | **常に1行ポインタのみ**（`タスク引き継ぎあり: <topic> / <branch> / <createdAt> / <path>`＋needsCompletion 表示。2026-07-04 閣下決定: 貼り付けブロックが正・自動注入は保険・誤注入の害を1行に固定） |
| 14 日超 | 注入なし（md は dump.sh が prune） |

md 自動 dump 経路の挙動（mtime・5 分窓）は**変更なし**。

## やってはいけないこと

- 生 JSON を AI が直接 Write すること（assemble 経由のみ）。
- 秘匿値の本文記載。
- 既存成果物の長文コピー。
- リポジトリ内への保存。
- 推測を事実として書くこと。
- place フィールドの推測記載。
- primarySources の暗黙の空配列（`none` + 理由のみ許可）。
- 不変条件の言い換えコピー（verbatim 必須）。
- 検証失敗・needsCompletion 時に「完了」と報告すること。

## コピー可能ブロック（毎回出力・必須）

貼り付け運用が既定（2026-07-04 閣下要望・自動注入はあくまで保険）。handoff を書き出したら、毎回最後に次の **コピー可能ブロック** を出す（形式固定）:

````markdown
```
<書き出した handoff .json の絶対パス>
このファイルを読んで続きをやりましょう。応答は日本語（敬体）でお願いします。
```
````

- 1 行目 = JSON の絶対パス
- 2 行目 = 続行合図＋**日本語応答の固定**（英語比率の高い JSON/md を先に Read すると drift するため省略不可）
- linked worktree 等はブロック内に branch/worktree を 1〜3 行足してよい（秘匿値禁止）
- 説明文はブロック外
