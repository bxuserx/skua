---
name: adr-manager
description: "Owns the `.tickets/ADRs/` lifecycle: create, enrich, transition (FSM-validated), link-to-ticket, list-open, promote-draft-tickets, validate-adr. User input is intentionally minimal — every create / enrich op opens with a Researcher-vs-Builder mode prompt and the AI fills in Decision, Consequences, references, and `proposed_tickets[]`. Distinct from `ticket-manager` (which disclaims ADRs)."
when_to_use: "User says 'file an ADR', 'create ADR for X', 'enrich ADR-NNN', 'flesh out ADR-NNN', 'next steps for ADR-NNN', 'accept ADR-NNN', 'reject ADR-NNN', 'supersede ADR-X with ADR-Y', 'deprecate ADR-NNN', 'list open ADRs', 'TKT-NNN implements ADR-MMM', 'promote drafts in ADR-NNN', 'validate ADR-NNN'."
connects_to:
  - adr-researcher
  - ticket-manager
  - repo-map
kind: workflow
---

# adr-manager

Single skill that owns the `.tickets/ADRs/` lifecycle. Sister to
`ticket-manager` (which explicitly disclaims ADRs). The ADR template
lives at `templates/adr-template.md` — single source of truth.

## Standing rules (apply to every op)

- **Never fabricate.** Numbers come from cited sources or measured
  locally. If you don't know, ask or stop.
- **Never overwrite user-written content.** Every sentence the user
  wrote is a hard constraint — fill around it, not over it.
- **Never bypass `validate-adr` after writing.** The lib's
  `transitionAdr` enforces this; manual writes must too.
- **No silent auto-transitions.** `promote-draft-tickets` only fires as
  a consequence of an explicit `proposed → accepted` transition.
- **All AI-authored Decisions are marked "Suggested"** until the human
  (or Agentic auto-accept) transitions to `accepted`.

## Directory model

```
.tickets/ADRs/
├── ADR-001-<domain>-<slug>.md
├── ADR-002-<domain>-<slug>.md
└── ...
```

Single folder. Status lives in frontmatter
(`proposed | accepted | rejected | superseded | deprecated`), not in
directory structure. ID-minting:
`max(ADR-NNN across .tickets/ADRs/*.md) + 1`, zero-padded to 3 digits;
never reuse IDs of deprecated/rejected ADRs.

## Status FSM

```
                    +-------+
                    |proposed|
                    +-------+
                   /         \
            accept              reject
              /                     \
        +-------+                +-------+
        |accepted|               |rejected|
        +-------+                +-------+
       /         \                   (terminal)
  supersede     deprecate
     /              \
+----------+   +----------+
|superseded|   |deprecated|
+----------+   +----------+
  (terminal)   (terminal)
```

`LEGAL_TRANSITIONS` (mirrors `.skua/lib/adrs.ts`):

| from | legal targets |
|---|---|
| `proposed` | `accepted`, `rejected` |
| `accepted` | `superseded`, `deprecated` |
| `rejected` | (terminal) |
| `superseded` | (terminal) |
| `deprecated` | (terminal) |

Illegal transitions are refused with a descriptive error. Re-opening a
`rejected` or `deprecated` decision = file a new ADR that supersedes it.

## Who can mutate state

1. **This skill** — AI-driven changes via the ops below.
2. **The `.skua/` dashboard** — `POST /api/adrs/:id/transition`.
   Backed by the same `.skua/lib/adrs.ts`.

## Operations

| op | trigger phrases |
|---|---|
| `create-adr` | "file an ADR for X", "create ADR for X", "draft an ADR" — minimal-input by default; routes into `enrich-adr` after minting |
| `enrich-adr` | "enrich ADR-NNN", "flesh out ADR-NNN", "next steps for ADR-NNN", "the ADR is thin — fill it in", "what's missing from ADR-NNN" |
| `transition-adr` | "accept ADR-NNN", "reject ADR-NNN", "supersede ADR-NNN with ADR-MMM", "deprecate ADR-NNN" |
| `link-adr-to-ticket` | "TKT-NNN implements ADR-MMM", "link TKT-NNN to ADR-MMM" |
| `list-open-adrs` | "what ADRs are open?", "show proposed ADRs", "list open ADRs" |
| `promote-draft-tickets` | "promote drafts in ADR-NNN" (manual); auto-fires on `proposed → accepted` |
| `validate-adr` | "validate ADR-NNN"; auto-fires before any transition and during migration |

