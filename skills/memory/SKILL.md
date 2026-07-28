---
name: memory
description: セッション横断メモリ。セマンティック検索で過去の作業を記憶・想起。「覚えて」「思い出して」「記憶して」「メモリに記録」「メモリから検索」「前にやったことある？」「以前の作業を探して」等で起動
---

# Memory

`memory` は `~/.claude/skills/memory/scripts/memory_tool.py` を使う共通メモリスキル。
Claude / Codex の両方で、同じ CLI と同じ保存先（claude-mem: SQLite + ChromaDB）を使う。

## 使うツール / 使わないツール（最重要）

このスキルで **使う** のはこの CLI のみ:

- `~/.claude/skills/memory/scripts/memory_tool.py`（`uv run --with chromadb python3 "$TOOL" ...`）

次の Serena MCP ツール群は **このスキルでは使わない**:

- `mcp__plugin_serena_serena__write_memory`
- `mcp__plugin_serena_serena__read_memory`
- `mcp__plugin_serena_serena__list_memories`
- `mcp__plugin_serena_serena__delete_memory`
- `mcp__plugin_serena_serena__rename_memory` / `edit_memory`

理由: Serena memory はプロジェクト毎のローカル知識ベース用で、**セッション横断・セマンティック検索の用途には claude-mem CLI を統一経路にしている**。両者は保存先が別 DB のため、混在させると記憶が分散して想起できなくなる。
「覚えて」「思い出して」系の発話には、たとえ Serena MCP の memory tool が環境にあっても **必ず** この CLI を呼ぶこと（Serena のコード探索系ツール `find_symbol` / `search_for_pattern` 等は引き続き使って良い）。

## CLI

```bash
TOOL=~/.claude/skills/memory/scripts/memory_tool.py

# セマンティック検索（--project で現在のプロジェクトに絞るのが既定）
uv run --with chromadb python3 "$TOOL" search "検索クエリ" --limit 10 --project myproject

# 記憶を保存（facts を渡すと検索ヒット率が上がる）
uv run --with chromadb python3 "$TOOL" save \
  --title "タイトル" \
  --text "記憶する内容" \
  --facts '["事実1", "事実2", "事実3"]' \
  --type discovery \
  --project myproject

# 直近の記憶（保存直後の想起や、search が弱いときのフォールバックで使う）
uv run --with chromadb python3 "$TOOL" recent --limit 20 --project myproject

# 統計
uv run --with chromadb python3 "$TOOL" stats --project myproject

# 詳細表示（id 指定で本文を取得）
uv run --with chromadb python3 "$TOOL" detail 1234
```

## 使い方

### ユーザーが「覚えて」「記憶して」と言った場合

1. 現在の会話から記憶すべき内容を要約する
2. `save` コマンドで保存する
3. `--title` は **日本語で 30〜60 文字目安（全角換算、記号含む）**。単独で意味が通る 1 行サマリ（体言止めでも動詞でも可）
   - 換算の簡易ルール: **半角英数・記号 2 文字 = 全角 1 文字** として丸めて数える（例: `#3577` は 5 半角 ≒ 2.5 ≒ 3 全角相当）。厳密でなくて良い
4. `--text` は要約本文。原因・対策・根拠など要点を保持する。固有表現（内部コード・プロジェクト略語・バージョン等）は**本文中で 1 行の展開**を添える（例: `R18（= 一括削除 + フェーズ 0 PR 前段の方針）`）
5. `--facts` は `--text` から抽出した **3〜5 個の核心事実** を JSON 配列で渡す。これにより narrative とは別に各事実が独立して embedding され、**別角度のクエリからでもヒットするようになる**。
   - `--text` と内容が重複しても OK（むしろ重複させて別角度で切る）。ただし `--text` の一文をそのまま facts に丸ごと再掲するのは避け、**主語・動詞・目的語を組み替えた短文**にする（例: text「〜で DELETE_FAILED が発生」→ fact「BucketPolicy 先行削除順序問題で DELETE_FAILED」）
   - 省略可だが、後から検索したい重要な記録では必ず付ける
