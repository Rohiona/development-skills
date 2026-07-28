#!/usr/bin/env bash
# Fail-closed validation for task handoff JSON.
# Usage: validate-handoff.sh HANDOFF.json [--git-dir CWD]
# Exit 0 if valid; exit 1 with message on stderr if not.
set -euo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq)
[ -n "$JQ" ] || { echo "validate-handoff: jq required" >&2; exit 1; }

GIT=/opt/homebrew/bin/git
[ -x "$GIT" ] || GIT=$(command -v git) || GIT=""

GH=/opt/homebrew/bin/gh
[ -x "$GH" ] || GH=$(command -v gh) || GH=""

TIMEOUT=/opt/homebrew/bin/timeout
[ -x "$TIMEOUT" ] || TIMEOUT=$(command -v timeout) || TIMEOUT=$(command -v gtimeout) || TIMEOUT=""

handoff="${1:?usage: validate-handoff.sh HANDOFF.json [--git-dir CWD]}"
git_dir=""
shift
while [ $# -gt 0 ]; do
	case "$1" in
		--git-dir) git_dir="${2:?}"; shift 2 ;;
		*) echo "validate-handoff: unknown arg: $1" >&2; exit 1 ;;
	esac
done

[ -f "$handoff" ] || { echo "validate-handoff: file not found: $handoff" >&2; exit 1; }

fail() { echo "validate-handoff: $*" >&2; exit 1; }

# --- Schema: required keys and types ---
"$JQ" -e '
	def req($k): has($k) and (.[$k] | type) != "null";
	req("schemaVersion") and (.schemaVersion | type == "number") and
	req("topic") and (.topic | type == "string") and req("createdAt") and (.createdAt | type == "string") and
	req("place") and (.place | type == "object") and
	(.place.branch | type == "string") and (.place.worktree | type == "string") and
	(.place.headSha | type == "string") and (.place.prUrl | type == "string") and
	req("goal") and (.goal | type == "string") and req("scope") and (.scope | type == "object") and
	(.scope.do | type == "array") and (.scope.dontDo | type == "array") and
	req("invariantsAdr") and (.invariantsAdr | type == "array") and
	req("summary") and (.summary | type == "string") and
	req("primarySources") and (.primarySources | type == "array") and
	req("doneArtifacts") and (.doneArtifacts | type == "array") and
	req("openQuestions") and (.openQuestions | type == "array") and
	req("envNotes") and (.envNotes | type == "array") and
	req("recommendedSkills") and (.recommendedSkills | type == "array") and
	req("supersedes") and (.supersedes | type == "array") and
	req("staleness") and (.staleness | type == "object") and
	(.staleness.parallelEditors | type == "boolean") and (.staleness.note | type == "string") and
	req("needsCompletion") and (.needsCompletion | type == "boolean") and
	(if has("droppedInvariants") then (.droppedInvariants | type == "array") else true end)
' "$handoff" >/dev/null || fail "schema/type check failed"

# --- place.headSha: hex 7-40 and exists in git ---
head_sha=$("$JQ" -r '.place.headSha' "$handoff")
[[ "$head_sha" =~ ^[0-9a-fA-F]{7,40}$ ]] || fail "place.headSha must be 7-40 hex chars: $head_sha"

if [ -z "$git_dir" ]; then
	git_dir=$("$JQ" -r '.place.worktree // empty' "$handoff")
fi

if [ -n "$GIT" ] && [ -n "$git_dir" ] && [ "$git_dir" != "unknown" ] && \
	"$GIT" -C "$git_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	"$GIT" -C "$git_dir" cat-file -e "${head_sha}^{commit}" 2>/dev/null || \
		fail "place.headSha not found in git: $head_sha (git-dir=$git_dir)"
fi

# --- primarySources: non-empty; explicit none allowed ---
ps_len=$("$JQ" '.primarySources | length' "$handoff")
[ "$ps_len" -gt 0 ] || fail "primarySources must be non-empty"

if [ "$ps_len" -eq 1 ]; then
	url=$("$JQ" -r '.primarySources[0].url // empty' "$handoff")
	note=$("$JQ" -r '.primarySources[0].note // empty' "$handoff")
	if [ "$url" = "none" ] && [ -z "$note" ]; then
		fail 'primarySources [{"url":"none",...}] requires non-empty note with reason'
	fi
fi

"$JQ" -e '.primarySources[] | (.url | type == "string") and (.note | type == "string")' "$handoff" >/dev/null || \
	fail "primarySources entries must have url and note strings"