The `.skua/` dashboard is a parallel GUI for these operations — reads
and writes the same ADR files.

## Mode prompt (used by create-adr + enrich-adr)

Every `create-adr` and `enrich-adr` invocation asks the user **once**
which mode to run: Researcher (R) / User-Driven (U) / Agentic (A). The
verbatim prompt text lives in
`${CLAUDE_SKILL_DIR}/templates/mode-prompt.md` — read and ask it
exactly. The user is asked **at most once per invocation**; everything
downstream the AI fills in.

If the user provides no mode hint (e.g. "next steps for ADR-003"),
default to ASKING. Do not pick silently.

---

## Operation: create-adr

### When to run

- User says "file an ADR for X" — typically with only a title and a
  vague sentence about what they're deciding.
- User pasted a fully-drafted body from `adr-researcher`
  (skip-enrichment path).

### Procedure

1. **Triage the input.** Fully-drafted body from `adr-researcher` → go
   straight to step 4 (skip the mode prompt). Anything else → continue.
2. **Mint the next ID + minimal file.** `bun .skua/scripts/adr-cli.ts next-id`
   or `nextAdrId()`. Write a minimal frontmatter shell (id, title,
   status=`proposed`, created=today, deciders=[bx], domain, empty
   arrays) plus a body containing only what the user gave you. Filename
   `ADR-NNN-<domain>-<slug>.md` under `.tickets/ADRs/`.
3. **Immediately invoke `enrich-adr ADR-NNN`.** Do not stop to ask for
   more body content — `enrich-adr` owns the mode question.
4. **Skip-enrichment path** (pasted complete body): substitute
   frontmatter / body / filename per the template; `writeAdr`;
   `validate-adr`; echo path. No mode prompt.

### Op-specific honesty

- If a pasted draft doesn't match the template structure, normalize it
  (rename sections, fill missing frontmatter) before writing.

---

## Operation: enrich-adr

### When to run

- Immediately after `create-adr` mints a thin file (auto-chained).
- User says "enrich ADR-NNN", "flesh out ADR-NNN", "next steps for
  ADR-NNN".
- `validate-adr` on a proposed ADR reports placeholder body sections
  AND empty `proposed_tickets[]`.

This is the **default path** for any ADR that isn't already complete.

### Procedure

1. **Read the current ADR.** Capture title, any user-supplied TL;DR,
   Context, Decision, Consequences, Alternatives, tags, domain. Treat
   every user-written sentence as a hard constraint.
2. **Diagnose thinness.** Mark each body section + `proposed_tickets[]`
   as `user-written` (preserve verbatim), `placeholder` (template
   default — replace), `empty` (fill), or `directive` (e.g. "fill this
   in" — treat as a request, then delete the directive).
3. **Ask the mode question.** Read
   `${CLAUDE_SKILL_DIR}/templates/mode-prompt.md` and ask verbatim.
   Wait for the answer.
4. **Run the chosen mode:**
   - **R** → invoke `adr-researcher` with `topic=<ADR title>` AND the
     ADR ID. The researcher returns markdown; never writes to disk —
     `adr-manager` owns the write.
   - **U** → no external skill. Read `.tickets/ADRs/` for prior art,
     scan the repo's primary source directories (whatever the project
     uses — e.g. `src/`, `backend/`, `frontend/`, `services/`, or the
     repo root), plus `plans/` and `docs/` if present, scan tickets.
     Synthesize locally.
   - **A** → same pipeline as R, then auto-continue to step 10.
5. **Build the enriched body.** For every `placeholder` / `empty` / `directive` section, generate content; preserve every `user-written` block. Required sections: **TL;DR** (2–4 sentences); **Context** (cite file paths via symbol refs); **Alternatives considered** (≥2, ideally 3, pros/cons/why-rejected); **Decision (Suggested)** (labeled "Suggested" until accepted); **Consequences** (tickets implied, conventions, risks, blast radius — informs the fan-out); **References** (R mode only — URLs + internal paths cited).
6. **Draft `proposed_tickets[]`** per `${CLAUDE_SKILL_DIR}/templates/proposed-ticket.yaml`. For complex multi-phase ADRs (ML pipelines, schema migrations), produce phase-1 (3–4 drafts) plus a one-line phase-2 stub.
7. **Write the enriched ADR back via `writeAdr`.** Single atomic write.
   Stays in `proposed` (R / U). A continues to step 10.
