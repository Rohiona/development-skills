# development-skills

Claude Code の自作スキル群・レビュー体制・Memory 機構・hooks 一式を、任意のプロジェクト/現場へ持ち運ぶためのポータブルセット。
特定プロジェクト固有の記述は除去済みで、`~/.claude` 配下へ展開すればそのまま使える。

## 構成

| ディレクトリ | 中身 | 展開先 |
|---|---|---|
| `skills/` | スキル本体（hahifuhe シリーズ、review 系、sansha-kyogi、handoff、pdca、memory、codex、autonomous-dev など） | `~/.claude/skills/` |
| `commands/` | スラッシュコマンド（`/hahifuhe:*`、`/bugbot-review`、`/pdca`、`/review-retro` など） | `~/.claude/commands/` |
| `agents/` | サブエージェント定義（hahifuhe-* レビュアー群、bugbot-review + 観点集 lenses） | `~/.claude/agents/` |
| `workflows/` | Workflow スクリプト（review-all.js、autodev-downstream.js、verify-shadow-audit.js） | `~/.claude/workflows/` |
| `hooks/` | hooks（Cursor 委譲強制、compact 保存/復旧、handoff、Memory 記録/想起、push ガード等） | `~/.claude/hooks/` |
| `scripts/` | 補助スクリプト（cursor-exec.sh、review-worktree-clean.sh、token-report.sh 等） | `~/.claude/scripts/` |
| `rules/common/` | 常時ルール（epistemic-honesty、code-navigation、token-economy、shell-robustness 等） | `~/.claude/rules/common/` |
| `references/` | 正本ドキュメント（review-policy-v5、cursor-delegation、communication-style 等） | `~/.claude/references/` |
| `plugins/` | ローカルプラグイン（clipboard-screenshot） | `~/.claude/plugins/local/` |
| `templates/` | グローバル CLAUDE.md テンプレート・settings.json の hooks 配線テンプレート | 手動マージ |

## 導入手順

```bash
git clone git@github-personal:Rohiona/development-skills.git && cd development-skills
./install.sh          # ~/.claude へソフトリンク導入（既存の同名エントリはスキップ。置換は --force）
```

**ソフトリンク方式**: ディレクトリ丸ごとではなく中身1つずつ（スキル単位・ファイル単位）を `~/.claude` 配下へリンクする。

- 導入先に元からあるローカル専用スキル・hooks とそのまま共存できる
- このリポジトリを `git pull` すれば全現場に即反映される
- 逆に現場でスキルを改良すればリポジトリの `git diff` に現れるので、コミットして他現場へ還元できる
- 例外は `CLAUDE.md` のみコピー配置（導入先ごとにプロジェクト固有節を追記して育てるため）
- アンインストールは install.sh 末尾に表示される find コマンド1発（このリポジトリを指すリンクだけを外す）

その後の手動ステップ:

1. **hooks の配線**: `templates/settings.hooks.json` の `hooks` を `~/.claude/settings.json` にマージする（インストーラは settings.json を触らない）。不要な hook は行ごと外してよい。
2. **CLAUDE.md**: 新規環境なら `templates/CLAUDE.md` がそのまま `~/.claude/CLAUDE.md` に置かれる。既存があれば手動マージ。プロジェクト固有の節（資格情報の取り方・チームルール等）は導入先で追記する。
3. **領域マップの記入**: `skills/extract-testable-module/references/area-map.md` の対応表を導入先リポジトリの構造に合わせて記入する（自己点検の領域ルーティングに使う）。
4. **学習データは空から**: 観点集（lenses）の学習ケース（`*.cases.jsonl`）はプロジェクトごとに育てるものなので同梱していない。`/review-retro` を回すと貯まっていく。

## 前提ツール

| ツール | 用途 | 無い場合 |
|---|---|---|
| `gh` CLI | PR 系スキル（bugbot-loop、review-retro 等） | PR 系スキルが動かない |
| Codex CLI（`codex`） | codex スキル・review-all の Codex 波 | review-all はフォールバック（品質低下） |
| Cursor agent CLI | 実装委譲（cursor-exec.sh、cursor-delegation-enforce.py） | hooks から該当行を外して直接実装に切替 |
| `uv` + Python 3 | memory スキル（chromadb を uv 経由で実行）・Python hooks | memory スキルが動かない |
| Serena / LSP プラグイン | code-navigation ルールの前提 | Read/Grep で代替（ルール記載どおり） |

## Memory 機構について

**このリポジトリに含まれるのは機構のみ。記憶データ本体は含まれず、今後もコミットしない。**

- 機構: `skills/memory/`（SQLite + ChromaDB のセマンティック検索 CLI）、`hooks/memory-recall-detect.py`（想起トリガー検出）、`hooks/memory-stop-record.py`（セッション終了時記録）、`hooks/memory-record-protocol.md`
- データ実体の置き場所: `~/.claude-mem/`（リポジトリ外）。`.gitignore` でも DB ファイル類を明示的に除外している。

## 由来と注意

- 元は特定プロジェクト運用下で育てたセットで、固有記述（プロジェクト名・ドメイン用語・人名・チケット/PR 番号・資格情報の取得手順）は移植時に除去・汎用化した。
- スキル間は相互参照している（例: review 系スキル ↔ `references/review-policy-v5.md` ↔ `agents/*.lenses.md`）。部分導入する場合は参照先の欠けに注意。
- hooks は挙動を強制する（例: `cursor-delegation-enforce.py` は一定サイズ以上のコード直接編集をブロック）。合わない現場では `settings.json` の該当配線を外すこと。
