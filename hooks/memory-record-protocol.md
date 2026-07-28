# メモリ記録プロトコル（保存手順の詳細）

このファイルは Stop フック（`memory-stop-record.py`）が「記録対象あり」と判断された
ときにだけ読み込まれる詳細手順。トークン節約のため、毎ターン注入される指示は薄くし、
具体はここに切り出してある。記録は **memory skill (claude-mem CLI) のみ**で行う。

## 手順

1. **重複確認（必須・先に実行）**
   `memory` skill の `search` で既存の重複を確認する。実質同じ記録があれば保存をスキップし、
   「既存 id N に記録済みのためスキップ」と 1 行報告して終了する。
   ```bash
   TOOL=~/.claude/skills/memory/scripts/memory_tool.py
   uv run --with chromadb python3 "$TOOL" search "<決定の要点キーワード>" --limit 8 --project <project>
   ```

1.5 **訂正のときは旧記録を無効化する（2026-07-04 追加）**
   保存する内容が既存レコードの「訂正・置き換え」なら、`save` に `--replaces <旧id,旧id>` を必ず付ける
   （旧レコードが検索から除外され、訂正版だけが出るようになる。旧情報の残留事故防止）。
   新規保存を伴わない遡及の無効化は `deprecate --old <旧id,...> --new <訂正版id>`。

2. **保存（重複が無いときだけ）**
   ```bash
   uv run --with chromadb python3 "$TOOL" save \
     --title "<日本語 30〜60 字の 1 行サマリ>" \
     --text "<決定/基準・理由・前提・出典 URL/Slack リンク等を原文のまま保持>" \
     --facts '["核心事実1", "核心事実2", "出典リンクも 1 項目として", ...]' \
     --type <decision|discovery> \
     --project <project>
   ```
   - `--type`: 意思決定・方針なら `decision`。調査で判明した事実なら `discovery`。
   - `--title`: 単独で意味が通る 1 行サマリ（半角英数記号は 2 文字 = 全角 1 文字換算）。
   - `--text`: 「決定/基準」「理由・前提・制約」「出典」を要点保持。固有表現は 1 行展開を添える。
   - `--facts`: 核心事実 3〜5 個を JSON 配列。`--text` の一文丸写しは避け、主語・動詞を組み替えた短文に。
     **出典 URL / Slack / Notion / PR・Issue リンク / コミット SHA は必ず 1 項目として facts に入れる**（別角度の検索でヒットさせるため）。
   - `--project`: cwd のプロジェクトルート名（echo リポなら `echo`）。

3. **禁止事項**
   `~/.claude/projects/*/memory` への file 書き込みは禁止（file-based auto-memory は無効ポリシー）。
   Serena の `write_memory` 等も使わない。記録経路は memory skill CLI に統一。

4. **報告**
   記録したら「id / title / 要点」を 1 行で報告して終了する。
