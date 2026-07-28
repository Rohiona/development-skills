---
description: 批判的レビュー（Critical Review）を開始（opusモデル使用）
model: opus
---

Launch the hahifuhe-reviewer agent for critical review of requirements or design documents.

The agent will:
1. Read `manifest.json` first, then the distilled handoff (`requirements/requirements.json` or `design/context.json`). Open the verbose body (`requirements.md` / `architecture.md`) only for the specific section a concern needs deeper context. See the shared contract: `skills/autonomous-dev/references/token-efficient-handoff.md`.
2. Analyze related existing code, scoped to the impacted packages (prefer Serena symbol-level reads over full-file Read)
3. Evaluate against multiple criteria (functional, non-functional, technical, business, risk)
4. Use context7 / AWS docs for external verification when needed
5. Create structured review report with prioritized concerns (High/Medium/Low)
6. Propose discussion session for review findings

Key characteristics:
- Reads distilled handoffs + diff by default; verbose bodies only when a finding needs it (no double-reading)
- Uses context7 for latest technology best practices, AWS docs for AWS service constraints
- Constructive criticism only - no nitpicking
- Always provides improvement suggestions with concerns
- Balances strengths and concerns in evaluation

Output artifacts:
- `reviews/critical-review-requirements-{date}.md` - Requirements review report
- `reviews/critical-review-architecture-{date}.md` - Architecture review report

Review focus:
- Requirements: Completeness, clarity, testability, user value
- Architecture: Feasibility, scalability, security, cost, migration

After review:
- Proposes `/hahifuhe:discuss-review` for discussing findings
- High Priority concerns → back to requirements/architect phase
- No concerns → proceed to implementation
