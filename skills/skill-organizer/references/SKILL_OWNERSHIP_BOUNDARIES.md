# Sub-skill boundaries for `skill-organizer` ↔ `skill-builder` ↔ `skill-generator`

**Single source.** Every skill-management verb is owned by exactly one
skill. When `skill-organizer` or `skill-builder` says "what this skill
does NOT do," the target it points to is the owner listed here. If the
boundary changes, update this file FIRST, then propagate to each
affected skill's "When NOT to invoke" section and bump this file's
`Last updated:` date.

---

## 1 — Contract framing

The boundary between the three skill-management skills is
**per-skill primitive vs portfolio-level policy vs codebase-driven bootstrap**, not scope-split:

- **`skill-builder`** — *"work on one skill at a time, OR walk the
  portfolio as a read-only inventory operation."* Owns the inventory
  primitives that read `.claude/skills/**/SKILL.md` and produce
  findings.
- **`skill-organizer`** — *"act on portfolio-level structure of an
  existing portfolio."* Owns the policy decisions on top of inventory
  findings — merge, rename, retire, orchestrator wrap, mass `connects_to`
  sweep.
- **`skill-generator`** — *"propose an INITIAL portfolio shape for a
  target codebase, OR surface gaps for a partial portfolio."* Owns
  the codebase-introspection step that maps deploy units / data layers
  / cross-cutting concerns to skill-family candidates. The cold-start
  tier above the other two.

`skill-builder` is the foundation. `skill-organizer` and `skill-generator`
are both **consumers** of `skill-builder`'s inventory primitives — neither
walks `.claude/skills/` directly. The failure mode this prevents is N
skills with slightly different regexes producing disagreeing inventories
of the same source set (see `skill-builder/SKILL.md` standing constraints).

---

## 2 — Verb → owner table

Read down the rows. Each verb has exactly one **Owner**. The other
skill that needs the same signal must invoke the owner, not
re-implement.

### 2A — Per-skill authoring verbs (owned by `skill-builder`)

| Verb | Owner | Notes / handoff target |
|---|---|---|
| Scaffold a new skill from the template | `skill-builder` (`create-skill`) | Includes pre-scaffold overlap check; rejects P0 overlap. |
| Audit a single skill against the authoring checklist | `skill-builder` (`audit-skill`) | Severity-ranked P0/P1/P2 output. Calls `overlap-check` as a sub-step. |
| Validate frontmatter type/value correctness only | `skill-builder` (`validate-frontmatter`) | Lighter than `audit-skill`. |

### 2B — Portfolio inventory primitives (owned by `skill-builder`)

| Verb | Owner | Notes / handoff target |
|---|---|---|
| Score capability duplication between a candidate and the existing portfolio | `skill-builder` (`overlap-check`) | Lexical only (Jaccard + noun-phrase). Three tiers. |
| Walk every SKILL.md and emit per-skill finding counts | `skill-builder` (`audit-all`) | Includes portfolio totals + top-5 overlapping pairs. |
| List skills missing `when_to_use:`, `connects_to:`, or with broken edges | `skill-builder` (`list-orphans`) | Tabular output by slug. |

These are the **only** verbs that read `.claude/skills/**/SKILL.md`
directly. Both `skill-organizer` AND `skill-generator` MUST consume
their output rather than re-walk the directory.

### 2C — Portfolio policy verbs (owned by `skill-organizer`)

| Verb | Owner | Notes / handoff target |
|---|---|---|
| Evaluate whether two skills should collapse into one | `skill-organizer` (`propose-merge`) | Consumes `overlap-check`. 4Q filter gates. |
| Evaluate whether a skill's slug should change | `skill-organizer` (`propose-rename`) | Shorthand-first precedent. 4Q filter gates. |
| Evaluate whether a skill should be retired (deleted) | `skill-organizer` (`propose-retire`) | Consumes `list-orphans` + inbound-edge count from `skills-graph.json`. |
| Evaluate whether a cluster needs a new orchestrator | `skill-organizer` (`propose-orchestrator-wrap`) | Three documented patterns: composer-with-dedup, pure router, synthesizer. |
| Run an end-to-end portfolio reorganization pass | `skill-organizer` (`generate-reorg-plan`) | Drives every `propose-*` op; writes `PORTFOLIO_REORG_PLAN.md` + child tickets. |
| Mass-update `connects_to:` arrays across the portfolio after a rename/merge/retire | `skill-organizer` (`sweep-connects-to`) | Only op in `skill-organizer` that writes to other SKILL.md files. Frontmatter-only edits. |

### 2E — Codebase-introspection bootstrap verbs (owned by `skill-generator`)

| Verb | Owner | Notes / handoff target |
|---|---|---|
| Walk the TARGET codebase (deploy units / data layers / cross-cutting concerns) and emit a signal report | `skill-generator` (`introspect-codebase`) | Spawns a fresh `Explore` subagent for the walk; consumes a structured signal report. Distinct from `skill-builder.audit-all` which walks `.claude/skills/`, not the target codebase. |
| Map signal report → skill-family candidates using heuristics | `skill-generator` (`propose-portfolio`) | Cross-checks every candidate against the existing portfolio via `skill-builder.overlap-check` (no re-walk). |
| Map signal report → harness extras (`CLAUDE.md`, `.tickets/`, `.skua/`-style dashboard, convention files) | `skill-generator` (`propose-harness`) | Same overlap discipline — never proposes a harness extra that already exists. |
| Synthesize a markdown bootstrap plan composing the above | `skill-generator` (`generate-bootstrap-plan`) | Spawns a fresh `general-purpose` cold-reader validator subagent before the plan is written; fail → plan goes to `cache/plans/_stuck/`. |
| File one child ticket per proposed skill in an approved plan | `skill-generator` (`emit-child-tickets`) | Delegates each `create-ticket` call to `ticket-manager`. Only runs after explicit user approval — never auto-fires. |

