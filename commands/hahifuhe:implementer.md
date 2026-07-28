---
description: インプリメンター（実装）エージェントを起動（opusモデル使用）
model: opus
---

Launch the hahifuhe-implementer agent for implementation design and coding.

Shared contract (token-efficient handoff): the agent follows
`~/.claude/skills/autonomous-dev/references/token-efficient-handoff.md`.

The agent will:
1. Read `manifest.json`, then the distilled handoffs `design/context.json`
   (chosen_strategy / key_design_decisions) and `task-split/tasks.json` — NOT the
   verbose `design/architecture.md` by default (open a DD-id section only when needed)
2. Create implementation design (class/function structure)
3. Plan test strategy (unit tests, integration tests)
4. Write code per task, pairing each implementation step with its unit tests
5. Run tests to verify; keep immutability / clean-code discipline
6. Emit `implementation/context.json` (contract §3.4) and update `manifest.json`
7. Report progress and any issues encountered

Key characteristics:
- Uses Sequential Thinking MCP for complex implementation design
- Uses Context7 MCP for latest library/framework documentation
- Follows architect's high-level design decisions (via design/context.json DD-ids)
- Scopes code reads to impacted packages; prefers Serena symbol-level reads over full-file Read
- Responsible for detailed implementation design (class/function level)
- Escalates to architect when design changes are needed
- Follows existing coding standards and patterns

Coding standards:
- TypeScript: No `any`, prefer `interface`, explicit types
- Immutability: never mutate; return new copies. Functions <50 lines, files <800
- Error handling: Custom error classes, no sensitive data in logs
- Testing: 80%+ coverage for business logic, mock external services

Distilled output (for review phase to consume with diff):
- `implementation/context.json`: decisions[{id,area,decision,rationale,alternatives_rejected}],
  address_items, unresolved, pr_readiness, test_results
- `manifest.json` implementation entry (status / handoff) and current_phase / next_action

Escalation triggers:
- API specification changes needed
- Database schema changes needed
- New library/service introduction needed
- Architecture-level changes needed