# --- URL checks (GitHub via gh api; others format-only) ---
check_github_url() {
	local url="$1"
	local api_path=""
	if [[ "$url" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
		api_path="repos/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/pulls/${BASH_REMATCH[3]}"
	elif [[ "$url" =~ github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
		api_path="repos/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/issues/${BASH_REMATCH[3]}"
	elif [[ "$url" =~ github\.com/([^/]+)/([^/]+)/commit/([0-9a-fA-F]+) ]]; then
		api_path="repos/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/commits/${BASH_REMATCH[3]}"
	fi
	[ -n "$api_path" ] || return 0
	if [ -n "$TIMEOUT" ]; then
		"$TIMEOUT" 5 "$GH" api "$api_path" >/dev/null 2>&1 || fail "GitHub URL not reachable via gh api: $url"
	else
		"$GH" api "$api_path" >/dev/null 2>&1 || fail "GitHub URL not reachable via gh api: $url"
	fi
}

while IFS= read -r url; do
	[ -n "$url" ] || continue
	[ "$url" = "none" ] && continue
	case "$url" in
		http://*|https://*) ;;
		*) fail "invalid URL format: $url" ;;
	esac
	case "$url" in
		*github.com*) [ -n "$GH" ] && check_github_url "$url" ;;
	esac
done < <("$JQ" -r '.primarySources[].url' "$handoff")

while IFS= read -r ref; do
	[ -n "$ref" ] || continue
	case "$ref" in
		http://*|https://*)
			case "$ref" in
				*github.com*) [ -n "$GH" ] && check_github_url "$ref" ;;
			esac
			;;
	esac
done < <("$JQ" -r '.doneArtifacts[]?.ref // empty' "$handoff")

# --- supersedes: exist, no self-ref, no cycles (DAG) ---
handoff_abs=$(cd "$(dirname "$handoff")" && pwd)/$(basename "$handoff")
supers_paths=()
while IFS= read -r p; do
	[ -n "$p" ] || continue
	if [ "$p" = "$handoff" ] || [ "$(cd "$(dirname "$p")" 2>/dev/null && pwd)/$(basename "$p")" = "$handoff_abs" ]; then
		fail "supersedes must not include self: $p"
	fi
	[ -f "$p" ] || fail "supersedes path not found: $p"
	supers_paths+=("$p")
done < <("$JQ" -r '.supersedes[]?' "$handoff")

# Cycle detection: follow supersedes edges; revisiting a node on the path => cycle
has_cycle() {
	local f="$1"
	local path="${2:-}"
	local canon child
	canon=$(cd "$(dirname "$f")" && pwd)/$(basename "$f")
	case " $path " in
		*" $canon "*) return 0 ;;
	esac
	path="$path $canon"
	while IFS= read -r child; do
		[ -n "$child" ] || continue
		has_cycle "$child" "$path" && return 0
	done < <("$JQ" -r '.supersedes[]?' "$f" 2>/dev/null)
	return 1
}

has_cycle "$handoff" && fail "supersedes chain contains a cycle"

# --- invariants inheritance from supersedes (exact string match) ---
new_invariants=$("$JQ" -c '[.invariantsAdr[]?]' "$handoff")
dropped_texts=$("$JQ" -c '[.droppedInvariants[]?.text // empty]' "$handoff")

# 空配列の "${arr[@]}" 展開は bash 3.2 + set -u で unbound になるため ${arr[@]+...} でガード。
# 比較は行分割せず jq で文字列全体（改行込み）の完全一致で行う（末尾改行差での誤 fail 防止）。
for old_path in ${supers_paths[@]+"${supers_paths[@]}"}; do
	missing=$("$JQ" -r --slurpfile old "$old_path" '
		[.invariantsAdr[]?] as $ni |
		[.droppedInvariants[]?.text] as $dt |
		[ $old[0].invariantsAdr[]? | select( (. as $t | $ni | index($t)) == null and (. as $t | $dt | index($t)) == null ) ]
		| .[0] // empty' "$handoff")
	if [ -n "$missing" ]; then
		fail "invariant from superseded handoff missing (copy verbatim or add to droppedInvariants): $(printf '%.80s' "$missing")..."
	fi
done

# droppedInvariants must have non-empty reason
"$JQ" -e '
	if has("droppedInvariants") then
		(.droppedInvariants | all(
			(.text | type == "string" and length > 0) and
			(.reason | type == "string" and length > 0)
		))
	else true end
' "$handoff" >/dev/null || fail "droppedInvariants entries need non-empty text and reason"

exit 0
