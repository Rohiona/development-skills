#!/usr/bin/env bash
# Collect mechanical git/gh facts for task handoff JSON (AI does not write these).
# Usage: collect-facts.sh [cwd]
# Writes JSON to stdout: { "createdAt", "place": { branch, worktree, headSha, prUrl, prHeadSha } }
set -euo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq)
[ -n "$JQ" ] || { echo "collect-facts: jq required" >&2; exit 1; }

GIT=/opt/homebrew/bin/git
[ -x "$GIT" ] || GIT=$(command -v git) || GIT=""

GH=/opt/homebrew/bin/gh
[ -x "$GH" ] || GH=$(command -v gh) || GH=""

TIMEOUT=/opt/homebrew/bin/timeout
[ -x "$TIMEOUT" ] || TIMEOUT=$(command -v timeout) || TIMEOUT=$(command -v gtimeout) || TIMEOUT=""

cwd="${1:-$(pwd)}"
created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

branch=""
worktree=""
head_sha=""
pr_url="none"
pr_head=""

if [ -n "$GIT" ] && "$GIT" -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	branch=$("$GIT" -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
	worktree=$("$GIT" -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "")
	head_sha=$("$GIT" -C "$cwd" rev-parse HEAD 2>/dev/null || echo "")

	if [ -n "$GH" ] && [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
		pr_json=""
		if [ -n "$TIMEOUT" ]; then
			pr_json=$("$TIMEOUT" 5 "$GH" pr view "$branch" --json url,headRefOid 2>/dev/null || true)
		else
			pr_json=$("$GH" pr view "$branch" --json url,headRefOid 2>/dev/null || true)
		fi
		if [ -n "$pr_json" ]; then
			pr_url=$(printf '%s' "$pr_json" | "$JQ" -r '.url // "none"')
			pr_head=$(printf '%s' "$pr_json" | "$JQ" -r '.headRefOid // empty')
		fi
	fi
fi

if [ -n "$pr_head" ]; then
	pr_head_json=$("$JQ" -nc --arg s "$pr_head" '$s')
else
	pr_head_json=null
fi

"$JQ" -nc \
	--arg createdAt "$created_at" \
	--arg branch "${branch:-unknown}" \
	--arg worktree "${worktree:-unknown}" \
	--arg headSha "${head_sha:-unknown}" \
	--arg prUrl "${pr_url:-none}" \
	--argjson prHeadSha "$pr_head_json" \
	'{
		createdAt: $createdAt,
		place: {
			branch: $branch,
			worktree: $worktree,
			headSha: $headSha,
			prUrl: $prUrl,
			prHeadSha: $prHeadSha
		}
	}'