6. `--type` は内容に応じて次から選ぶ:
   - `discovery` — 新しい気づき・調査で判明した事実（「〜と分かった」「〜に気づいた」）
   - `bugfix` — 発生したバグの原因と修正内容
   - `feature` — 新機能の追加・実装記録
   - `refactor` — 既存コードの構造整理（挙動変更なし）
   - `change` — 設定変更など上記に当てはまらない変更一般
   - `decision` — 方針・設計の意思決定記録（「〜することに決めた」）
7. `--project` の決定順: (1) ユーザーが明示指定 → それに従う / (2) 明示指定なし → cwd のプロジェクトルート名（`myproject` リポジトリで作業中なら `myproject`）/ (3) 迷ったら CLAUDE.md の project 名を参照

### ユーザーが「思い出して」「前にやった X について」と言った場合

1. `search` コマンドでセマンティック検索する。クエリはユーザー発言のキーワードをそのまま使うのが基本
   - **`--project` で現在のプロジェクト（cwd のルート名、`myproject` リポ作業中なら `myproject`）に絞るのが既定**。絞らないと `empirical-test` 等の評価用データや他プロジェクトが上位に混入して誤誘導される。横断検索したい場合だけ `--project` を外す
2. 結果の関連度は **distance と「クエリ意図との一致」の両方** で判断する:
   - `distance < 1.0` **かつ** タイトル/要点がユーザー意図と合致 — 関連あり、そのまま返答に使える
   - `distance 1.0〜1.2`、または `< 1.0` でも意図と乖離（例: 「#3577 決済機能の統合」を聞かれたのに「決済機能の全般調査」がヒット）— 弱関連、タイトルを確認し必要なら `detail` で深掘り、同時に **(a')** に進む
   - **境界値（`1.0` ちょうど等）は弱関連側に倒す**（`1.0000`〜`1.0049` は 1.0 区間扱い）
   - `distance > 1.2` — ほぼ無関連、ヒット扱いしない
   - **`matched_field: "fts"` / `distance: null`** — クエリ文字列が title または narrative に含まれていることによる全文検索ヒット（semantic とは別経路）。意図合致なら強関連扱い、distance 判定は適用しない
3. 関連ヒットが弱い / 無い場合のフォールバック（順に試し、合計 retry は 3 回を超えない）:
   a. 同義語・言い換えで 1 回だけ再検索（日本語 ⇔ 英語切替、略語展開、同義テクノロジー名など）
   a'. **直近作業の想起や「さっき保存したはず」のケースでは `recent --limit 20` で直近リストを一覧確認する**（semantic search は短文や固有表現で distance が 1.0〜1.3 に落ちやすく、存在するのに埋もれる）
   a''. **候補 id が特定できた場合は `detail <id>` で本文を取得**して引用に使う
   - 「ヒットを示せた」の判定: `recent` の title 列や `detail` の narrative からユーザー意図に合致する要点が取れた時点で成立。全件の本文引用までは不要
   b. それでも無ければ「見つからなかった」と明示し、ユーザーに追加キーワードの提示を促す
   c. 自動で 3 回以上 retry しない（無限探索を避ける）
4. `detail` は「タイトルだけでは本文が想像できない」「要点を引用して返したい」ときに取得する。タイトルで用が足りるなら省略可
5. ユーザーへの返答テンプレ（複数ヒット時）:
   - 該当件数の明示 → 各件を「id / title / 日付 / 要点 1〜2 行」で列挙 → 必要なら追加アクションの提案
6. save と search の両方を頼まれた場合の順序:
   - 原則 **search → save** の順で実行する。自分が保存したばかりの項目がノイズとしてヒットするのを避けるため
   - 例外: ユーザーが明示的に「先に保存して」と順序を指定した場合はそれに従う

## Notes

- 実装本体は `manifest.md` ではなく CLI (`memory_tool.py`) にある
- Claude / Codex の両方で同じ CLI を使うため、処理経路は共通
- 旧 `memory-manager` は Codex 側 symlink を無効化済み
