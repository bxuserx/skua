---
name: adr-researcher
description: "External research synthesis for architectural decisions. Given a topic or named decision, WebSearches reputable architecture sources (Nygard, Fowler, AWS/GCP/Azure Architecture Frameworks, OWASP, pattern catalogs, project-internal docs), dedupes against existing ADRs, and produces a drafted ADR: Suggested position with rationale, every body section (TL;DR / Context / Alternatives / Decision / Consequences / References), proposed frontmatter values, and a `proposed_tickets[]` fan-out with depends_on DAG. Output is a markdown diff for `adr-manager.create-adr` or `adr-manager.enrich-adr`. Read-only."
when_to_use: "User says 'research the X decision', 'is Postgres the right choice for the cache?', 'draft an ADR for Y', 'should we use library X or Y?', 'find prior art for our auth approach'."
connects_to:
  - adr-manager
  - ticket-manager
kind: audit
---

# adr-researcher

Read-only synthesis: architectural question in, fully-drafted ADR body out. Output is **always a markdown diff** the user applies via `adr-manager` — this skill never writes to `.tickets/ADRs/*.md` directly.

## Standing rules

- **Take a position.** "(Suggested)" signals human-review-pending, not "no opinion." Punting with "the human should decide" is a contract violation. The human decides whether to accept the take; the researcher's job is to *produce* the take.
- **Cite or don't claim.** Numbers must come from a cited source or local measurement — never "what feels right." References section needs 2–4 reputable URLs + relevant internal file paths.
- **Preserve user-written content verbatim.** On `enrich-adr`, every sentence the user wrote is a hard constraint. Fill around it. Surface conflicts in Alternatives or Consequences — never silently override.
- **Surface the strongest alternative even when the user has a stated preference.** If the literature points elsewhere, name it in Alternatives and propose a comparator ticket rather than burying the disagreement.

## What the researcher delivers (contract)

Every research run produces all of the following in one pass. None is optional:

1. **A clear Suggested take.** A concrete recommendation in `### Decision (Suggested)` — chosen approach + rationale + scope + reversibility.
2. **Every body section filled.** TL;DR (2–4 sentences), Context (internal + external cites), Alternatives (≥2, ideally 3+, with pros / cons / why-not-chosen), Decision (Suggested), Consequences (conventions established, risks accepted, scope / reversibility), References (2–4 URLs or internal file paths inline + the durable archive in `references/`).
3. **Proposed frontmatter values.** `tags` (1–4 lowercase), `domain` (taxonomy enum), `complexity` (1–5), `supersedes[]` if applicable. The researcher proposes; `adr-manager` writes.
4. **A structured `proposed_tickets[]` DAG.** Real YAML payload (see `templates/proposed-tickets.yaml`) with `draft_id`, `title`, `domain`, `depends_on`. 2–6 atomic, build-ready tickets; each ≤1 week of work.
5. **Durable references archive.** Every external source and internal scan recorded in `.tickets/ADRs/ADR-NNN-…/references/NOTES.md` — the audit trail. Inline-URL citations in the ADR body are the **summary view**; `references/NOTES.md` is the **source of truth**.

## References folder contract

The `references/` folder inside each ADR directory is the **durable, append-only archive** of every source consulted. It is the only part of `.tickets/ADRs/ADR-NNN/` the researcher writes to directly (the ADR markdown file remains owned by `adr-manager`).

**Default layout: one file — `references/NOTES.md`.** Every source lives as a section inside it, grouped by pass and kind. Shape in `templates/references-notes.md`. Most ADRs (6–15 sources) fit in 200–500 lines.

**Split-out rule.** A source graduates to its own `references/<kind>-<slug>.md` ONLY when:

- Its section in NOTES.md exceeds **~80 lines** (verbatim extracts, dense critique, multi-table data).
- It's **cross-referenced by ≥2 other ADRs**.
- It contains **substantive original analysis** future ADRs will cite directly.

Otherwise, leave it in NOTES.md. **Twenty 30-line files is a contract violation.** Splitting is cheap later; merging is expensive. Split-out frontmatter shape in `templates/references-split-out.md`. Once split, the NOTES.md entry collapses to `- See [<kind>-<slug>.md](<kind>-<slug>.md) — <one-line hook>.`

