#!/usr/bin/env bash
# token-report.sh — Claude Code の JSONL トランスクリプトからトークン消費を集計する
#
# 使い方:
#   token-report.sh sessions [PROJECT_DIR]      # セッション横断ランキング（重い順）
#   token-report.sh attrib   <SESSION.jsonl>    # 1セッションを MCP/skill 別に分解
#   token-report.sh attrib-all [PROJECT_DIR]    # プロジェクト全体を MCP/skill 別に分解
#
# 前提（重要）:
#   cache_read = そのターン時点のコンテキスト全体の再読込量。特定ツールへの按分は誤解を生むため、
#   ツール別の「増分コスト」は output + cache_creation で評価する。cache_read は参考表示に留める。
#
# 出力トークンが実コストの主要因。cache_read はコンテキスト常駐量の指標（肥大化の検知に使う）。

set -euo pipefail

# 既定はカレントディレクトリに対応する Claude Code プロジェクトディレクトリ
# （~/.claude/projects/ 配下。パスの / と . が - に置換される）。
# 別プロジェクトを集計するときは PROJECT_DIR 引数で明示する。
DEFAULT_DIR="$HOME/.claude/projects/$(pwd | sed 's|[/.]|-|g')"
JQ=$(command -v jq)

cmd="${1:-sessions}"

case "$cmd" in
  sessions)
    dir="${2:-$DEFAULT_DIR}"
    printf '%-40s %10s %12s %14s %14s  %s\n' "SESSION" "OUTPUT" "CACHE_CREATE" "CACHE_READ" "TURNS" "LAST_TS"
    for f in "$dir"/*.jsonl; do
      [ -e "$f" ] || continue
      "$JQ" -rs --arg name "$(basename "$f" .jsonl)" '
        [ .[] | select(.message.usage != null) ] as $rows
        | ($rows | map(.message.usage)) as $u
        | [ $name,
            ($u | map(.output_tokens) | add // 0),
            ($u | map(.cache_creation_input_tokens) | add // 0),
            ($u | map(.cache_read_input_tokens) | add // 0),
            ($u | length),
            ($rows | map(.timestamp) | max // "-") ]
        | @tsv' "$f"
    done | sort -t$'\t' -k2 -rn | \
    while IFS=$'\t' read -r name out cc cr turns ts; do
      printf '%-40s %10s %12s %14s %14s  %s\n' "${name:0:38}" "$out" "$cc" "$cr" "$turns" "$ts"
    done
    ;;

  attrib)
    f="$2"
    echo "=== $f : MCP server / skill 別の増分トークン (output + cache_creation) ==="
    "$JQ" -rs '
      [ .[] | select(.message.usage != null)
        | { key: ( (.attributionSkill // "(no-skill)") + " | " + (.attributionMcpServer // "(no-mcp)") ),
            incr: ((.message.usage.output_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0)),
            out: (.message.usage.output_tokens // 0),
            sidechain: (.isSidechain // false) } ]
      | group_by(.key)
      | map({ key: .[0].key,
              incr: (map(.incr) | add),
              output: (map(.out) | add),
              turns: length })
      | sort_by(-.incr)[]
      | "\(.incr)\t\(.output)\t\(.turns)\t\(.key)"
    ' "$f" | (printf "%12s %12s %6s  %s\n" "INCR_TOK" "OUTPUT" "TURNS" "SKILL | MCP";
              while IFS=$'\t' read -r incr out turns key; do
                printf "%12s %12s %6s  %s\n" "$incr" "$out" "$turns" "$key"; done)
    echo
    echo "=== 本体 vs サブエージェント(sidechain) ==="
    "$JQ" -rs '
      [ .[] | select(.message.usage != null)
        | { side: (if .isSidechain then "sidechain" else "main" end),
            incr: ((.message.usage.output_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0)),
            cr: (.message.usage.cache_read_input_tokens // 0) } ]
      | group_by(.side)
      | map({ side: .[0].side, incr: (map(.incr)|add), cache_read: (map(.cr)|add), turns: length })[]
      | "\(.side)\tincr=\(.incr)\tcache_read=\(.cache_read)\tturns=\(.turns)"
    ' "$f"
    ;;

  attrib-all)
    dir="${2:-$DEFAULT_DIR}"
    "$JQ" -rs '
      [ .[] | select(.message.usage != null)
        | { key: (.attributionMcpServer // "(no-mcp / model itself)"),
            incr: ((.message.usage.output_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0)) } ]
      | group_by(.key)
      | map({ key: .[0].key, incr: (map(.incr)|add), turns: length })
      | sort_by(-.incr)[]
      | "\(.incr)\t\(.turns)\t\(.key)"
    ' "$dir"/*.jsonl | (printf "%12s %6s  %s\n" "INCR_TOK" "TURNS" "MCP_SERVER";
        while IFS=$'\t' read -r incr turns key; do printf "%12s %6s  %s\n" "$incr" "$turns" "$key"; done)
    ;;

  *)
    echo "usage: token-report.sh {sessions|attrib <file>|attrib-all} [dir]" >&2
    exit 1
    ;;
esac
