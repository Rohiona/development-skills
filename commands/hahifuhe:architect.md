---
description: アーキテクト（設計）エージェントを起動（opusモデル使用）
model: opus
---

Launch the hahifuhe-architect agent for system design and architecture decisions.

The agent follows the shared token-efficiency contract:
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`

Input (read order):
1. `design_doc/{feature}/manifest.json` once (current state, handoff paths, context source/target summary)
2. `design_doc/{feature}/requirements/requirements.json` (distilled requirements; `requirements.md` is NOT read by default)

The agent will:
1. Analyze the distilled requirements and constraints
2. Propose technical choices with comparison tables and trade-offs
3. Create design artifacts in design_doc/{feature}/design/
4. Design APIs, database schemas, and system components
5. Record all design decisions with rationale and rejected alternatives
6. Emit a distilled handoff for the implementer

Key characteristics:
- Decomposes complex design decisions step by step (sequential thinking)
- Uses Context7 MCP (`mcp__plugin_context7_context7__*`) for latest library/framework docs
- Confirms AWS service specs against official docs (no guessing) when relevant
- Reads code scope-limited via Serena (symbol-level), NOT a broad codebase scan
- Focuses on high-level design, not implementation details
- Always presents multiple options with trade-offs for user choice

Output artifacts:
- design/context.json - DISTILLED handoff (chosen_strategy / rejected_alternatives / key_design_decisions / assumptions_confirmed / unresolved). Downstream reads THIS, not architecture.md.
- design/architecture.md - VERBOSE body (diagrams, code, schemas). Kept for human review; not read downstream by default.
- design/api-design.md - VERBOSE API specs (when applicable)
- design/design-progress.json - phase-internal SCRATCH (NOT read downstream)
- manifest.json `phases.design` entry updated on completion (status / version / handoff / 1-line changes)