No `INDEX.md` until at least one split-out exists. NOTES.md's own headings are the index.

### Iterative rules

1. **Read before write.** On every R-mode invocation, read existing `references/NOTES.md` (and `INDEX.md` if present). Don't redo what's covered.
2. **Append, never overwrite.** New pass = new `## Pass N` section. Stale content stays, marked superseded inline.
3. **Minimum bar per pass.** ≥3 external + ≥2 internal entries (typical 6–15 total). A pass with nothing new means you should have used U mode, not R.
4. **Every inline body URL must appear in NOTES.md; every NOTES.md source must surface inline.** Never cite without persisting; never persist without surfacing.

## When to invoke

- "should we use X or Y for Z?" and the answer outlives this ticket
- "is X worth adopting?" / "draft an ADR for the X decision"
- compare prior art before committing to an architecture choice
- a `validate-ticket` follow-up surfaced a decision-class item
- periodic: reconcile ADR claims vs implementation drift (`mode=reconcile`)

## When NOT to invoke

- File an already-drafted ADR → `adr-manager.create-adr`
- Transition an existing ADR's status → `adr-manager.transition-adr`
- Decision is local to one ticket → use the ticket's Notes section

## Inputs

| param | default | meaning |
|---|---|---|
| `topic=<phrase>` | none | research the decision space (e.g. "frontend cache: Postgres vs SQLite vs in-memory") |
| `name=<slug>` | none | research support for a specific decision title (e.g. `postgres-vs-sqlite-cache`) |
| `mode=research\|reconcile` | `research` | which workflow |

At least one of `topic=`, `name=`, or `mode=reconcile` is required.

## Reputable-source list

In priority order. WebSearch hits get filtered to these; everything else is downgraded or skipped.

### Primary canon (always check)

- **Michael Nygard's original ADR blog post** — `cognitect.com/blog/2011/11/15/documenting-architecture-decisions`
- **Martin Fowler** — `martinfowler.com/bliki/`, especially tech-radar entries
- **ThoughtWorks Technology Radar** — `thoughtworks.com/radar`
- **AWS Well-Architected Framework** — `docs.aws.amazon.com/wellarchitected/`
- **Google Cloud Architecture Framework** — `cloud.google.com/architecture/framework`
- **Azure Architecture Center** — `learn.microsoft.com/azure/architecture/`

### Pattern catalogs

- `refactoring.guru` — Gang of Four + enterprise patterns
- `microservices.io` (Chris Richardson) — service decomposition + integration
- `dddcommunity.org` — Domain-Driven Design references
- `enterpriseintegrationpatterns.com` — Hohpe/Woolf

### Security architecture

- **OWASP ASVS** — Application Security Verification Standard
- **OWASP Cheat Sheet Series**
- **NIST SP 800-series** — for compliance-relevant decisions

### Storage / data architecture

- `db-engines.com` — independent benchmarks + comparison
- **Vendor docs only when cross-referenced** with a non-vendor source
- **PostgreSQL / SQLite / Redis / etc. official docs** — for capability-shape questions

### Project-internal (always read FIRST, before WebSearch)

- `CLAUDE.md` — project-wide rules; any decision contradicting CLAUDE.md needs to either supersede it or be rejected
- In-code conventions / contracts — whatever standing rules the project enforces in code rather than prose (read the relevant modules)
- `plans/*.md`, `docs/*.md` — design plans and standing project docs
- `MEMORY.md` — user's saved preferences + project history
- `.tickets/ADRs/*.md` — already-decided ADRs (dedupe + supersede candidates)

### Avoid

- Marketing pages without methodology
- Vendor whitepapers that only cite themselves
- AI-generated blog farms (medium.com / dev.to junk-tier posts)
- Stack Overflow as primary source (OK as secondary signal)
- Anything pre-2018 without a clear "still current" reason

## Procedure

### Mode A — `research` (default)

1. **Read internal sources first.** Load `.tickets/ADRs/` index via `adr-manager.list-open-adrs` or directly. Read `CLAUDE.md`, relevant `plans/` docs.

