# Draft Ticket Template

For every NEW P0 finding (per the snapshot diff), the orchestrator emits a draft ticket body matching this template. The user reviews and files via `ticket-manager create-ticket` — the orchestrator does NOT auto-file.

## Why draft, not auto-file

- The same finding might surface across multiple runs before the user has time to file (flapping noise → auto-file would create duplicate tickets).
- Some "NEW" findings are noise (calibration drift, new check just added) — user judgment is required.
- Ticket-manager has its own ID-assignment + linking semantics; auto-invocation bypasses its dedup logic.

## Template

```markdown
---
id: TKT-XXX  # ticket-manager assigns next available
title: "<severity-tag> <one-line finding title>"
status: "Todo"
priority: "High"  # P0 finding → priority: High
assignee: "Claude-Agent"  # or "User" if requires human judgment
created: <today's date>
domain: <app | infra | docs | meta>  # inferred from the finding's resource path
tags:
  - security
  - bug
  - <other category from finding>
depends_on: []
blocks: []
related: [<any tickets this finding cross-references>]
files_touched: []
---

### Objective

<One-paragraph description of the finding. Lead with the user-visible risk, then the technical surface. E.g.: "An authenticated user can write a trust-bearing field (e.g. an entitlement flag) directly to their own record in the datastore, bypassing the server-side check in the auth layer and gaining access they should not have. Tightening this requires either field-level write rules in the datastore or moving the trusted state to a server-only store.">

### Context

Surfaced by `/security` on <date> — see merged report.

**Source 1:** `<cite>` — <detail>
**Source 2:** `<cite>` — <detail>
(only if multiple cites dedup'd into one finding)

**CWE:** CWE-NNN — <name>
**OWASP:** <category>
**CVSS:** <vector + score, if known>

**Persistence:** First surfaced <first_surfaced date> (N days open).

**Cross-references:**
- Related ticket: TKT-NNN
- Memory: <relevant memory entry>
- ADR: <relevant ADR>

### Acceptance Criteria

- [ ] <Specific, testable check 1 — usually "the fix sketch above"
- [ ] Re-run `/security` — finding is RESOLVED in next snapshot diff.
- [ ] If fix introduces user-visible behavior change, document in CHANGELOG or release notes.
- [ ] If the fix requires a data backfill (e.g. existing records that already hold the self-elevated value), file a separate remediation ticket.

### Out of Scope

- <Adjacent issues this ticket explicitly does NOT solve>
- <Other findings from the same audit run that are separate work>

### Notes

- Auto-drafted by `/security` orchestrator. Review the finding's source cites + suggested-fix before accepting the framing — orchestrator output is starting material, not final spec.
- If the finding is actually a false positive, add a suppression (with a mandatory expiry) to `.claude/skills/security/suppressions.yaml`.

### Implementation Summary
<!-- Populated automatically by the ticket-manager skill when this ticket moves to 4-testing.
     Do not fill in manually before implementation is complete. -->
<Empty until the ticket reaches 4-testing.>
```

## How to populate

For each NEW P0 finding:

1. **Title:** `<severity-tag> <short-title from finding>` — example: `[P0] Missing object-level authorization on the order-lookup handler`.
2. **Domain:** infer from the finding's resource path:
   - application / source code → `app`
   - deploy / config / infrastructure files → `infra`
   - Multi-cite → use whichever cite is closer to the fix surface.
3. **Tags:** always `security`, plus `bug` for P0 findings, plus a category tag from the finding (e.g. the vulnerability class — `xss`, `injection`, `authz`).
4. **Related:** include any tickets the finding cross-references.
5. **CVSS / CWE / OWASP:** copy verbatim from the orchestrator's merged finding.
6. **Suggested fix → Acceptance Criteria:** convert the orchestrator's one-line fix sketch into bullet-form testable checks.

## What the orchestrator does NOT do

- Compute next ticket ID (ticket-manager owns that).
- Set `depends_on` / `blocks` (the orchestrator can guess `related:` but ordering is a human call).
- Write to `.tickets/0-backlog/` — user files via `ticket-manager create-ticket`.

## Future enhancement (not built today)

If/when the `.skua/` dashboard adds a "promote draft to ticket" UI, the orchestrator could write draft files to `.tickets/scratch/` instead of inlining in the report. For now, inline emit is simpler and keeps the user in control.
