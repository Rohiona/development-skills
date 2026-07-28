# Code Navigation: コードベース探索の原則

コード（.ts/.tsx/.js/.jsx 等）の探索・理解・改変は **Serena をデフォルト**。
型・実装関係・コールグラフが論点になった瞬間だけ **LSP** に切替。Read/Grep/Glob は補助。

## 初回読み込み（deferred。コード探索が必要になった時点で取得）

```
ToolSearch("select:mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__search_for_pattern,mcp__plugin_serena_serena__find_file,mcp__plugin_serena_serena__list_dir,mcp__plugin_serena_serena__find_referencing_symbols,mcp__plugin_serena_serena__activate_project")
ToolSearch("select:LSP")
```

**activate_project 必須**: 未アクティベートだと `No active project`。最初の Serena 呼び出し前
（session 再開後も）に `activate_project(project="<名 or 絶対パス>")`。エラー時は再アクティベート。

## Serena を使う場面

シンボル検索=`find_symbol` / ファイル内一覧=`get_symbols_overview` / 参照元=`find_referencing_symbols` /
regex=`search_for_pattern` / ファイル検索=`find_file` / ディレクトリ=`list_dir` /
書換=`replace_symbol_body`・`insert_after_symbol`・`insert_before_symbol`。

利点: 必要なシンボルだけ読むのでトークン少・AST 精度・全文読み不要。**書換 API を持つのは Serena のみ**。

## LSP に切替えるトリガー（Serena は型推論しないため）

| 論点 | LSP |
|---|---|
| 型/シグネチャ | `hover` |
| interface 実装クラス列挙 | `goToImplementation`（Serena に等価なし） |
| 呼び出し元だけ | `incomingCalls`（find_referencing_symbols は import/型/呼び出しを区別しない） |
| 呼び出し先 | `outgoingCalls` |
| 型エイリアス/再 export 越しの定義 | `goToDefinition` |
| 型システム厳密参照 | `findReferences` |

LSP は読み取り専用・**書換は必ず Serena**。LSP 全操作は `filePath`+`line`+`character`(1-based) 必須、
位置不明なら先に Serena で特定。LSP は TS/JS のみ（.json/.md はエラー）。

## 連携

Serena で位置特定（`find_symbol` で行番号）→ LSP に渡す（`hover` 等）→ 編集は Serena に戻る。

## Read/Grep を使ってよい場面

Serena/LSP 未接続 / 設定ファイル(.json/.md/.yml) / git diff / 画像 / Serena で見つけた後の特定行確認 /
テスト・ビルドログ / モノレポ横断（LSP `workspaceSymbol` は開いている範囲しか拾わないので、広域は
Serena `search_for_pattern` か grep）。

## 編集も Serena で（.ts/.tsx）

Read フックで `.ts`/`.tsx` の native Read がブロックされる環境では、コード編集は最初から Serena
`replace_content` / `insert_after_symbol` / `replace_symbol_body` を使う（Edit/Write を試して失敗してから
切替、をやめる）。.json/.md 等は Edit/Write で良い。

## 禁止

コードの**全体 Read は原則禁止**。まず `get_symbols_overview` で構造把握 → 必要シンボルだけ `find_symbol`。

パラメータ名の取り違え早見・型プローブ（tsc --noEmit）の作法: `~/.claude/references/code-navigation-details.md`
（Serena のパラメータに迷ったとき・`tsc` をアドホックに叩く前に読む）