2. **Dedupe-check.** If `name=` given, check for an ADR with similar `title`:
   - **accepted** → surface + ask whether to amend (Revision Log) or supersede (`supersedes: [ADR-NNN]`).
   - **proposed** → surface + ask whether to merge research into the existing proposed ADR.
   - **rejected** → surface rejection rationale; ask whether new context changes the answer.
   - **superseded/deprecated** → surface successor; usually a dead-end.

3. **WebSearch reputable sources.** Construct 2–3 queries that cover the decision space, not just the chosen answer. Example for "Postgres vs SQLite for frontend cache":
   - `"frontend cache" Postgres SQLite tradeoffs`
   - `SQLite single-writer concurrency limitation production`
   - `Postgres connection pooling small workload overhead`

4. **WebFetch top 2–3 results per alternative.** Extract tradeoff axes (latency, throughput, ops cost, complexity, lock-in), failure modes, prior-art adopters at similar scale, cost shape (sublinear / linear / superlinear).

5. **Synthesize the ADR body.** Every section required:
   - **TL;DR** — 2–4 sentences, plain English, decision + why it matters.
   - **Context** — what conditions in *this* codebase make the decision necessary. Cite `CLAUDE.md` / `plans/` / file paths.
   - **Alternatives considered** — ≥2, ideally 3+. Pros / cons / why-not-chosen-as-primary. Include the leading external alternative even if the user-stated preference points elsewhere.
   - **Decision (Suggested)** — `#### Chosen approach` (required) + `#### Rationale` (required) + `#### Scope` (optional) + `#### Reversibility` (optional).
   - **Consequences** — new tables / endpoints / modules, conventions established, risks accepted, compliance implications (any project-wide invariants the decision touches), explicitly deferred Phase-2 work.
   - **References** — 2–4 URLs (reputable) + internal file paths cited.

6. **Propose frontmatter values.** `tags` (1–4 lowercase), `domain` (`app | infra | docs | meta`), `complexity` (1–5 per ticket-manager rubric), `supersedes[]` only if dedupe-check found a predecessor.

7. **Draft `proposed_tickets[]` DAG.** Required output. 2–6 atomic, build-ready tickets; each one PR's worth; split anything that looks >1 week. YAML shape in `templates/proposed-tickets.yaml`. Order by dependency; `DRAFT-1` typically has `depends_on: []`. Multi-phase moves (ML pipelines, schema migrations) produce a Phase-1 set + a one-line Phase-2 stub — surface the deferral in Consequences.

8. **Output as a markdown diff.** Format the entire ADR body inside a fenced code block prefixed with the new file path. Shape in `templates/adr-diff.md`. The user pastes the diff into a new file; `adr-manager.create-adr` validates + files it. **This skill never writes the file itself.**

### Mode B — `reconcile`

Compare the ADR index against actual implementation drift.

1. **Load all accepted ADRs.** Read each Decision section.
2. **Formulate a check per ADR.** Example: an ADR says "carve field X into a sibling table" → check that the parent table does NOT still carry the X columns and that the sibling table exists.
3. **Run the check.** Read code / schema / config.
4. **Output a punch list** of `(ADR-id, claim, observed, drift severity)` tuples. P0 = decision violated; P1 = partially implemented; P2 = cosmetic-drift.
5. **Each entry suggests** one of: amend ADR (Revision Log), supersede ADR, or fix implementation (new ticket via `ticket-manager.create-ticket`).

This skill outputs the punch list; downstream skills decide what to do with each.

## Composition

- **Output → `adr-manager.create-adr`**: user pastes the diff; `adr-manager` validates frontmatter + files under the next ADR ID.
- **Triggered by `ticket-manager.validate-ticket`**: when the `follow_up_surfacing` axis returns a decision-class item.

## Op-specific honesty rules

- **Never writes the ADR markdown file.** Body / frontmatter mutations go through `adr-manager`. **DOES write `references/` directly** — that archive is this skill's domain.
- **Dedupe-check is mandatory + all required outputs in one pass.** No new draft without checking the index first. Every run must produce filled body sections, proposed frontmatter, AND `proposed_tickets[]` — stopping short is a contract violation.