`skill-generator` does NOT walk `.claude/skills/` directly (see §2B). It consumes `overlap-check` and `audit-all` from `skill-builder` for every inventory question.

### 2F — Sibling skills outside the skill-management trio (generic example)

The same single-owner discipline applies to any sibling cluster a reorg pass
touches, not just the three skill-management skills. Document each verb with one
owner; siblings that need the same signal invoke the owner. A generic shape:

| Verb | Owner | Notes / handoff target |
|---|---|---|
| Resolve a `<domain>`-shaped intent to one or more downstream skills | a `<domain>-router` | Routes-only. Pre-routing reads are advisory; never executes writes. |
| Map a route to its dependency chain (backend routes, query keys, tables, auth claims) | a `<layer>-data-model` | Current-state walk; consumes the `repo-map` dependency graph. |
| Security audit across the diff | `security` | Single audit skill; wraps the `/security-review` engine for detection and composes its findings into the board (dedup, severity bands, snapshot diff). No per-surface siblings. |

**Boundary notes (the pattern to copy):**
- A router does NOT do the leaf work itself — every check is delegated.
- A current-state audit stops at the boundary it owns; future-state design is a
  different owner.
- An audit that consumes the `repo-map` graph does NOT re-detect the structural
  warnings the graph already produces.
- All cleanup mutations route through a single mutation-gate skill — audits emit
  scripts, never execute.

When a real sibling cluster lands in this portfolio, add a dedicated §2x
sub-table for it following this shape (one owner per verb, explicit
"does NOT" boundary notes).

### 2D — Tickets, dashboards, graphs (owned elsewhere)

These verbs are NEITHER `skill-builder` NOR `skill-organizer` — flagged
here to head off scope drift.

| Verb | Owner | Notes |
|---|---|---|
| File child tickets for proposed actions | `ticket-manager` | `skill-organizer` calls `ticket-manager.create-ticket`. |
| Build / regenerate `.skua/cache/skills-graph.json` | `.skua/lib/graphs/skills.ts` (server-side) | Auto-rebuilt by dashboard server on SKILL.md mtime delta. Manual: `cd .skua && bun run build:graphs`. |
| Render the skills graph UI | `.skua/` dashboard (`/graphs/skills`) | — |

---

## 3 — Contested-verb resolutions

These are the conflicts most likely to surface during reorg work,
resolved here:

| Contested verb | Resolution | Why |
|---|---|---|
| Surfacing an overlap finding (P0/P1) | `skill-builder.overlap-check` produces the finding; `skill-organizer.propose-merge` acts on it | Detection ≠ policy. Same data, different next step. |
| "Should we rename X?" (informal question) | `skill-organizer.propose-rename` | Naming convention itself is documented in `skill-builder/references/SKILL_AUTHORING.md`, but the *decision* of whether a specific rename is warranted is a portfolio-policy call. |
| "Should we wrap the W family in an orchestrator?" | `skill-organizer.propose-orchestrator-wrap` | The orchestrator-design patterns are documented in `SKILL_AUTHORING.md` (composer / router / synthesizer); the *decision* of whether a specific cluster needs one is policy. |
| Editing another skill's `connects_to:` array | `skill-organizer.sweep-connects-to` | `skill-builder` never writes to other skills. Sweep is a one-direction mass refactor; `skill-builder` only reads. |
| Editing a single skill's own SKILL.md body | Neither — that's a ticket-driven action | Both skills propose changes; neither executes the multi-line body edit. The child ticket's `build-ticket` op does the edit. |

---

## 4 — Enforcement convention

For the contract to be enforceable mechanically:

1. `skill-organizer/SKILL.md`'s `When NOT to invoke` section explicitly
   names `skill-builder` as the owner of every primitive verb.
2. `skill-builder/SKILL.md` carries no symmetric "When NOT to invoke
   skill-organizer" section (skill-builder predates this boundary; it
   doesn't claim portfolio-policy verbs in its scope). The
   `connects_to: ["skill-organizer"]` edge alone signals the
   relationship.
3. This file is the **single source**. When a verb's ownership changes,
   edit here first, then propagate.
4. Each new op added to either skill MUST appear in §2 with an owner
   before it ships. An op without an entry here is a structural debt.

---

## 5 — Reading order for new contributors

When a contributor wants to add a new skill-management verb:

1. Read this file. If the verb already has an owner, extend that skill
   rather than file a new one.
2. If the verb is genuinely novel, add a row to §2 (or the appropriate
   sub-table), pick an owner, then propagate to that skill's body.
3. If the verb requires writing to another skill's SKILL.md, it almost
   certainly belongs in `skill-organizer` (per §2C/§3).
4. Bump `Last updated:` at the top.
