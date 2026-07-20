---
name: skill-organizer
description: "Portfolio-level skill curation: proposes merges, renames, retirements, and orchestrator wraps. Consumes `skill-builder`'s `overlap-check`, `audit-all`, and `list-orphans` primitives (does NOT reimplement). Generates a versioned `PORTFOLIO_REORG_PLAN.md` and sweeps `connects_to` edges after structural changes."
when_to_use: "User says 'reorganize the skills', 'propose a merge for X and Y', 'should we rename Z?', 'wrap a skill family in an orchestrator', 'generate a portfolio reorg plan', 'sweep connects_to after the rename', 'is the skill portfolio coherent?', 'audit the portfolio for overlaps and propose fixes', 'plan a skill consolidation', 'retire skill X'."
connects_to:
  - skill-builder
  - ticket-manager
kind: orchestrator
---

# Skill Organizer

Portfolio-level curation for `.claude/skills/`. Proposes; child tickets execute.

## Standing rules (apply to every op)

- **Never fabricate.** If an op needs data it can't fetch (stale graph, missing primitive output), stop and report — do not infer.
- **Proposes, never mutates.** Every op writes a plan or a child ticket. The single writer-exception is `sweep-connects-to`, which edits ONLY `connects_to:` frontmatter arrays after a parent ticket has executed.
- **4-question filter on every proposed action.** Before a `propose-*` op emits a recommendation, answer literally:
  1. **Would someone pay to fix this?** (Real user value, not theoretical.)
  2. **Will this bite us if we leave it?** (Concrete risk, not vibes.)
  3. **Is the current state load-bearing context?** (connects_to edges, boundary-doc citations, user habits.)
  4. **Is this fixable now?** (No blocking dependency, no missing decision.)

  Two or more no-answers → downgrade to a "keep, document the boundary" plan entry rather than a child ticket.
- **Rename bias toward shorthand.** Prefer adding a `when_to_use` trigger phrase over a slug rename when the existing slug is descriptively honest. `propose-rename` must consider and explicitly reject the shorthand alternative before recommending a rename.
- **Single-direction relationships.** When filing child tickets, `depends_on` and `blocks` are directional opposites — pick one per edge (per `ticket-manager` convention).
- **No new skills from this skill.** A new orchestrator is scaffolded by `skill-builder.create-skill` via a child ticket from `propose-orchestrator-wrap`; this skill never writes SKILL.md itself.

## When to invoke

- "propose a merge for X and Y" → `propose-merge`
- "should we rename Z?" / "is Z's slug honest?" → `propose-rename`
- "retire skill X" / "is X still load-bearing?" → `propose-retire`
- "wrap the security family in an orchestrator" → `propose-orchestrator-wrap`
- "generate a portfolio reorg plan" / "reorganize the skills" → `generate-reorg-plan`
- "sweep connects_to after the rename" → `sweep-connects-to`
- "audit skill naming" / "are the high-level slugs consistent?" → `audit-naming`
- "audit the edge taxonomy" / "are parent/handoff annotations correct?" → `audit-edges`

## When NOT to invoke

- Creating a new skill from scratch → `skill-builder.create-skill`
- Auditing a single skill against the authoring checklist → `skill-builder.audit-skill`
- Validating frontmatter only → `skill-builder.validate-frontmatter`
- Checking if a proposed description overlaps existing skills → `skill-builder.overlap-check`
- Portfolio-wide audit pass (no proposals, just findings) → `skill-builder.audit-all`
- Mutating skill files directly — this skill PROPOSES; child tickets EXECUTE.

## Single-source-of-truth boundary

`skill-organizer` does NOT enumerate the skill directory itself. The 5 inventory primitives live in `skill-builder`:

| Primitive | Owner |
|---|---|
| `overlap-check` | `skill-builder` |
| `audit-all` | `skill-builder` |
| `list-orphans` | `skill-builder` |
| `validate-frontmatter` | `skill-builder` |
| `audit-skill` | `skill-builder` |

