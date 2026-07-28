# Code Navigation 詳細（パラメータ早見・型プローブ作法）

> 発火条件: Serena ツールを呼ぶ前にパラメータ名へ迷い・エラーが出たとき ／ `tsc` をアドホックに叩く前。
> 経緯: 2026-07-22 ルールダイエットで `rules/common/code-navigation.md` から退避（原文無改変）。
> スナップショット: `~/.claude/backups/rule-diet-20260722/`。

## パラメータ名クイックリファレンス（取り違え頻発・呼ぶ前に確認）

- `find_symbol`: `name_path_pattern`（`name_path` ではない）/ `relative_path` / `include_body`
- `replace_symbol_body`: `name_path`（`_pattern` なし）/ `relative_path` / `body`
- `replace_content`: `relative_path` / `needle` / `repl` / `mode`(`'literal'`|`'regex'`)。複数一致は `allow_multiple_occurrences: true`
- `insert_after_symbol` / `insert_before_symbol`: `name_path` / `relative_path` / `body`
- `find_referencing_symbols`: `name_path`（`_pattern` なし）/ `relative_path`（`find_symbol` の `name_path_pattern` と混同しない）
- `search_for_pattern`: `substring_pattern`(+ `relative_path` / `paths_include_glob`)

## 型プローブ（tsc --noEmit）の作法（コンテキスト浪費を避ける）

型衝突・シグネチャをアドホックに確認したいだけのとき、素の `tsc` を叩くと依存パッケージの型定義由来の **無関係な lib 型エラーを大量にメイン文脈へ流し込み**、コンテキストを浪費する（実データ: drizzle の lib エラー ~23KB を1回の probe で流入）。次を最初から守る（壁を浴びてから絞る、をやめる）:

- **プロジェクトの tsconfig 設定を override しない**。`skipLibCheck: true` 前提のプロジェクトで素の `tsc`（= skipLibCheck 無効相当）を回さない。`npx tsc --noEmit --skipLibCheck -p <tsconfig>` のように設定に準拠させる。lib 全体の型エラーは論点でない。
- **確認したい対象だけに絞る**。出力は対象ファイル/シンボルで grep（例 `... 2>&1 | grep -E "<対象ファイル>|TS<コード>"`）し、無関係ファイルの型エラーを文脈に載せない。
- typecheck script があるパッケージはそれを使う。無いパッケージで一発確認するときも上記2点を適用する。
