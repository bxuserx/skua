---
id: TKT-XXX
title: "<concise sentence-case title>"
status: "Todo"
priority: "Medium"
assignee: "Claude-Agent"
created: YYYY-MM-DD
domain: "<app | infra | docs | meta>"
complexity: <1-5>   # 1=trivial → 5=xl
secondary_domains: []  # optional; only for cross-cutting tickets
tags:
  - <lowercase-category>
depends_on: []   # optional; ticket IDs this one needs done first (e.g. [TKT-104])
blocks: []       # optional; ticket IDs this one unblocks
related: []      # optional; weak references, no direction
# Files touched — repo-relative paths the agent edited while implementing
# this ticket. Captured by record-files-touched on move to testing /
# complete. Union'd across transitions so late fix-ups in validating still
# get recorded. Empty for tickets that haven't been implemented yet.
files_touched: []
# Per-ticket override for the dashboard hovercard's "Next:" hint. Written
# by ticket-manager skill ops at each lifecycle transition (see SKILL.md
# "Per-ticket next-step hint"). One sentence, ≤140 chars, naming the
# concrete next action for THIS ticket. Empty → falls back to the canonical
# per-bucket sentence in .skua/lib/tickets.ts:nextStepHintFor.
next_step_hint: ""
---

### Objective
<Clear, structural description of what needs to be built, fixed, or changed.
Include the WHY — what user-visible behavior or system property motivates this.>

### Context
<Concrete pointers gathered from the codebase before this ticket was written:
relevant files (file:line), existing patterns to follow or diverge from,
adjacent tickets, ADRs, or memory entries. This section is what makes the
ticket actionable without re-discovery. Omit ONLY if the work is truly
context-free (rare).>

### Acceptance Criteria
- [ ] <Measurable, testable check 1>
- [ ] <Measurable, testable check 2>
- [ ] <…>

### Out of Scope
<Optional. Anything a reader might assume is included but isn't.>

### Notes
<Optional. Open questions, risks, follow-ups.>

### Implementation Summary
<!-- Populated automatically by the ticket-manager skill when this ticket moves to 4-testing.
     Do not fill in manually before implementation is complete. -->
<Empty until the ticket reaches 4-testing.>
