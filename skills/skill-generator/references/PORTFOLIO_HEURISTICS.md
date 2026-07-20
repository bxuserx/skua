# Portfolio Heuristics

How the `propose-portfolio` and `propose-harness` ops translate signals from `INTROSPECTION_SIGNATURES.md` into concrete skill-family + harness-extra proposals.

Each heuristic is a rule of the form: **if signal X is present, propose skill Y with rationale Z.** Heuristics are advisory, not prescriptive — the validator subagent will reject proposals that don't trace back to evidence.

---

## Per-deploy-unit heuristics

For each deploy unit detected, propose the following skill candidates. Each candidate has a `kind` and an upstream-evidence requirement.

| Candidate | When | Rationale |
|---|---|---|
| `security` | Always per deploy unit | OWASP-style audit of unit-specific surfaces (XSS for a frontend; OWASP API for a backend; container/deploy-target hardening for a containerized unit) — one `security` skill covers all units |
| `<unit>-data-model` | Unit reads OR writes a data layer | Maps unit-to-data-layer dependencies for the unit's perspective |
| `<unit>-orchestrator` | ≥3 child skills emerge for this unit | Single routing entrypoint for the unit's skill family |
| a `route-stack-architect`-style skill | Unit is a frontend that talks to a backend over HTTP routes | Per-route end-to-end design + drift audit |
| `<runtime>-stack` (container/deploy-target hardening for the unit's runtime) | Unit ships in a container (Docker / Compose / Podman / Colima) AND has local-dev complexity | Local-stack lifecycle orchestration |

Examples:
- A frontend deploy unit (Next.js, Vue, SvelteKit, …) → `security`, a `<unit>-data-model`, a `route-stack-architect`-style skill (if a backend HTTP target detected)
- A backend deploy unit (FastAPI, Express, Django, Spring, …) → `security`, a `<unit>-data-model`, a `<unit>-router` (if ≥3 skills for the unit)
- A containerized analytics service → `security` (folds in), a `<layer>-data-model`

---

## Per-data-layer heuristics

For each data layer detected, propose the canonical audit family.

| Candidate | When | Rationale |
|---|---|---|
| `<layer>-schema-audit` | Layer has typed schemas (BQ, Postgres, MySQL, ES) | Drift between declared schema and live state |
| `<layer>-data-integrity-audit` | Layer holds aggregate-able rows (BQ, Postgres, MongoDB) | Row-level integrity (FK orphans, scale violations, NULL anomalies) |
| `<layer>-stale-data-audit` | Layer is mutable and has multiple writers | Identifies abandoned tables, frozen partitions |
| `<layer>-cost-audit` | Layer charges per-query (BQ, AWS Athena, Snowflake) | Per-query cost tracking + budget alerts |
| `<layer>-data-health-audit` | Layer is a cache OR replica of another layer | Freshness, row-count drift, golden-row diff vs source |
| `<layer>-schema-coordinator` | Layer has a 3-way contract (e.g. FE display ↔ row shape ↔ API response model) | Three-way schema drift detection |
| a `db-mutation-gate`-style skill | Codebase has any destructive DB ops (`DROP`, `TRUNCATE`, etc.) | Pre-mutation impact report + confirmation gate |

Examples:
- A typed/columnar store (Postgres, BigQuery, Snowflake, …) → `<layer>-schema-audit`, `<layer>-data-integrity-audit`, `<layer>-stale-data-audit` + `<layer>-cost-audit` (only if the store charges per query)
- A relational store used as a cache layer (e.g. Postgres + sync-from-source) → `<cache-layer>-data-health-audit`, `<cache-layer>-schema-coordinator`
- A document store (Firestore, MongoDB, DynamoDB, …) → `<layer>-data-integrity-audit` only (no typed schemas, no per-query cost, no scans)

---

## Per-cross-cutting-concern heuristics

| Candidate | When | Rationale |
|---|---|---|
| `auth-flow-audit` | Authentication signals present (a managed auth provider — Firebase Auth / Auth0 / Cognito / Clerk — OAuth/OIDC, or JWT/session) | End-to-end audit of token flow, custom claims, impersonation surface |
| `subscription-tier-audit` | Subscription / billing signals present (any payments provider + a tier/role/entitlement mechanism) | Tier-gating coverage across routes |
| `security` | Multiple security-relevant surfaces emerge across units AND multiple cross-cutting concerns present | A single `security` skill that composes per-unit security audits |
| a `pattern-unifier`-style skill | Pipeline / computed-signal pattern signals present AND ≥2 such pipelines detected | DRY audit for repeated SQL/Python idioms |
| a `<layer>-cost-audit` skill | Cost-sensitive operation signals present | Standalone cost-tracking skill |
| a `log-driven-maintenance`-style skill | Observability — logging signals present AND deploy is Cloud Run / Lambda / similar | Periodic log audit for error-rate spikes |
| a `data-forensics`-style skill | Pipeline / computed-signal pattern AND data-layer audits proposed | Anomaly investigation skill: audit-surfaced finding → root cause → remediation plan |
| `data-health` | ≥3 data-health audits emerge | Orchestrator for data-health audits |

---

## Domain-specific heuristics (only fire when evidence is unambiguous)

| Candidate | When | Rationale |
|---|---|---|
| Per-`<domain>` lens skills (`<domain>-effectiveness`, `<domain>-scaffold`, `<domain>-audit`, `<domain>-catalog`) | Domain-specific computed-signal pattern detected (multiple `*_<thing>.py` files for the same domain OR a `<DOMAIN>_CATALOG.md`) | Per-domain lens skills |
| a `<domain>-tuning` skill | Association-rule / ranking knobs detected (e.g. `min_support`, `lift`, score thresholds) | Meta-strategy tuning |
| a `<domain>-router` + `<domain>-fe-display-audit` | Domain-strategy pattern AND a frontend that displays its output | Per-strategy + per-display audit |
| `<cache-layer>-data-health-audit`, `<cache-layer>-schema-coordinator` | A relational store used as a frontend cache layer detected (e.g. asyncpg + sync-from-source pattern) | Three-way contract + freshness skills |
| `repo-map` | A `.skua/`-style dashboard detected | Codebase / dependency graph builder |

These should only fire when the evidence is unambiguous — if the patterns are speculative, leave them out and surface the gap in the plan's "considered but skipped" section.

---

## Always-floor heuristics (the meta-portfolio floor)

Always propose if not already present:

| Candidate | Rationale |
|---|---|
| `skill-builder` | Per-skill authoring + the 5 inventory primitives. Foundation of the portfolio. |
| `skill-organizer` | Portfolio-level structural curation. Pairs with `skill-builder`. |
| `ticket-manager` | The `.tickets/` board. Required for the child-ticket emission step. |
| `skill-generator` | Self-reference — needed for the next bootstrap pass. |

---

## Cluster / orchestrator rules

- An orchestrator skill (`kind: orchestrator`) is justified ONLY if ≥3 child skills emerge under the same domain or family.
- Candidate orchestrators with <3 members → demote to `kind: utility` and skip the orchestrator-wrap proposal.
- Orchestrator naming: `<domain>-orchestrator`, `<domain>-posture`, `<domain>-review`, or the canonical noun for the family.

---

## Harness extras

| Component | When | Rationale |
|---|---|---|
| `CLAUDE.md` (skeleton) | Always | Project-tone + skill reference + canonical conventions |
| `.tickets/` 8-bucket structure | If no ticket flow detected | Aligned with `ticket-manager` |
| `.skua/`-style dashboard | If ≥10 skills proposed | Portfolio visualization + ticket board UI |
| `NUMERIC_CONVENTIONS.md` | If numeric-conventions signals detected | Single-source-of-truth for scale rules |
| `<FAMILY>_CONTRACT.md` (per pipeline/computed-signal family) | If pipeline / computed-signal patterns detected | Standing contract for the family |
| `ADRs/` directory | Always | Architectural decisions log |

Do NOT propose harness extras speculatively. Each must trace to a signal-report entry.

---

## Per-skill AC template

When `emit-child-tickets` files a ticket per proposed skill, the AC bullets are boilerplate from this template:

1. `.claude/skills/<slug>/SKILL.md` exists with valid frontmatter passing `skill-builder.validate-frontmatter <slug>`.
2. SKILL.md defines at least one operation with a Procedure subsection and an Honesty rules subsection.
3. `connects_to` graph is wired (parent orchestrator if applicable, sister skills if applicable).
4. Reference files (`references/*.md`) and templates (`templates/*.md`) exist if the SKILL.md cites them.
5. The skill produces output that matches its `description` claims when invoked against a test case.

Override per-skill if the proposed skill has unusual ACs (e.g. orchestrators need `connects_to` to point at all child skills).

---

## Honesty floor

- Heuristics are advisory. The validator subagent rejects any candidate that doesn't trace to evidence.
- A signal report with no deploy units OR no data layers OR no cross-cutting concerns indicates a too-sparse repo — propose only the meta-portfolio floor and stop.
- Never propose a skill family because "every project should have one" — every proposal needs at least one signal-report entry justifying it.
