---
description: 要件書の批判的レビューを開始（opusモデル使用）
model: opus
---

Launch the hahifuhe-reviewer agent specifically for requirements document review.

The agent reads `manifest.json` first, then `requirements/requirements.json` (the distilled requirements handoff: `functional_requirements` / `acceptance_criteria` / `nfr` / `scope` / `assumptions`). It opens the verbose `requirements.md` only for the specific section a concern needs deeper context. Shared contract: `skills/autonomous-dev/references/token-efficient-handoff.md`.

Evaluation focuses on:

## Evaluation Criteria

### Functional Requirements
- ✅/⚠️/❌ Completeness (no gaps, duplicates, contradictions)
- ✅/⚠️/❌ Clarity (implementers won't be confused)
- ✅/⚠️/❌ Testability (acceptance criteria are clear)
- ✅/⚠️/❌ User Value (business value is evident)

### Non-Functional Requirements
- ✅/⚠️/❌ Performance (external API rate limits considered)
- ✅/⚠️/❌ Scalability (data volume growth handled)
- ✅/⚠️/❌ Security (auth, data protection)
- ✅/⚠️/❌ Availability (SLA, disaster recovery)
- ✅/⚠️/❌ Maintainability (testability)

### Project Specific
- ✅/⚠️/❌ Consistency with existing systems (existing services/modules)
- ✅/⚠️/❌ Tech stack alignment
- ✅/⚠️/❌ Cost estimation

### Risk Assessment
- ✅/⚠️/❌ Technical risks identified
- ✅/⚠️/❌ Business risks identified
- ✅/⚠️/❌ Dependency risks identified

## Verification Tools (when needed)
- context7: Latest technology information
- AWS docs: AWS service constraints
- Open verbose `requirements.md` section only when `requirements/requirements.json` lacks the grounding for a concern

## Output
- `reviews/critical-review-requirements-{date}.md`

## After Review
- High Priority concerns → `/hahifuhe:requirements` for revision
- Discuss findings → `/hahifuhe:discuss-review`
- No concerns → `/hahifuhe:architect` for design phase