Every op in this skill consumes those primitives' output and adds policy on top. Failure mode this prevents: two skills with slightly different regexes producing disagreeing inventories of the same source set. Full owner-table at `${CLAUDE_SKILL_DIR}/references/SKILL_OWNERSHIP_BOUNDARIES.md`.

## Procedure overview

9 ops. `generate-reorg-plan` composes every `propose-*` op; `dry-run-portfolio-scan` is its read-only sibling. Full alternate-phrasing index at `${CLAUDE_SKILL_DIR}/references/OP_TRIGGERS.md`.

---

## Operation: propose-merge

Evaluates whether two (or more) skills should collapse into one and produces a merge recommendation.

### Procedure

1. **Pull overlap data.** Call `skill-builder.overlap-check <slug-a>` (or against the cluster) and capture the P0/P1/P2 findings. If no P0/P1 overlap exists between the candidates, abort with "no overlap — merge unjustified" verdict; do NOT recommend a merge against P2-only adjacency.
2. **Read both SKILL.md frontmatters** via the existing parser at `.skua/lib/frontmatter.ts:44 parse()`. Capture `description`, `when_to_use`, `connects_to`, `kind`, and body line counts.
3. **Apply the 4-question filter** (see §Standing rules). If two or more no-answers, downgrade to "keep separate, document the boundary" plan entry — NOT a merge ticket.
4. **Decide direction.** A merge has a survivor and an absorbed party. Pick the survivor by: (a) which has more `connects_to` inbound edges (more downstream users), (b) which has the more general scope, (c) which has the cleaner slug per the naming convention. Cite the decision rationale.
5. **Map ops.** Enumerate each operation in the absorbed skill and place it as an op on the survivor. Flag any ops with the same name as the survivor's existing ops as collision-risk requiring rename.
6. **Estimate `connects_to` churn.** List every skill whose `connects_to:` would need a sweep after the merge. `sweep-connects-to` is the op that executes the sweep; this op only estimates the cost.
7. **Emit a proposal block** (returned to the caller, or written to the plan document by `generate-reorg-plan`):
   ```markdown
   ### Merge proposal: <absorbed-slug> → <survivor-slug>

   - **Overlap:** <Jaccard, shared phrases from overlap-check>
   - **4Q filter:** <pass/downgrade — bullets>
   - **Survivor rationale:** <why this slug wins>
   - **Op mapping:** <table of absorbed ops → survivor op names>
   - **connects_to sweep:** <N skills affected — list slugs>
   - **Child ticket:** TKT-XXX (filed via ticket-manager.create-ticket)
   ```
8. **File the child ticket** (only if the 4Q filter passes). The child cites the parent reorg ticket in `related:`, names both slugs, includes an AC bullet for the `sweep-connects-to` run, and includes an AC bullet for `skill-builder.audit-skill <survivor>` reporting clean post-merge.

### Op-specific rules

- Trigger-phrase collision is not by itself merge justification — intentional fan-out is a legitimate design.
- A merge across `kind:` boundaries (e.g. `utility` → `orchestrator`) must include an explicit note; the survivor's character changes. Surface inherited `disable-model-invocation: true` the same way.

---

## Operation: propose-rename

Evaluates whether a skill's slug should change, and if so, what the new slug should be.

### Procedure

