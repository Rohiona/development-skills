# Codex CLI

Codex CLI を非インタラクティブに実行する。**Claude から起動するときは必ず wrapper
`~/.claude/skills/codex/scripts/codex-exec.sh` 経由**。生 `codex exec` を Bash で直接叩くと
PreToolUse フック（`codex-wrapper-enforce.py`）でブロックされる。

wrapper の形:

```bash
~/.claude/skills/codex/scripts/codex-exec.sh <timeout_sec> <subcommand> [codex に渡す引数...]
```

第 1 引数は timeout 秒数（既定 1200 = 20 分、短縮 600、拡張 1800/3600）。残りは `codex` に
そのまま渡る。wrapper が timeout 適用 / `</dev/null` 強制 / tee ログ保存 / session ID 抽出 を一括で行う。

使う Codex は wrapper が「`CODEX_BIN` → デスクトップアプリ同梱の CLI → PATH 上の `codex`」の順に選ぶ（SKILL.md「使われる Codex の版」参照）。

## 基本コマンド

```bash
# 基本形式（workspace-write）
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write "プロンプト"

# 書き込みを許す（旧 --full-auto 相当。0.160.0 で --full-auto は廃止）
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write "プロンプト"

# 作業ディレクトリ指定（レビュー/編集対象の repo・worktree は必ずこれで固定する）
# Codex はブランチを引数で取らない。-C のディレクトリの「checkout 中ブランチ + 未コミット差分」をそのまま見る。
# よって -C は必ず現在の作業ツリーをコマンド置換で渡す（概念上の「repo ルート」を手打ちしない）。worktree 取り違え防止。
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write -C "$(git rev-parse --show-toplevel)" "プロンプト"

# 最終メッセージをファイルに出力
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write -o result.txt "プロンプト"
```

## サンドボックスモード

| モード | 説明 |
|--------|------|
| `workspace-write` | ワークスペースへの書き込み許可（デフォルト推奨） |
| `read-only` | 読み取り専用 |
| `danger-full-access` | フルアクセス（危険） |

## コードレビュー

```bash
# 現在のリポジトリをレビュー
~/.claude/skills/codex/scripts/codex-exec.sh 1200 review

# diff を指定してレビュー
~/.claude/skills/codex/scripts/codex-exec.sh 1200 review --diff-target main
```

## ワークフロー

1. ユーザーから Codex へのタスク依頼を受ける
2. `~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec -s workspace-write "タスク内容"` を実行
3. 出力を確認し、必要に応じて結果をユーザーに報告
4. Codex からの質問や確認事項があれば:
   - 自分で判断できる場合: 適切に対応
   - 判断できない場合: AskUserQuestion ツールでユーザーに確認

## 出力のハンドリング

構造化出力（JSONL）が必要で、wrapper を介さず直接 `codex exec --json` を叩く必要がある場合は、
`session_meta` イベントの `payload.id` を `jq -r 'select(.type=="session_meta") | .payload.id'`
で抽出する（通常は wrapper の末尾 meta ブロックから取れるので不要）。

## 注意事項（wrapper が吸収する罠 + 残る注意点）

wrapper が自動でやること（手で書かなくてよい）:

- **timeout 適用**: Codex は自分では止まらない。wrapper が第 1 引数の秒数で打ち切る
- **`</dev/null` で stdin を閉じる**: 忘れると「Reading additional input from stdin...」で無言ハング（iter 3 実測で必須）
- **tee ログ保存**: `-o` が空/未生成でも tee ログから最終出力を拾える
- **session ID 抽出**: 末尾 meta ブロックに出力

手で気をつける残りの点:

- 1 Codex 呼び出しあたり 10 分以内を目安にする。超えるなら対象を分割
- Git 未管理ディレクトリでは `--skip-git-repo-check` を追加（wrapper の引数として渡す）
- 複数ディレクトリへの書き込み・読み取りが必要な場合は `--add-dir` を使用
- `-o <path>` は **Codex が最終メッセージを正常に出したときだけ書き出される**。タイムアウト（exit 124）や異常終了では空のまま or 未生成（tee ログで回収）
- `-s read-only` でも `-o` 書き込み自体は CLI ドライバ側なので成立するが、Codex プロセス自身は「書けない / テスト実行できない」と判断し、**副次作業を自動で諦める**（テスト走らせたいなら `-s workspace-write` を選ぶ）
- 巨大 diff（3000 行超 or 30 ファイル超、マージコミット含む）はそのまま投げず、Claude 側で `git show --stat` で俯瞰して絞り込みをかけてから渡す

## 推奨の呼び出し雛形

```bash
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec \
  -s read-only \
  -C "$(git rev-parse --show-toplevel)" \
  -o /tmp/codex-out.md \
  "<prompt>"
```

実行後、wrapper の stdout 末尾に出る `=== codex-exec.sh meta ===` ブロックから `session_id` を
読み取り、ユーザー報告の末尾で必ず明示する。

## セッション再開（継続議論）

同一文脈で追加依頼するときは `exec resume <SESSION_ID>` を使う。バックボーン再投入が不要。

```bash
~/.claude/skills/codex/scripts/codex-exec.sh 1200 exec resume "$SESSION_ID" \
  "<追加観点>"
```

`--ephemeral` を付けるとセッションが disk に残らず resume できない。継続議論前提なら絶対に使わない。

## 長時間実行タスクの回収

Codex が途中で止まった・タイムアウトした場合:

- **`-o` ファイルが空/未生成でも焦らない**。wrapper の tee ログ（`log:` 行のパス）から最終出力を拾える
- プロセスが孤児化したら `pgrep codex` で PID 確認 → 明確に不要なら `kill <PID>`（残り続けると CPU を食う。iter 3 では 3 日走り続けた残骸を確認）。wrapper は timeout で打ち切るので孤児化自体が起きにくい
- 中断時に**再開はできない**。対象を絞り直して新規 `exec` を打ち直す
