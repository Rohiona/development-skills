---
description: エントロピーベースの要件定義を開始（opusモデル使用）
model: opus
---

Execute the hahifuhe-requirements playbook (`~/.claude/agents/hahifuhe-requirements.md`) **directly in the main loop** for structured requirements discovery using entropy-based approach.

**Do NOT launch hahifuhe-requirements as a subagent via Task**: the grill loop requires mid-run user dialogue, which subagents cannot do (and nested Task for the researcher is not guaranteed inside a subagent). In non-interactive automation contexts only, run the researcher inline instead of via Task.

Shared contract (token-efficient handoff): `~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

The agent will:
1. Create the distilled handoff `requirements/requirements.json` and the scratch `requirements/process_state.json` in design_doc/{feature}/requirements/
2. Analyze existing code SCOPE-LIMITED to the modules the feature touches (Serena symbol-level reads preferred over full-file Read)
3. Generate prioritized questions (must > should > could) to resolve unknowns; dispatch researchable unknowns to the `hahifuhe-researcher` agent (Task, up to 4 parallel) instead of asking the user
4. Iterate through quality checks (consistency / completeness / coherence / clarity) until convergence — convergence additionally requires every must_have to carry a verified feasibility (Twin Peaks gate, condition 5)
5. Generate the verbose body `requirements/requirements.md` (downstream does NOT read it by default) and update the feature-root `manifest.json` requirements entry (status / version / handoff)
