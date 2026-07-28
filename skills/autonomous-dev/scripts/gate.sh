#!/usr/bin/env bash
# gate.sh — autonomous-dev の客観ゲート実行器（pnpm + Turbo モノレポ向け）
#
# 「ビルドコマンドを毎回推測する」アンチパターンを構造的に排除する。ゲート名を渡せば
# プロジェクトの正しいコマンドを実行し、緑/赤の判定 JSON を最終行に出す。
#
# Usage:
#   gate.sh build              -> pnpm build            (Turbo; build スクリプトを持つパッケージのみ)
#   gate.sh typecheck <pkg>    -> pnpm --filter <pkg> exec tsc --noEmit  (source-only パッケージの型検査)
#   gate.sh check              -> pnpm check            (Biome lint+format)
#   gate.sh test <pkg>         -> pnpm --filter <pkg> run --if-present test
#   gate.sh all --files <f...> -> 変更ファイル→影響パッケージを解決し、pkg ごと typecheck+test ＋
#                                 repo 全体 check を一括実行。単一 JSON サマリを最終行に出す:
#                                 {"gate":"all","green":bool,"gates":{...},"error_signatures":[...]}
#                                 error_signatures は「同一エラー再発検知」用の正規化済みエラー行。
#
# 注意: server-core 等 build スクリプトの無いパッケージは build では型検査されない。
#       その場合は typecheck <pkg> を使う（ライブ試走 iter-1 で判明）。
#
# 出力: 最終行に 1 行 JSON。終了コード: 0 = green。
# 環境変数 AUTODEV_REPO で repo ルートを上書き可（既定: git toplevel）。
set -uo pipefail

GATE="${1:-}"
shift 2>/dev/null || true
REPO_ROOT="${AUTODEV_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%s)"

emit() { # gate pkg green exit log errors
  printf '{"gate":"%s","pkg":"%s","green":%s,"exit":%d,"log":"%s","errors":%s}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6"
}

count_errors() { # log_file -> count
  local n=0
  [ -f "$1" ] && n=$(command grep -cE "error TS[0-9]+|✘|✖|FAIL|Error:" "$1" 2>/dev/null || true)
  echo "${n:-0}"
}

run_single() { # gate pkg -> emits JSON line, returns exit
  local gate="$1" pkg="${2:-}" log exit_code
  log="${TMPDIR:-/tmp}/autodev-gate-${gate}-${pkg//\//_}-${TS}.log"
  case "$gate" in
    build)     pnpm build >"$log" 2>&1 ;;
    check)     pnpm check >"$log" 2>&1 ;;
    typecheck) pnpm --filter "$pkg" exec tsc --noEmit >"$log" 2>&1 ;;
    test)      pnpm --filter "$pkg" run --if-present test >"$log" 2>&1 ;;
    *)         emit "$gate" "$pkg" false 2 "" 0; return 2 ;;
  esac
  exit_code=$?
  local green=false; [ "$exit_code" -eq 0 ] && green=true
  emit "$gate" "$pkg" "$green" "$exit_code" "$log" "$(count_errors "$log")"
  return "$exit_code"
}

cd "$REPO_ROOT" 2>/dev/null || { emit "${GATE:-none}" "" false 1 "" 0; exit 1; }

case "$GATE" in
	build|check)
		run_single "$GATE"; exit $? ;;
	typecheck|test)
		PKG="${1:-}"
		if [ -z "$PKG" ]; then
			emit "$GATE" "" false 2 "" 0
			echo "ERROR: gate.sh $GATE <pkg> — pkg 必須" >&2
			exit 2
		fi
		run_single "$GATE" "$PKG"; exit $? ;;
	all)
		command -v jq >/dev/null 2>&1 || { echo "ERROR: gate.sh all は jq が必要" >&2; exit 3; }
		[ "${1:-}" = "--files" ] || { echo "ERROR: gate.sh all --files <f...> の形式で呼ぶ" >&2; exit 2; }
		shift
		FILES=("$@")
		PKGS=()
		if [ "${#FILES[@]}" -gt 0 ]; then
			while IFS= read -r p; do [ -n "$p" ] && PKGS+=("$p"); done \
				< <(bash "$SCRIPT_DIR/impacted-packages.sh" --files "${FILES[@]}")
		fi
		GATES_JSON="{}"
		ALL_GREEN=true
		add_gate() { # name json
			GATES_JSON=$(jq -c --arg n "$1" --argjson g "$2" '.[$n] = $g' <<<"$GATES_JSON")
			[ "$(jq -r '.green' <<<"$2")" = "true" ] || ALL_GREEN=false
		}
		for pkg in ${PKGS[@]+"${PKGS[@]}"}; do
			J="$(run_single typecheck "$pkg" | tail -n 1)"; add_gate "typecheck:$pkg" "$J"
			J="$(run_single test "$pkg" | tail -n 1)";      add_gate "test:$pkg" "$J"
		done
		J="$(run_single check | tail -n 1)"; add_gate "check" "$J"
		# error_signatures: 赤ゲートのログから正規化済みエラー行を収集（同一エラー再発検知用）
		SIGS="[]"
		while IFS= read -r logf; do
			[ -n "$logf" ] && [ -f "$logf" ] || continue
			while IFS= read -r line; do
				SIGS=$(jq -c --arg s "$line" '. + [$s]' <<<"$SIGS")
			done < <(command grep -E "error TS[0-9]+|✘|✖|FAIL|Error:" "$logf" 2>/dev/null \
				| sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | sort -u | head -40)
		done < <(jq -r '.[] | select(.green == false) | .log' <<<"$GATES_JSON")
		SIGS=$(jq -c 'unique | .[0:80]' <<<"$SIGS")
		jq -nc --argjson gates "$GATES_JSON" --argjson sigs "$SIGS" --argjson green "$ALL_GREEN" \
			'{gate:"all", green:$green, gates:$gates, error_signatures:$sigs}'
		$ALL_GREEN && exit 0 || exit 1 ;;
	*)
		emit "${GATE:-none}" "" false 2 "" 0
		echo "ERROR: unknown gate '$GATE' (use: build | typecheck <pkg> | check | test <pkg> | all --files <f...>)" >&2
		exit 2 ;;
esac
