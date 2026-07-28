---
name: memory
description: "セッション横断メモリ。セマンティック検索で過去の作業を記憶・想起。「覚えて」「思い出して」「記憶して」「メモリに記録」「メモリから検索」「前にやったことある？」「以前の作業を探して」等で起動"
trigger: "覚えて|思い出して|記憶して|記憶を|メモリ|mem-save|mem-search|mem-recent|mem-stats|前にやった|以前の|過去の作業"
---

# Memory Skill

セッション横断の永続メモリ。SQLite + ChromaDB によるセマンティック検索。

## CLI

```bash
TOOL=~/.claude/skills/memory/scripts/memory_tool.py

# セマンティック検索
uv run --with chromadb python3 "$TOOL" search "検索クエリ" --limit 10

# 記憶を保存
uv run --with chromadb python3 "$TOOL" save \
  --title "タイトル" \
  --text "記憶する内容" \
  --type discovery \
  --project myproject

# 直近の記憶
uv run --with chromadb python3 "$TOOL" recent --limit 10

# 統計
uv run --with chromadb python3 "$TOOL" stats

# 詳細表示
uv run --with chromadb python3 "$TOOL" detail 1234
```

## 使い方ガイド（Claude向け）

### ユーザーが「覚えて」「記憶して」と言った場合

1. 現在の会話から記憶すべき内容を要約する
2. `save` コマンドで保存する。`--title` は短く具体的に、`--text` は要約本文、`--facts` は個別の事実をJSON配列で渡す
3. `--type` は内容に応じて選択: discovery, bugfix, feature, refactor, change, decision

### ユーザーが「思い出して」「前にやった X について」と言った場合

1. `search` コマンドでセマンティック検索する
2. 結果を読みやすく整形して提示する
3. 必要なら `detail` で詳細を取得する

### type の使い分け

| type | 用途 |
|------|------|
| discovery | 調査・発見・学び |
| bugfix | バグ修正の記録 |
| feature | 機能実装の記録 |
| refactor | リファクタリング |
| change | 設定変更・環境変更 |
| decision | 意思決定・ADR |