8. **Run `validate-adr ADR-NNN`.** Report P0/P1/P2.
9. **R / U — STOP here.** Echo a compact summary: mode used; sections
   added vs preserved; number of drafts; validation result; one-line
   "Review at `/adrs/ADR-NNN`. Accept to mint the drafts as real
   tickets, or reject."
10. **A — auto-continue past enrichment.** No mid-flow user gates
    (agentic-flow contract).
    a. P0 from `validate-adr` → stop, park the ADR with a comment,
       surface to user. Do not transition.
    b. Else: `transitionAdr(id, 'accepted', deciders)`. The lib stamps
       `decided: <today>` and auto-fires `promoteDraftTickets(id)`.
    c. Echo: "Agentic flow complete. ADR-NNN status=accepted; minted
       TKT-AAA, TKT-BBB, TKT-CCC. Review the new tickets in
       `0-backlog/`."

### Op-specific honesty

- **R / A modes MUST cite sources** (URLs or internal file paths).
  **U mode MUST cite internal file paths.**
- **Idempotent.** Re-running reads first-run output as `user-written`
  and only fills remaining gaps. A on an already-accepted ADR is a
  no-op + warning.

---

## Operation: transition-adr

### When to run

- User says "accept ADR-NNN" / "reject ADR-NNN" / "supersede ADR-NNN
  with ADR-MMM" / "deprecate ADR-NNN".
- Composition: `validate-ticket`'s `follow_up_surfacing` axis flagged a
  decision-class item → `create-adr` → user reviews →
  `transition-adr proposed → accepted`.

### Procedure

1. Run `validate-adr <id>` first. Refuse the transition if validation
   fails.
