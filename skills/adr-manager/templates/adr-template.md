---
id: ADR-XXX
title: "<short decision phrase — sentence case, no trailing period>"
status: proposed
created: YYYY-MM-DD
decided: null
deciders:
  - <username>
supersedes: []
superseded_by: null
related_tickets: []
proposed_tickets: []
materialized_tickets: []
tags: []
domain: "<app | infra | docs | meta>"
---

### TL;DR

<2–4 plain-English sentences capturing what was decided and why it matters.
This is the section the dashboard's list view will preview and the section
a non-technical reader skims first.>

### Context

<What's true in the codebase / problem space that makes the decision
necessary. Cite project-internal sources (CLAUDE.md, plans/,
file:line paths). External sources by URL.>

### Decision

<!-- Standardized 4-sub-category structure. Approach +
     Rationale are required; Scope + Reversibility are optional but
     recommended. Each renders as a nested accordion sub-section in the
     dashboard's ADR detail view. Until status transitions to `accepted`,
     the chosen path should be labeled "Suggested" — the human is the gate. -->

#### Approach

<The path taken, in 1–3 sentences.>

#### Rationale

<Why this over the alternatives listed above. Cite tradeoffs.>

#### Scope

<Optional. What this decision covers vs. doesn't cover. Omit if obvious.>

#### Reversibility

<Optional. Format: `easy / medium / hard — one-line reason`. e.g.
"medium — requires a backfill and 2 ticket recompute".>

### Consequences

<What follows from the decision: tickets implied (sketched in
`proposed_tickets[]` frontmatter), conventions established, risks accepted.
Tickets here should align with the `proposed_tickets[]` payload so the
draft graph renders cleanly.>

### Alternatives considered

<What was rejected and why. At least 2, ideally 3 alternatives, each with
pros / cons / rejection rationale. For trivially single-option decisions,
write "None — this is the only viable approach because <reason>".>

### Comments

<!-- Append-only via the dashboard's "+ Add comment" button. Entries are
stamped `**YYYY-MM-DD — <author>:** <text>`. Use for conversational notes,
implementation gotchas, follow-up questions. This is NOT the place for
schema amendments — those go in the Revision Log below. -->

### Revision Log

<!-- Optional living-document footer. Entries appear when post-acceptance
amendments land that don't justify a new superseding ADR. Format:
YYYY-MM-DD — <who> — <one-line amendment>. If the Decision itself changes
(not just elaboration), supersede instead of amending. -->
