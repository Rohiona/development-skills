---
description: 設計書の批判的レビューを開始（opusモデル使用）
model: opus
---

Launch the hahifuhe-reviewer agent specifically for architecture/design document review.

The agent reads `manifest.json` first, then `design/context.json` (the distilled design handoff: `chosen_strategy` / `key_design_decisions` / `rejected_alternatives` / `unresolved`). It opens the verbose body (`architecture.md` / `api-design.md`) only for the specific DD-id a concern needs deeper context. Shared contract: `skills/autonomous-dev/references/token-efficient-handoff.md`. Related code reads are scoped to impacted packages (Serena symbol-level preferred).

Evaluation focuses on the design decisions captured in `design/context.json`:

## Evaluation Criteria

### Technical Feasibility
- ✅/⚠️/❌ Implementable with current tech stack
- ✅/⚠️/❌ Architecture soundness (extensibility, maintainability)
- ✅/⚠️/❌ Technology selection rationale (trade-offs considered)

### Non-Functional Requirements Realization
- ✅/⚠️/❌ Performance approach
- ✅/⚠️/❌ Security measures
- ✅/⚠️/❌ Availability strategy

### Data & API Design
- ✅/⚠️/❌ Data model consistency and scalability
- ✅/⚠️/❌ API design consistency and error handling
- ✅/⚠️/❌ Project API conventions compliance (RPC/REST)

### Project Specific
- ✅/⚠️/❌ Microservice dependencies (existing services)
- ✅/⚠️/❌ Datastore (RDB/NoSQL) characteristics utilized
- ✅/⚠️/❌ AWS CDK best practices (CDK Nag compliance)

### Business & Risk
- ✅/⚠️/❌ Cost estimation validity
- ✅/⚠️/❌ Implementation timeline realistic
- ✅/⚠️/❌ Migration plan (existing system transition)
- ✅/⚠️/❌ Technical/business/dependency risks identified

## Verification Tools (when needed)
- context7: Latest framework/library documentation
- AWS docs: AWS service limits, costs, best practices, CDK Nag rules
- Open verbose `architecture.md` section only when `design/context.json` lacks the grounding for a concern

## Output
- `reviews/critical-review-architecture-{date}.md`

## After Review
- High Priority concerns → `/hahifuhe:architect` for revision
- Discuss findings → `/hahifuhe:discuss-review`
- No concerns → `/hahifuhe:implementer` for implementation