1. **Read the candidate's frontmatter** + body title via `.skua/lib/frontmatter.ts:44 parse()`.
2. **Check the slug against the naming convention** at `.claude/skills/skill-builder/references/SKILL_AUTHORING.md` (kebab-case, ≤64 chars, noun phrase or action-object pair over imperative). If the slug already complies AND is descriptively honest, abort with "slug is fine — recommend shorthand-only enrichment" verdict.
3. **Apply the 4-question filter.** A rename that survives typically has one of: (a) slug actively misleads (e.g. a `data-forensics`-named skill that no longer does forensics), (b) slug collides phonetically with a sibling, (c) cluster-wide naming inconsistency the rename would resolve.
4. **Consider shorthand alternative first.** Can the rename's intent be served by adding a trigger phrase in `when_to_use`? If yes, recommend the shorthand path and STOP — do NOT recommend the rename.
5. **If rename is still warranted, propose the new slug.** Validate the candidate against `skill-builder.overlap-check --description <existing-description> --when-to-use <existing-when-to-use>` (run as if scaffolding a new skill) — the new slug's directory must not exist and the new name must not introduce a P0 overlap with other skills.
6. **Estimate `connects_to` churn.** Every skill currently pointing at `<old-slug>` in its `connects_to:` list needs an edit. Cite the count.
7. **Emit a proposal block** with: old slug, new slug, rationale, 4Q result, shorthand-rejected explanation, connects_to churn list, child ticket ID.
8. **File the child ticket** that executes the rename + sweep (only if all gates pass).

### Op-specific rules

- Shorthand is the default. Every rename proposal must include an explicit "shorthand rejected because…" line; "slug is unclear" alone is insufficient.
- A rename that aligns a one-off slug with an existing family (`skua-*`, `security-*`) is +1 in the rationale — pattern-alignment lowers churn.

---

## Operation: propose-retire

Evaluates whether a skill should be retired (deleted entirely) and produces a retirement recommendation.

### Procedure

1. **Pull orphan data.** Call `skill-builder.list-orphans` and check whether the candidate appears there (no `when_to_use`, no `connects_to`, or broken edges).
2. **Pull `connects_to` inbound edges.** Read `.skua/cache/skills-graph.json`. **Staleness check first:** if the cache mtime is older than the newest skill source mtime (per the comparison logic in `.skua/server.ts:skillSourceMtimes`), run `cd .skua && bun run build:graphs` before reading — stale cache produces wrong inbound-edge counts and a bad retire verdict. Then count incoming edges to the candidate.
3. **Apply the 4-question filter.** A retirement that survives typically has: (a) zero inbound `connects_to` edges, (b) no usage in the last 30 days (heuristic — surface to user if unverifiable), (c) the capability is covered by another skill or has become irrelevant.
4. **Propose disposition.** Options: (a) delete the entire skill directory, (b) absorb into a sibling (then hand off to `propose-merge`), (c) park in `.claude/skills/_retired/` with a tombstone README explaining why and when (preferred when the skill might come back).
5. **Estimate sweep cost.** List every skill with `connects_to: [<candidate>]` — those edges need pruning.
6. **Emit a proposal block** with: slug, inbound-edge count, last-touched date, disposition recommendation, sweep list, child ticket ID.
7. **File the child ticket** that executes the retirement + sweep. Set the child priority based on the 4Q "will this bite us" answer.

### Op-specific rules

- Zero inbound edges is NOT sufficient justification — intentional standalones exist (`simplify`, `init`, `review`, `security-review`).
- Never retire a skill cited as the owner of a dimension in another skill's `references/SUBSKILL_BOUNDARIES.md` (or this skill's `SKILL_OWNERSHIP_BOUNDARIES.md`) — a structural dependency the edge graph doesn't capture.

---

## Operation: propose-orchestrator-wrap

Evaluates whether a cluster of related skills should be wrapped in a new orchestrator (synthesizer or router), and what the orchestrator's shape should be.

### Procedure

1. **Identify the cluster.** Either the user names it or `generate-reorg-plan` provides it. Use `skill-builder.audit-all` output to identify P1/P2-overlapping skill pairs as cluster-membership hints; do NOT enumerate the directory directly.
2. **Determine the shape.** Three documented patterns:
   - **Composer-with-dedup** (e.g. `security`): runs siblings in sequence, dedups findings, layers cross-cutting analysis. Has a `references/SUBSKILL_BOUNDARIES.md`.
   - **Pure router** (e.g. a hypothetical `backend-router` / `<domain>-router`): intent-routes to siblings; no own logic.
   - **Synthesizer** (e.g. a hypothetical `<domain>-review`): runs all siblings, produces a single senior-engineer report.
