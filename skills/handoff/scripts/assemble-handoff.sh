#!/usr/bin/env bash
# Assemble task handoff JSON from mechanical facts + AI-written md fragment files.
# Usage:
#   assemble-handoff.sh --topic TOPIC --facts FACTS.json --workdir DIR --output OUT.json \
#     [--supersedes PATH...] [--needs-completion]
#
# Workdir layout (AI-written prose — never embed JSON by hand):
#   goal.md, summary.md
#   scope-do.txt, scope-dont.txt          (one item per line; file may be absent/empty)
#   invariants/*.md                       (sorted glob; verbatim from prior handoff when superseding)
#   primary-sources.json                  ([{url, note}, ...])
#   done-artifacts.json                   ([{kind, ref, note}, ...])
#   open-questions.txt, env-notes.txt, recommended-skills.txt
#   dropped-invariants.json               (optional: [{text, reason}, ...] when superseding)
#   parallel-editors.flag                 (optional: sets staleness.parallelEditors=true)
#   staleness-note.txt                    (optional)
set -euo pipefail

JQ=/opt/homebrew/bin/jq
[ -x "$JQ" ] || JQ=$(command -v jq)
[ -n "$JQ" ] || { echo "assemble-handoff: jq required" >&2; exit 1; }

topic=""
facts=""
workdir=""
output=""
needs_completion=false
supersedes=()

while [ $# -gt 0 ]; do
	case "$1" in
		--topic) topic="${2:?}"; shift 2 ;;
		--facts) facts="${2:?}"; shift 2 ;;
		--workdir) workdir="${2:?}"; shift 2 ;;
		--output) output="${2:?}"; shift 2 ;;
		--needs-completion) needs_completion=true; shift ;;
		--supersedes) supersedes+=("${2:?}"); shift 2 ;;
		*) echo "assemble-handoff: unknown arg: $1" >&2; exit 1 ;;
	esac
done

[ -n "$topic" ] && [ -n "$facts" ] && [ -n "$workdir" ] && [ -n "$output" ] || {
	echo "assemble-handoff: --topic --facts --workdir --output are required" >&2
	exit 1
}
[ -f "$facts" ] || { echo "assemble-handoff: facts not found: $facts" >&2; exit 1; }
[ -d "$workdir" ] || { echo "assemble-handoff: workdir not found: $workdir" >&2; exit 1; }

read_file() {
	local f="$1"
	[ -f "$f" ] && cat "$f" || echo ""
}

lines_to_json_array() {
	local f="$1"
	if [ ! -f "$f" ]; then
		"$JQ" -nc '[]'
		return
	fi
	"$JQ" -Rsc 'split("\n") | map(select(length > 0))' "$f"
}

read_json_or_empty_array() {
	local f="$1"
	if [ -f "$f" ]; then
		"$JQ" -c '.' "$f"
	else
		echo '[]'
	fi
}

goal=$(read_file "$workdir/goal.md")
summary=$(read_file "$workdir/summary.md")
scope_do=$(lines_to_json_array "$workdir/scope-do.txt")
scope_dont=$(lines_to_json_array "$workdir/scope-dont.txt")
open_questions=$(lines_to_json_array "$workdir/open-questions.txt")
env_notes=$(lines_to_json_array "$workdir/env-notes.txt")
recommended_skills=$(lines_to_json_array "$workdir/recommended-skills.txt")
primary_sources=$(read_json_or_empty_array "$workdir/primary-sources.json")
done_artifacts=$(read_json_or_empty_array "$workdir/done-artifacts.json")
dropped_invariants=$(read_json_or_empty_array "$workdir/dropped-invariants.json")

# invariants/*.md -> JSON array of strings (order preserved)
invariants_json='[]'
if compgen -G "$workdir/invariants/"*.md >/dev/null 2>&1; then
	invariants_json=$(
		{
			for inv in "$workdir/invariants/"*.md; do
				[ -f "$inv" ] || continue
				"$JQ" -Rs '.' "$inv"
			done
		} | "$JQ" -sc '.'
	)
fi

parallel_editors=false
[ -f "$workdir/parallel-editors.flag" ] && parallel_editors=true
staleness_note=$(read_file "$workdir/staleness-note.txt")

created_at=$("$JQ" -r '.createdAt' "$facts")
place=$("$JQ" -c '.place' "$facts")

supersedes_json='[]'
if [ "${#supersedes[@]}" -gt 0 ]; then
	supersedes_json=$("$JQ" -nc --args '$ARGS.positional' -- "${supersedes[@]}")
fi

needs_json=$([ "$needs_completion" = true ] && echo true || echo false)
parallel_json=$([ "$parallel_editors" = true ] && echo true || echo false)

mkdir -p "$(dirname "$output")"

jq_prog='{
	schemaVersion: 1,
	topic: $topic,
	createdAt: $createdAt,
	place: $place,
	goal: $goal,
	scope: { do: $scopeDo, dontDo: $scopeDont },
	invariantsAdr: $invariantsAdr,
	summary: $summary,
	primarySources: $primarySources,
	doneArtifacts: $doneArtifacts,
	openQuestions: $openQuestions,
	envNotes: $envNotes,
	recommendedSkills: $recommendedSkills,
	supersedes: $supersedes,
	staleness: { parallelEditors: $parallelEditors, note: $stalenessNote },
	needsCompletion: $needsCompletion
} + (if ($droppedInvariants | length) > 0 then { droppedInvariants: $droppedInvariants } else {} end)'

"$JQ" -nc \
	--arg topic "$topic" \
	--arg createdAt "$created_at" \
	--argjson place "$place" \
	--arg goal "$goal" \
	--argjson scopeDo "$scope_do" \
	--argjson scopeDont "$scope_dont" \
	--argjson invariantsAdr "$invariants_json" \
	--arg summary "$summary" \
	--argjson primarySources "$primary_sources" \
	--argjson doneArtifacts "$done_artifacts" \
	--argjson openQuestions "$open_questions" \
	--argjson envNotes "$env_notes" \
	--argjson recommendedSkills "$recommended_skills" \
	--argjson supersedes "$supersedes_json" \
	--argjson parallelEditors "$parallel_json" \
	--arg stalenessNote "$staleness_note" \
	--argjson needsCompletion "$needs_json" \
	--argjson droppedInvariants "$dropped_invariants" \
	"$jq_prog" \
	> "$output"

printf '%s\n' "$output"