2. Read current status from frontmatter.
3. Check `LEGAL_TRANSITIONS[from]` includes `to`. If not, refuse with
   an error naming current/legal/attempted (matches the lib's format).
4. Call `transitionAdr(id, to, deciders)` from `.skua/lib/adrs.ts`.
   The lib stamps `decided: <today>` on accept/reject, runs
   `validateAdr` first, and does the atomic write.
5. If `to === 'accepted'` AND `proposed_tickets[]` non-empty, call
   `promoteDraftTickets(id)` (same code path as dashboard).
6. If `to === 'superseded'`, supersedes mirror is normally handled at
   **create-time** by the lib's `mirrorSupersedes`. A manual
   `transition-adr proposed → superseded` (calling
   `mirrorSupersedes(newAdrId, [oldAdrId])` explicitly) is only needed
   when superseding without filing a replacement.
7. Echo the transition + side-effects (promoted tickets, superseded
   chain).

### Op-specific honesty

- One transition per invocation. Never batch (e.g. accept-then-supersede
  in one call).
- The `decided` date stamp is the lib's job — never set it manually.

---

## Operation: link-adr-to-ticket

### When to run

- User says "TKT-NNN implements ADR-MMM" / "link TKT-NNN to ADR-MMM".
- Auto-composition: as part of `promote-draft-tickets` (new tickets get
  `implements_adr: ADR-MMM`; the parent ADR's `related_tickets` gets
  the new IDs appended).

### Procedure

1. Verify both IDs exist (`readAdr`, `ticket-manager.findTicket`).
2. **Atomic bidirectional write:**
   - ADR: append `TKT-NNN` to `related_tickets` (idempotent).
   - Ticket: set `implements_adr: ADR-MMM` (singular — refuses if the
     ticket already has a *different* `implements_adr`; a ticket
     implements at most one ADR per ADR-001 §D6).
3. If the ticket already has the SAME `implements_adr`, no-op silently.
4. Echo both file paths.

### Op-specific honesty

- `implements_adr` is singular. If a ticket genuinely implements two
  ADRs, one isn't really an ADR (it's a sub-decision belonging in the
  parent's Decision section).

---

## Operation: list-open-adrs

### When to run

- User says "what ADRs are open?", "show proposed ADRs", "what
  decisions are pending?".

### Procedure

1. Call `listAll()` from `.skua/lib/adrs.ts`. Filter to
   `status: "proposed"`.
2. For each, output: `<id> | <title> | created <date> | <count>
   deciders | <count> drafts queued`.
3. Pure read; no writes.

---

## Operation: promote-draft-tickets

### When to run

- **Auto-fires** as part of `transition-adr proposed → accepted` when
  `proposed_tickets[]` is non-empty.
- **Manual**: user says "promote drafts in ADR-NNN" (e.g. after editing
  `proposed_tickets[]` post-acceptance).

### Procedure

Call `.skua/lib/adrs.ts:promoteDraftTickets(id)` (same code path as the
dashboard's `POST /api/adrs/:id/transition`). The lib implements the
three-pass algorithm per ADR-001 §D5:

1. **Pre-check** — if `materialized_tickets[]` populated AND `proposed_tickets[]` empty → no-op + warn. Idempotent.
2. **Pass 1 — mint** — for each draft, `ticket-manager.create-ticket` with `title`, `domain` (draft's or inherit ADR's), `related: [sibling IDs already minted]`, `implements_adr: ADR-NNN`, auto-generated Context. Track the `{draft_id, ticket_id}` mapping.
3. **Pass 2 — resolve depends_on** — `DRAFT-N` → lookup `TKT-MMM` from mapping; `TKT-NNN` → preserve. Append via `ticket-manager.link-tickets`.
4. **Pass 3 — replace draft payload** — `readAdr`, delete `proposed_tickets`, set `materialized_tickets`, `writeAdr`. Audit trail preserved.

### Failure handling

- `create-ticket` fails on draft N → roll back N-1 minted tickets via `ticket-manager.move-ticket` to `7-archive/` with `failed_promotion: ADR-NNN`. ADR stays `accepted`. User re-runs after fixing root cause.
- Draft references a non-existent cross-ADR `TKT-NNN` → caught by `validate-adr` before transition; promotion never starts against a broken graph.
- Mid-promotion crash → mapping rebuilt on retry by walking new tickets' `implements_adr`. Re-runs safe.

### Op-specific honesty

- Drafts added post-acceptance need an explicit "promote drafts in
  ADR-NNN" — never auto-fired outside the `proposed → accepted` path.
- Always preserve `materialized_tickets`. Never delete after promotion.

---

## Operation: validate-adr

### When to run

- **Auto-fires** before every `transition-adr` call.
- **Auto-fires** during migration of pre-schema ADRs.
- **Manual**: user says "validate ADR-NNN".

### Checks + severities

Full check matrix in `${CLAUDE_SKILL_DIR}/templates/validate-checks.md`
(schema, FSM, references, body, draft graph integrity; P0/P1/P2
severities). `validateAdr(id)` in `.skua/lib/adrs.ts`
implements it and is called by `transitionAdr` before every state
change — both this skill and the dashboard endpoint go through the
same gate.

### Procedure

1. Run all checks (lib does this). Collect findings.
2. Return a P0/P1/P2 punch list. **Never mutates.**

---

## Composition

| upstream | this skill | downstream |
|---|---|---|
| User says "file an ADR for X" with a thin seed | `create-adr` → `enrich-adr` | user reviews + transitions |
| `adr-researcher` returns a complete body | `create-adr` skip-enrichment | user reviews + transitions |
| `validate-ticket` flags a decision-class follow-up | `create-adr` + `enrich-adr` | user transitions when ready |
| `enrich-adr` in R mode | invokes `adr-researcher` (read-only) | research consumed back here; `adr-manager` owns the write |
| User accepts an ADR | `transition-adr proposed → accepted` | auto-fires `promote-draft-tickets` → `ticket-manager.create-ticket` ×N |
| `promote-draft-tickets` mints real tickets | `link-adr-to-ticket` (atomic bidirectional) | tickets carry `implements_adr` for the lifetime of the ADR |
| ADR-graph builder (`repo-map`) | reads `proposed_tickets` + `materialized_tickets` | renders nodes + edges per ADR-001 §D4 |

## What this skill does NOT do

- **Never** decides on behalf of the user. Transitions are always
  user-initiated (or dashboard-initiated, which is the user).
- **Never** writes tickets directly. Mints them via
  `ticket-manager.create-ticket`.
- **Never** mutates `.tickets/ADRs/` outside the ops above. Ad-hoc
  edits bypass `validate-adr` and break the audit trail.
- **Never** silently auto-promotes drafts. Only
  `transition-adr proposed → accepted` triggers the chain.
- **Never** changes the ADR template without a corresponding ADR
  amendment. The template at `templates/adr-template.md` reflects the
  schema in ADR-001 §D1; if the schema evolves, file a new ADR that
  supersedes ADR-001.