3. **Apply the 4-question filter.** Specifically: (a) does user intent regularly map to 2+ skills in this cluster? (b) is routing logic non-trivial enough that the user can't pick the right sibling on their own? If both are no, recommend "keep direct invocation" and abort.
4. **Propose the orchestrator's shape.** Specify: name (per naming convention), `kind: orchestrator`, `connects_to: [...siblings]`, op surface (e.g. `audit-all-and-synthesize`, `route-intent`), and which pattern from step 2 applies.
5. **Reference the boundary-doc precedent.** The orchestrator's child ticket MUST include an AC bullet for a `references/SUBSKILL_BOUNDARIES.md` (or equivalent) following the `security` shape — single-owner mapping for every dimension the cluster covers.
6. **Emit a proposal block** with: cluster member slugs, proposed orchestrator slug, shape, rationale, 4Q result, child ticket ID.
7. **File the child ticket.** The child invokes `skill-builder.create-skill <new-orchestrator-slug>` and includes ACs for the boundary doc, the sibling `connects_to: [<new-orchestrator>]` reverse-edge updates, and `skill-builder.audit-skill <new-orchestrator>` reporting clean.

### Op-specific rules

- The proposal must articulate what the orchestrator does that siblings cannot do individually (dedup, cross-cutting analysis, intent routing, snapshot-over-time). Pure re-export is friction without value.
- Naming uses canonical suffixes `-router` / `-review` / `-posture` per `${CLAUDE_SKILL_DIR}/references/NAMING_CONVENTION.md`. New suffixes require editing that doc first.

---

## Operation: generate-reorg-plan

End-to-end portfolio reorganization pass. Drives every `propose-*` op against every cluster, applies the 4Q filter, and emits a single plan document plus the child-ticket fanout.

### Procedure

1. **Capture the audit snapshot.** Call `skill-builder.audit-all` and write its output to `.skua/cache/skill-portfolio-audit-<YYYY-MM-DD>.md`. Include per-skill P0/P1/P2 counts, top-5 severity-weighted skills, top-5 overlapping pairs. This is the "before" snapshot; every plan recommendation must cite a finding ID from this file.
2. **Identify clusters.** Group skills by: (a) shared prefix (`security-*`, `adr-*`, `skill-*`, `<domain>-*`), (b) shared `connects_to` edges (sibling skills called by the same orchestrator), (c) P1/P2 overlap pairs from the audit. Output a cluster list with member slugs.
3. **Per cluster, drive the propose-* ops.** For each cluster:
   - Call `propose-merge` against each P1+ overlap pair within the cluster.
   - Call `propose-rename` against each member whose slug appears unclear or off-pattern relative to siblings.
   - Call `propose-retire` against each member with zero inbound edges and any other retire indicator.
   - Call `propose-orchestrator-wrap` if the cluster has 2+ members and no existing orchestrator.
4. **Apply the 4Q filter at the cluster level too.** A cluster that audits cleanly with no surviving proposals MUST be recorded in the plan with a no-op entry. Empty silence is not acceptable (prevents `validate-ticket` from later spawning cosmetic cleanup tickets against the same cluster). Use this stencil:
   ```markdown
   ### No-op verdict: <cluster-name>

   - **Members:** <comma-separated slug list>
   - **Existing orchestrator:** <slug or "none">
   - **4Q result:** <one-line summary — pass / downgrade reasons>
   - **Rationale:** <one sentence — why this cluster doesn't need change>
   - **Boundary already documented in:** <file path, or "(documented in this plan)">
   ```
