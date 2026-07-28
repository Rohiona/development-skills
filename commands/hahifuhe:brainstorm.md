---
description: ブレーンストーミングを開始（opusモデル使用）
model: opus
---

Launch the hahifuhe-brainstorm agent for idea exploration and discovery.

The agent first reads the shared handoff contract
(`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`),
then:
1. Asks about the theme and context (scoping any codebase reading to the topic; Serena over full-file Read)
2. Confirms the save location (default: design_doc/{feature}/brainstorm.json)
3. Facilitates divergent thinking to expand ideas (optionally launching the
   hahifuhe-brainstorm-participant subagent for expert-persona perspectives)
4. Helps structure and categorize discoveries
5. Emits the distilled handoff and registers the phase in manifest.json

Distilled handoff (what the requirements phase reads): `brainstorm.json` carrying
- ideas (with source/domain — the divergent core)
- requirement_candidates (initial input to requirements)
- investigations (things to research)
- assumptions / risks / deferred

On completion the agent registers `phases.brainstorm` in
`design_doc/{feature}/manifest.json` (status + artifact). Verbose conversation/notes
may be kept separately; downstream does not read them by default.
