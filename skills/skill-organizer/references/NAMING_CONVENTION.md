# Skill Naming Convention

Project-local convention for `.claude/skills/` slugs. Owned by
`skill-organizer`; audited by `skill-organizer.audit-naming`; consumed by
`skill-organizer.propose-rename` and `skill-builder.create-skill`.

The convention exists because the suffix on a high-level skill's slug
should tell the user **what shape it is** without reading the
SKILL.md body. Five different suffixes for the same shape (`-orchestrator`,
`-review`, `-posture`, `-research`, `-graph`) is what motivated this doc.

## High-level skill shapes

A "high-level" skill is one with `kind: orchestrator` — it composes or
routes to other skills rather than doing the leaf work itself.

| Shape | Naming | Defining property | Examples |
|---|---|---|---|
| **Intent router** | `*-router` suffix | Takes a user request, picks which 1-N leaf skills to invoke, gets out of the way. Does no analysis itself. Body is dominated by a routing table. | hypothetical `backend-router`, `cloud-router`, `<domain>-router` |
| **One-shot synthesizer** | `*-review` suffix | Runs a fixed set of leaf skills in sequence, dedups + merges their findings into a single principal-engineer report. **No** cross-run state. | hypothetical `<domain>-review` |
| **Domain entry point** | plain domain noun (no suffix) | The user-facing entry point for an entire concern. May internally be a synthesizer with snapshot-over-time diffs, but the implementation shape is invisible to the user — they just say "security" or "data-health" to start the conversation. | `security`, `data-health` |

These are the only sanctioned naming shapes for `kind: orchestrator`
skills. Adding a fourth requires updating this doc first.

### Why these three shapes

- **`-router`** = picks one of N. User intent → dispatch. No own analysis.
- **`-review`** = runs all N + merges. Used when there are siblings (e.g. a `<domain>-router` and a `<domain>-review` co-existing over the same cluster — the dual-orchestrator pattern). The suffix disambiguates them.
- **Plain domain noun** = "this IS the domain." Used when the cluster has a single canonical orchestrator and adding a suffix is just internal jargon. The implementation may include synthesis + snapshot-over-time diffs, but those are characteristics, not naming requirements.

A `-posture` suffix is disallowed (e.g. prefer `security` over `security-posture`). Reason: it describes an implementation detail (snapshot-diff feature) the user doesn't care about, and the plain noun is more discoverable.

### Disallowed suffixes on `kind: orchestrator`

- `-orchestrator` — redundant with `kind: orchestrator`; doesn't telegraph shape. Use `-router`, `-review`, or plain domain noun.
- `-posture` — deprecated. Plain domain noun replaces it.
- `-research`, `-coordinator`, `-manager`, `-organizer` — too generic. Existing exceptions (`skill-organizer`, `adr-manager`, `ticket-manager`, plus a grandfathered `<layer>-schema-coordinator`) are grandfathered, see below.

## Leaf skill suffixes

Leaves are everything that isn't `kind: orchestrator`. The convention
here is looser — the suffix should describe **what the skill produces**:

| Suffix | Shape | Examples |
|---|---|---|
| `*-audit` | Read-only inspection that produces a P0/P1/P2 punch list. | `bug-scan`, `<layer>-schema-audit`, `<layer>-cost-audit` |
| `*-planner` | Produces a plan / scaffold, never executes. | a hypothetical `migration-planner` |
| `*-runner` | Dispatches an existing, well-defined operation. | a hypothetical `migration-runner` |
| `*-gate` | Pre-mutation check with a confirmation prompt. | a hypothetical `db-mutation-gate` |
| `*-scaffold` | Bootstrap / new-thing creator. | a hypothetical `payments-scaffold` |
| `*-catalog` | Living index of a domain. | a hypothetical `api-catalog` |
| `*-map` / `*-graph` | Codebase / dependency map or graph builder. | `repo-map` |
| domain-shape | Self-describing name; no suffix needed. | `bug-scan`, plus hypothetical `<layer>-data-model`, `route-stack-architect`, `acme-deploy` |

Leaf suffixes are advisory, not enforced. The `audit-naming` op only
flags suffix violations on `kind: orchestrator` skills.

## Grandfathered exceptions

| Slug | Suffix | Why exempt |
|---|---|---|
| `skill-organizer` | `-organizer` | Curation tool that proposes structural change; not a router, review, or posture. |
| `ticket-manager` | `-manager` | Lifecycle controller for an artifact (`.tickets/`), not a skill orchestrator. |
| `adr-manager` | `-manager` | Same shape as `ticket-manager` for ADRs. |
| a `<layer>-schema-coordinator` | `-coordinator` | Three-way contract enforcer (e.g. frontend ↔ DB row ↔ API model); not a router or review. |

New exceptions require a justification entry in this table and a
matching `propose-rename` 4Q downgrade in `PORTFOLIO_REORG_PLAN.md`.

## Naming a new high-level skill — the decision tree

1. Does the skill **invoke other skills**?
   - **No** → it's a leaf. Pick a leaf suffix above. STOP.
   - **Yes** → continue.
2. Does the cluster **already have another orchestrator** (e.g. you're adding `backend-review` next to `backend-router`)?
   - **Yes** → use `-router` or `-review` per shape so the slugs disambiguate.
   - **No** → continue.
3. Is this the **canonical user-facing entry point** for an entire concern (security, data-health, infra)?
   - **Yes** → use the plain domain noun (`security`, not `security-posture`).
   - **No** (it's a pure router with no siblings) → `*-router`.

## Prefix convention (advisory)

When a cluster has 3+ siblings, prefer a shared prefix so the cluster is
discoverable by lexical sort:

- `skill-*` (builder, generator, organizer)
- `adr-*` (manager, researcher)
- `<domain>-*` (e.g. effectiveness, implementation-audit, scaffold, catalog)
- a `<layer>-*` family (e.g. schema-coordinator, data-health-audit)

Prefix is not enforced by the audit op — it's a hint to the proposer.

## How this convention is enforced

- **At authoring time:** `skill-builder.create-skill` calls
  `skill-organizer.audit-naming <slug>` against the proposed slug and
  aborts on a suffix violation for `kind: orchestrator`.
- **At audit time:** `skill-organizer.audit-naming` walks every
  `kind: orchestrator` skill and reports violations as P1 findings.
- **At reorg time:** `skill-organizer.generate-reorg-plan` includes the
  `audit-naming` output in the run snapshot, so rename proposals for
  non-conforming slugs surface in the cluster recommendations table.

## References

- Decision precedent: `PORTFOLIO_REORG_PLAN.md` (worked example of
  renaming off-pattern `*-orchestrator` slugs to `*-router`).
- Sibling convention: `CONNECTS_TO_CONVENTION.md` (the `connects_to` +
  `kind` frontmatter fields these slugs participate in).
- Authoring guide: `.claude/skills/skill-builder/references/SKILL_AUTHORING.md`
  (general naming + location rules).