5. **Write the plan document** at `.claude/skills/skill-organizer/references/PORTFOLIO_REORG_PLAN.md`. Structure: cluster → recommendation table (skills involved | action | rationale citing finding ID | child ticket link). Versioned by run date — earlier plans are NOT overwritten; subsequent runs append a new `## Run YYYY-MM-DD` section.
6. **File child tickets.** Each surviving proposal becomes a child ticket via `ticket-manager.create-ticket`, with `related: [<this reorg ticket>]`. Expected fanout: 3–7 child tickets total; >10 means the 4Q filter is being misapplied — tighten before filing.
7. **Trigger skills-graph rebuild.** The `.skua/` dashboard server auto-rebuilds `.skua/cache/skills-graph.json` on next page load when SKILL.md mtimes are newer, so no manual rebuild is needed unless the user wants immediate verification (`cd .skua && bun run build:graphs`).

### Op-specific rules

- "No-op verdict" is a valid plan outcome and must be documented per step 4's stencil. Forcing recommendations against clean clusters is the failure mode this op prevents.
- Every child-ticket proposal must cite a finding-ID from the step-1 snapshot. Bare opinion is rejected.

---

## Operation: dry-run-portfolio-scan

Lightweight in-memory walk of every cluster — preview what `generate-reorg-plan` would propose without writing anything or filing tickets.

### Procedure

1. **Capture audit primitives in memory.** Call `skill-builder.audit-all` and `skill-builder.list-orphans`; hold the output in conversation context. Do NOT persist to `.skua/cache/`.
2. **Identify clusters.** Same grouping logic as `generate-reorg-plan` step 2 — shared prefix (`security-*`, `adr-*`, `skill-*`, `<domain>-*`), shared `connects_to` edges, P1/P2 overlap pairs.
3. **Per cluster, dry-run the propose-* ops.** Walk each `propose-merge` / `propose-rename` / `propose-retire` / `propose-orchestrator-wrap` candidate. Apply the 4Q filter inline. DO NOT call `ticket-manager.create-ticket` — record the would-have-filed verdict only.
4. **Emit a status report** in this shape:
   ```markdown
   ## Portfolio status (YYYY-MM-DD)

   **Inventory:** N skills. Existing orchestrators: M.

   ### Findings worth filing

   - **F-NNN (P0|P1|P2 — <short title>).** <One-paragraph description with skill slugs cited.> 4Q: pass.

   ### Findings NOT filed (4Q-downgraded)

   - **F-NNN (downgrade).** <Proposal.> 4Q: <which questions answered no>. Verdict: keep / document boundary.

   ### Suggested next step

   <One-paragraph recommendation: file a small cleanup ticket / no-op / further investigation.>
   ```
5. **No writes.** No file changes, no child tickets, no plan-doc entries. Pure read.

### Op-specific rules

- The "Findings NOT filed" section is mandatory even if empty (explicit `(none)`) — same anti-cosmetic-spawning principle as `generate-reorg-plan`'s no-op-verdict rule.
- If `skill-builder.audit-all` was skipped (reasoning-from-frontmatter only), declare it in the report's preamble — that mode misses body-level findings.

---

## Operation: sweep-connects-to

Mass refactor across the portfolio after a rename, merge, or retirement: updates every `connects_to:` reference to the affected slug.

### Procedure

1. **Take the operation as input.** Either `rename <old> <new>`, `merge <absorbed> <survivor>`, or `retire <slug>`. The operation determines the sweep behavior.
2. **Pull inbound edges.** Call `skill-builder.list-orphans` (which already lists broken edges) and check the current state. Then read `.skua/cache/skills-graph.json` for the comprehensive `connects_to` map.
3. **For each affected skill,** edit its SKILL.md frontmatter:
   - **Rename:** replace `<old>` with `<new>` in every `connects_to:` entry.
   - **Merge:** replace `<absorbed>` with `<survivor>` in every `connects_to:` entry. If the skill already lists `<survivor>`, dedupe.
   - **Retire:** remove `<slug>` from every `connects_to:` list.
4. **Edit frontmatter only.** Do not touch the body. Use the atomic-write pattern (Read + Edit) — never overwrite the whole file.
5. **Idempotent.** Re-running the same sweep is a no-op once edges are clean.
6. **Verify clean.** After the sweep, `skill-builder.list-orphans` should report zero broken edges related to the swept operation. Run it as the wrap-up step.
7. **Note in caller's child ticket** that the sweep was completed (file the timestamp in the ticket's `### Implementation Summary`).

