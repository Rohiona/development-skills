#!/bin/bash
# serena-loader.sh
# Grep/Glob/Read でコードファイル (.ts/.tsx/.js/.jsx) を触ろうとしたとき、
# Serena/LSP を先に使うようリマインドする。
# PreToolUse hook として動作。該当時は exit 2 でブロックする。

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# ---- Grep / Glob: 既存ロジック ----
is_code_search() {
  local input="$1"

  # Grep: type パラメータ（ts, js 等）
  local type
  type=$(echo "$input" | jq -r '.tool_input.type // empty')
  if [[ "$type" =~ ^(ts|tsx|js|jsx|typescript)$ ]]; then
    return 0
  fi

  # Grep: glob パラメータ（*.tsx 等）
  local glob_param
  glob_param=$(echo "$input" | jq -r '.tool_input.glob // empty')
  if [[ -n "$glob_param" ]]; then
    if [[ "$glob_param" =~ \.(tsx|jsx) ]] || \
       { [[ "$glob_param" =~ \.(ts|js) ]] && [[ ! "$glob_param" =~ \.(json|jsonl|jsonc) ]]; }; then
      return 0
    fi
  fi

  # Glob: pattern パラメータ（**/*.ts 等）
  local pattern
  pattern=$(echo "$input" | jq -r '.tool_input.pattern // empty')
  if [[ -n "$pattern" ]]; then
    if [[ "$pattern" =~ \.(tsx|jsx) ]] || \
       { [[ "$pattern" =~ \.(ts|js) ]] && [[ ! "$pattern" =~ \.(json|jsonl|jsonc) ]]; }; then
      return 0
    fi
  fi

  return 1
}

# ---- Read: コードファイル全体読みをブロック ----
# 範囲指定 (offset または limit) があれば許可。シンボル位置特定後のピンポイント読み用に逃げ道を残す。
is_full_code_read() {
  local input="$1"

  local file_path
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
  if [[ -z "$file_path" ]]; then
    return 1
  fi

  # 拡張子チェック: .ts/.tsx/.js/.jsx のみ。.json 系は除外。
  if [[ "$file_path" =~ \.(tsx|jsx)$ ]]; then
    :
  elif [[ "$file_path" =~ \.(ts|js)$ ]] && [[ ! "$file_path" =~ \.(json|jsonl|jsonc)$ ]]; then
    :
  else
    return 1
  fi

  # offset または limit が指定されていれば許可
  local offset limit
  offset=$(echo "$input" | jq -r '.tool_input.offset // empty')
  limit=$(echo "$input" | jq -r '.tool_input.limit // empty')
  if [[ -n "$offset" ]] || [[ -n "$limit" ]]; then
    return 1
  fi

  return 0
}

if [[ "$TOOL_NAME" == "Read" ]]; then
  if is_full_code_read "$INPUT"; then
    cat <<'MSG'
[Serena First] コードファイル (.ts/.tsx/.js/.jsx) の全体読みはブロックされました。
Serena でシンボル単位に読むか、Read に offset/limit を付けて範囲を絞ってください。

推奨手順:
1. ToolSearch("select:mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__find_referencing_symbols,mcp__plugin_serena_serena__search_for_pattern") でスキーマ取得
2. get_symbols_overview でファイル構造を把握 → find_symbol で必要なシンボルだけ取得
3. 型/コールグラフが論点なら LSP (hover / incomingCalls / goToImplementation / findReferences) に切り替え
4. どうしても広く読みたい時のみ Read に offset+limit を付けて再実行（逃げ道）
MSG
    exit 2
  fi
  exit 0
fi

# Grep / Glob 系
if is_code_search "$INPUT"; then
  cat <<'MSG'
[Serena First] コードファイルの探索には Serena を使用してください。Grep/Glob はブロックされました。

手順:
1. ToolSearch("select:mcp__plugin_serena_serena__find_symbol,mcp__plugin_serena_serena__get_symbols_overview,mcp__plugin_serena_serena__search_for_pattern,mcp__plugin_serena_serena__find_file,mcp__plugin_serena_serena__list_dir") でスキーマを読み込む
2. 適切な Serena ツールを使う:
   - search_for_pattern → テキスト/正規表現パターン検索（Grep の代替）
   - find_symbol → シンボル（関数・クラス・型）の定義検索
   - get_symbols_overview → ファイル内のシンボル一覧
   - find_file → ファイル名検索（Glob の代替）
   - find_referencing_symbols → シンボルの参照元検索
MSG
  exit 2
fi

exit 0
