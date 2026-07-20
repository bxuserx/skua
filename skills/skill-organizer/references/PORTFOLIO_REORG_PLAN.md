# Portfolio Reorganization Plan

Living document. Each `## Run YYYY-MM-DD` section is one full
`generate-reorg-plan` invocation. Earlier sections are NOT overwritten —
append new sections at the top so the most recent run is first.

The runs below are a **generic worked example** of the plan shape. They use
hypothetical and shipping skill names to illustrate what a real reorg plan
looks like (clusters, rename rows, no-op verdicts, findings); they are not a
record of this repo's actual history.

---

## Run YYYY-MM-DD (edge taxonomy + router-over-review)

**Driven by:** the skills graph "looks like a hairball" because every
`connects_to` edge rendered the same regardless of whether it was a canonical
parent relationship or a cross-cluster handoff.

**Verdict summary:** 0 P0 · 0 P1 · 1 P2 (graph topology cleanup, executed
in-flow).

### Plan A — edge taxonomy (`parent` / `handoff`)

`connects_to:` items now accept either a bare slug (legacy = `handoff`) or a
typed `kind:slug` string. Two sanctioned kinds:

- **`parent:`** — A is B's canonical entry point. Each target gets exactly one
  parent edge across the whole portfolio (multi-parent emits a `multi-parent`
  graph warning).
- **`handoff:`** — A invokes/recommends B but doesn't own it (cross-cluster
  invocations, shared leaf primitives).

A third `cite:` kind was prototyped during the run but dropped — pure prose
"see also" pointers should go in skill body text, not in `connects_to`.

### Plan B — a router becomes the entry point for a synthesizer

A hypothetical `backend-router` gains `parent:backend-review` and a routing
rule: "audit everything / full review" → the synthesizer. This collapses the
visible story: one entry point for backend work, the synthesizer is one of its
children (router-over-synthesizer).

### Edge annotations applied

| Skill | parent edges added |
|---|---|
| a `<family>-router` | `<family>-frontend`, `<family>-backend`, `<family>-cloud` |
| a `backend-router` | its leaf audits + `backend-review` |
| a `<domain>-router` | its `<domain>-*` leaves (a shared `<layer>-data-model` stays `handoff`) |

Post-build: a clean forest of entry points under the parent-only filter; the
full view still shows all edges for cross-cutting context.

### Next-run guidance

- New skills MUST pick the right edge kind on each outgoing edge.
  `skill-builder.create-skill` should call `skill-organizer.audit-edges`.
- When a cluster reaches ≥3 dedicated members, evaluate
  `propose-orchestrator-wrap` against it.

---

## Run YYYY-MM-DD (naming convention + renames)

**Driven by:** the high-level skill graph "looks messy" because suffix usage
is inconsistent (`-orchestrator`, `-review`, `-research` all used
interchangeably for `kind: orchestrator` skills).

**Verdict summary:** 0 P0 · 1 P1 (naming-convention drift across the
high-level skills) · 0 P2.

### Convention introduced

New canonical doc: `${CLAUDE_SKILL_DIR}/references/NAMING_CONVENTION.md`. Three
sanctioned shapes for `kind: orchestrator` skills: `*-router` (intent router),
`*-review` (one-shot synthesizer), and a plain domain noun (single canonical
entry point). Grandfathered: `skill-organizer`, `ticket-manager`,
`adr-manager`. Disallowed suffix `-orchestrator` (redundant with
`kind: orchestrator`).

### Renames executed

| Old slug | New slug | Shape inferred | Why |
|---|---|---|---|
| a `<domain>-orchestrator` | a `<domain>-router` | router | Body dominated by a routing table. |
| an `<infra>-orchestrator` | an `<infra>-router` | router | Pure routing-only, no own work. |

### Op added to `skill-organizer`

New `audit-naming` op. Walks `kind: orchestrator` skills; flags any whose
suffix is not `-router` / `-review` (or grandfathered). Hands proposals to
`propose-rename`.

### Sweep cost (one-time)

- Inbound `connects_to` edges rewritten to the new slugs.
- Sibling SKILL.md bodies / references edited to point at the new names.
- Historical record (completed tickets, retired tombstones) left intact with
  the old names.

### Next-run guidance

- Future `kind: orchestrator` skills MUST be checked by `audit-naming` at
  scaffold time.

---

## Run YYYY-MM-DD (first run)

**Driven by:** first run of `skill-organizer` on the portfolio.
**Verdict summary:** 0 P0 · 0 P1 · several P2 (mostly intentional). 1 child
ticket filed.

### Cluster recommendations

| Cluster | Members | Existing orchestrator | Action | Rationale (cites snapshot) | Child ticket |
|---|---|---|---|---|---|
| **a `<family>` cluster** | `<family>-frontend`, `<family>-backend`, `<family>-cloud` | a `<family>-router` (composer) | **no-op** | Snapshot rows: 0 findings. Well-shaped. | — |
| **skills (meta)** | skill-builder, skill-organizer, skill-generator | skill-organizer (proposer) | **no-op** | P2 sibling overlap is intentional, resolved by `connects_to` + `SKILL_OWNERSHIP_BOUNDARIES.md`. | — |
| **adr** | adr-manager, adr-researcher | adr-manager (lifecycle) | **no-op** | Researcher feeds the manager; boundary already documented. | — |
| **a `<domain>` cluster** | `<domain>-effectiveness`, `<domain>-implementation-audit`, `<domain>-scaffold` | a `<domain>-router` | **no-op** | Router already routes; per-domain synthesis lens is sufficient — adding a posture analog would fail 4Q (not load-bearing). | — |
| **a dual-orchestrator cluster** | the leaf audits | a `backend-router` (router) + a `backend-review` (synthesizer) | **no-op + 1 ticket** | router ↔ review overlap is intentional dual-orchestrator; the pattern needs explicit documentation in `SKILL_AUTHORING.md` so future contributors don't try to collapse them. | **filed** (F-005) |
| **standalones** | repo-map, bug-scan, ticket-manager | n/a | **no-op** | 0 findings each; intentionally standalone. | — |

### Open findings without child ticket (4Q-downgrade)

- **F-004** (two adjacent skills flagged as P2 overlap) — downgraded; needed a
  design call, not a cosmetic ticket.

### Fanout

- **Child tickets filed:** 1. **Expected range:** 3–7. Lower than expected
  because most P2 findings are intentional and downgrade per 4Q. This is
  correct behavior, not under-filing.

### Next-run guidance

- Re-run `generate-reorg-plan` after a design call lands OR after a new skill
  family (3+ siblings) appears.
- Cadence: quarterly OR after any structural skill ticket (rename, merge,
  retire).