### Op-specific rules

- Body text and `references/` files that mention the affected slug are NOT swept — those edits belong to the parent rename/merge/retire ticket.
- Only project-local edges sweep. User-scope skills under `~/.claude/skills/` are out of scope.

---

## Operation: audit-naming

Walks every `kind: orchestrator` skill in the portfolio and flags slugs that don't end in one of the three canonical suffixes defined in `references/NAMING_CONVENTION.md` (`-router`, `-review`, `-posture`). Also flags grandfathered exceptions that have drifted out of their exception entry.

### Procedure

1. **Load the convention.** Read `${CLAUDE_SKILL_DIR}/references/NAMING_CONVENTION.md` for: (a) the three canonical high-level suffixes, (b) the grandfathered-exception table, (c) the disallowed-suffix list.
2. **Enumerate high-level skills.** For every `.claude/skills/<slug>/SKILL.md`, parse frontmatter via `.skua/lib/frontmatter.ts:44 parse()`. Filter to `kind: orchestrator`.
3. **Classify each slug** into one of:
   - **conforming** — ends in `-router`, `-review`, or `-posture`.
   - **grandfathered** — listed in the exception table with a current justification.
   - **violation** — none of the above.
4. **Emit one finding per violation** in the form:
   ```markdown
   - **F-NAM-NNN (P1 — non-canonical suffix on `<slug>`).** Suffix `<suffix>` is not one of `-router`/`-review`/`-posture`. Based on body content, this skill appears to be a **<shape>** → recommend rename to `<proposed-slug>`. Hand off to `propose-rename` for the formal proposal.
   ```
5. **Inferring shape** for the recommendation: scan the SKILL.md body for these markers (cite the line/section that triggered the inference):
   - Has a "Routing rules" / "Routing decision" / "Routing format" section → `-router`.
   - Produces "a single principal-engineer report" / "merged report" / "synthesizer" → `-review`.
   - Persists snapshots to `.skua/cache/<name>-runs/` AND emits NEW/RESOLVED/PERSISTENT diff → `-posture`.
   - If two markers fire, recommend `-review` over `-router` (synthesis is the stronger claim). If `-posture` markers fire, recommend `-posture` regardless of other matches.
6. **Emit no findings on conforming or grandfathered slugs.** Honesty-rule: do not suggest a rename for a slug that is already correct — the audit's value is precisely catching the non-conforming cases.
7. **Output is read-only.** This op never edits SKILL.md files; it hands off proposals to `propose-rename` and the actual rename to a child ticket.

### When invoked from other ops

- `generate-reorg-plan` calls `audit-naming` as part of its snapshot phase and includes any findings in the per-cluster recommendations table.
- `skill-builder.create-skill` calls `audit-naming` with the **proposed** slug + `kind` to abort early on a suffix violation before scaffolding.

### Op-specific rules

- If shape is genuinely ambiguous, report `shape: unclear` rather than guessing — the user picks the rename target.
- Grandfathered exceptions are static: an exception requires an explicit edit to `NAMING_CONVENTION.md` first; do not pattern-match new slugs in.

---

## Operation: audit-edges

Walks every SKILL.md's `connects_to:` and `kind:` and flags drift against the conventions in `${CLAUDE_SKILL_DIR}/references/NAMING_CONVENTION.md` and `.claude/skills/skill-builder/references/CONNECTS_TO_CONVENTION.md`.

### Checks

