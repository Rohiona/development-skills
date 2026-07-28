---
description: 実装レビュー（Implementation Review）を開始（opusモデル使用）
model: opus
---

Launch the hahifuhe-implementation-reviewer agent for code quality review of implementation.

The agent will:
1. **Phase 1 - Context Understanding**: Read `manifest.json`, then the distilled handoffs (`requirements/requirements.json`, `design/context.json`, `implementation/context.json`) + `git diff`. Open verbose bodies only for the specific section a finding needs. Shared contract: `skills/autonomous-dev/references/token-efficient-handoff.md`.
2. **Phase 2 - Review Planning**: Plan review scoped to the impacted packages, divide into groups, save as JSON
3. **Phase 3 - Review Execution**: Review each group systematically (Data/API/Logic/Integration layers), Serena symbol-level reads preferred
4. **Phase 4 - Result Aggregation**: Merge findings, calculate severity counts
5. **Phase 5 - Report Generation**: Create Markdown report with executive summary and recommendations

Key characteristics:
- Reads distilled handoffs + diff by default; verbose bodies only when a finding needs it (no double-reading)
- Uses context7 for library/framework best practices, AWS docs for AWS service constraints
- Structured output: JSON for data, Markdown for human-readable report
- Severity classification: Critical/Major/Minor/Info
- Requirement alignment: Checks against FR/AC/NFR
- GO/NO-GO gate: release-ready (GO) requires **Critical = 0 AND Major = 0**; one half of the double gate alongside the machine gate (type/lint/test)

Review focus areas:
- **Requirement**: FR/AC/NFR alignment
- **Security**: Multi-tenant boundaries, auth/authz
- **Quality**: TypeScript best practices, error handling, logging
- **Performance**: Index design, query efficiency
- **Test**: Coverage, critical path testing

Output artifacts:
- `reviews/review-plan-{YYYYMMDD}.json` - Structured review plan and findings
- `reviews/implementation-review-{YYYYMMDD}.md` - Final report

After review:
- Critical/Major findings → `/hahifuhe:implementer` for fixes
- Discuss findings → `/hahifuhe:discuss-review`
- No major issues → Proceed to CDK review or release preparation

Usage example:
```
/hahifuhe:implementation-review

対象: event-dispatch
スコープ: CDKを除く実装コード
```