1. **Multi-parent** (P0) — a target has `parent:` declared by ≥2 sources. The graph builder also emits this as a `multi-parent` warning; this op formalizes it as a P0 finding with the conflicting sources.
2. **Broken target** (P0) — a `connects_to` entry points at a slug that has no `.claude/skills/<slug>/` directory.
3. **Unknown edge prefix** (P1) — an entry has a `kind:slug` form where `kind` is not `parent` or `handoff`. (Bare slugs default to `handoff` and are not flagged.)
4. **Off-pattern `kind:` value** (P1) — a frontmatter `kind:` is set to a value not in the sanctioned set (`orchestrator`, `audit`, `action`, `generator`, `utility`, `specialized`, `workflow`, `leaf`).
5. **Orphan leaf without parent** (P2) — a `kind: audit` / `action` / `generator` leaf with zero inbound `parent:` edges. Either it belongs under a router/synthesizer and the edge is missing, OR it's an intentional standalone — confirm.
6. **Self-edge** (P1) — `connects_to:` lists the skill's own slug.

### Procedure

1. **Load the graph cache.** Read `.skua/cache/skills-graph.json`. If the cache mtime is older than the newest SKILL.md mtime (per `skillSourceMtimes()` in `.skua/lib/graphs/skills.ts`), run `cd .skua && bun run build:graphs` first — stale cache → stale findings.
2. **Walk every node + edge.** Apply the 6 checks above. For each finding, record: `(severity, check-id, source-skill, target-skill | n/a, one-line message)`.
3. **Emit a P0/P1/P2 report.** Group by severity. Each row cites the file(s) involved.
4. **Apply the 4Q filter on P2 findings.** Orphan-leaf P2s often downgrade to "intentional standalone" (e.g. `ticket-manager`, `repo-map`). Document why and demote to a "no-op verdict" plan entry rather than filing a child ticket.
5. **No writes.** This op is read-only; child tickets emit via `propose-rename` / `propose-merge` / direct edits at the user's discretion.

### When invoked from other ops

- `generate-reorg-plan` calls `audit-edges` as part of its snapshot phase. The per-cluster recommendations table includes any P0/P1 findings.
- `skill-builder.create-skill` should call `audit-edges <new-slug>` post-scaffold to confirm the new skill's edges and kind validate clean.

### Op-specific rules

- The graph builder already emits `multi-parent` warnings to `meta.warnings` — read them and reframe as P0 findings; don't reinvent.
- "No edges to validate" on an isolated skill is honest; do not manufacture orchestrator-wrap findings for known standalones (`repo-map`, `bug-scan`, `ticket-manager`).

---

## Prerequisites

- `.claude/skills/skill-builder/` is installed and functional (this skill consumes its primitives).
- `.skua/cache/skills-graph.json` is rebuildable (dashboard server can run, or `cd .skua && bun run build:graphs` works).
- `.skua/lib/frontmatter.ts` parser is available.
- `ticket-manager` is installed (for child-ticket emission).

## References

- `${CLAUDE_SKILL_DIR}/references/OP_TRIGGERS.md` — full alternate-phrasing trigger index for all 9 ops.
- `${CLAUDE_SKILL_DIR}/references/SKILL_OWNERSHIP_BOUNDARIES.md` — single-owner map of every verb between this skill and `skill-builder`. Read before adding any new op.
- `${CLAUDE_SKILL_DIR}/references/NAMING_CONVENTION.md` — canonical suffix convention for high-level skills (`-router` / `-review` / `-posture`) plus grandfathered exceptions. Source of truth for `audit-naming`.
- `.claude/skills/skill-builder/references/SKILL_AUTHORING.md` — general authoring rules (slug kebab-case, ≤64 chars, location). Defers to `NAMING_CONVENTION.md` for high-level suffix policy.
- `${CLAUDE_SKILL_DIR}/references/SKILL_OWNERSHIP_BOUNDARIES.md` is itself the canonical reference shape for the single-owner boundary doc this skill emits for a wrapped cluster.

## After every operation

- Re-read `${CLAUDE_SKILL_DIR}/references/SKILL_OWNERSHIP_BOUNDARIES.md` if the operation might have changed which skill owns which verb. Update the boundary doc FIRST if so, then propagate to affected SKILL.md bodies.
- The `.skua/` dashboard auto-rebuilds `skills-graph.json` on next page load; no manual invalidation needed unless verifying immediately.
