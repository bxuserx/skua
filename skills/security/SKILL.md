---
name: security
description: "Proactive, whole-repo security audit built on the stack-agnostic `/security-review` engine. Runs the engine over the codebase, then composes raw findings into one posture report: CVSS-anchored severity, deduplication via (CWE, normalized-resource) key, open-ticket lookup (links to existing TKT-NNN), snapshot diff vs prior run (NEW / RESOLVED / PERSISTENT with days-open), suppression rules with mandatory expiry, and auto-draft of NEW P0s lacking a ticket into `.tickets/scratch/`. Stack-agnostic — no per-framework, per-language, or per-cloud assumptions. Read-only; does NOT execute fixes."
when_to_use: "User says 'audit security', 'full security review', 'is the system locked down?', 'what's our security posture?', 'security posture diff', 'what's new since last audit?', 'plan a security audit' (dry-run), or 'draft tickets for the P0s'."
connects_to:
  - handoff:ticket-manager
kind: audit
---

# Security

Whole-repo security posture audit.

Skua does **not** maintain its own bank of stack-specific security checks. Detection is delegated to the **`/security-review` engine** — Claude Code's built-in, language- and framework-agnostic security reviewer (open source: [`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review), MIT). It reasons about data flow, auth/authorization boundaries, injection sinks, secrets, crypto, and config across ANY stack, so there is nothing per-framework to keep up to date here.

This skill owns the part the engine does **not** do: **composing** raw findings into a deduplicated, severity-ranked, ticket-aware posture report and filing NEW criticals into the board. So: `/security-review` **finds**; `security` **composes + integrates with `.tickets/`**.

Body holds the run + composition procedure; detail lives in `${CLAUDE_SKILL_DIR}/references/`.

## When to invoke

- "audit security" / "full security review" / "is the system locked down?" → `op=full-sweep`
- "plan a security audit" / "what would full-sweep run?" → `op=plan` (dry-run; engine not invoked)
- "what's new since last audit?" / "security posture diff" → `op=diff` (re-runs the engine; emits only NEW / RESOLVED sections)
- "draft tickets for the P0s" → `op=draft-tickets` (uses last snapshot; does NOT re-run the engine)

## When NOT to invoke

- **Quick per-PR / per-diff check with no ticket integration** — run `/security-review` directly; you don't need this composition layer.
- **Pen testing / live exploits** — out of scope; the engine is static + read-only.
- **Fix execution** — this produces the merged report; the user remediates.
- **Cloud / infrastructure config audit** (IAM, network, datastore access rules, secret-store posture) — an LLM code reviewer does not replace an infrastructure/config scanner. Use a dedicated IaC tool (e.g. Checkov, Trivy, tfsec) for that surface; it is out of scope here.

## Inputs

| param | default | meaning |
|---|---|---|
| `op=<name>` | `full-sweep` | `full-sweep`, `plan`, `diff`, or `draft-tickets` |
| `scope=<path-or-diff>` | whole repo | restrict the engine to a path, or to `git diff <ref>` for a change-scoped audit |
| `severity=p0\|p1\|p2\|all` | `all` | filter merged output |
| `format=markdown\|json` | `markdown` | output format |
| `since=<ISO-date>` | last snapshot | for `diff` op — compare against the snapshot from a specific date |
| `drafts_to=inline\|scratch` | `inline` | where to emit draft tickets: inline in the report, or as files in `.tickets/scratch/` (dashboard's quick-create surface) |

## Procedure

### 0. Read references

Read in order: `${CLAUDE_SKILL_DIR}/references/CVSS_SCORING.md`, `${CLAUDE_SKILL_DIR}/references/MERGED_OUTPUT_FORMAT.md`, `${CLAUDE_SKILL_DIR}/suppressions.yaml`. Read `${CLAUDE_SKILL_DIR}/references/DRAFT_TICKET_TEMPLATE.md` only if `op` will emit drafts.

### 1. Resolve scope from intent

From `op=` + intent keywords:

- `plan` → emit the resolved scope + the planned engine invocation + cached-snapshot context, then STOP. Engine not run.
- `full-sweep` → audit the whole repo (or the `scope=` path if narrowed).
- `diff` → same scope as the last snapshot's run (so the comparison is apples-to-apples).
- `draft-tickets` → DO NOT re-run the engine; load the last snapshot from `.skua/cache/security-runs/` and emit drafts from its findings.

### 2. Run the detection engine

Invoke the **`/security-review`** command over the resolved scope and capture its findings.

- The vendored `/security-review` command reviews the **branch diff against `origin/HEAD`** (its native, fastest mode) — ideal for `op=diff` and change-scoped audits. Pass `scope=git diff <ref>` to compare against a different base.
- The engine is **stack-agnostic** — it reasons about the code rather than matching hardcoded patterns; there are no per-framework/per-language/per-cloud greps to maintain in skua.
- **Whole-repo / no-remote / engine absent:** the vendored command is diff-oriented, so for a `full-sweep` over the whole tree (a repo with no remote, or where `/security-review` isn't installed), run the equivalent semantic review inline — apply the command's methodology (OWASP / CWE, data-flow reasoning across all source files), never a fixed per-stack pattern list. Note in the report which path was used.

**Output handling.** The engine emits markdown findings, each carrying: a `file:line` citation, a severity (`HIGH` / `MEDIUM` / `LOW`), a category (e.g. `sql_injection`, `xss`, `auth_bypass`), a description + exploit scenario, and a recommendation. Parse each into `{severity, category, cwe (map from category when not explicit), cite, detail, fix}`. Map engine severity to skua bands: `HIGH`→P0, `MEDIUM`→P1, `LOW`→P2 (preserve any explicit CVSS vector the engine supplies; never fabricate one).

**Engine failure:** if the engine errors or returns nothing parseable, record `{status: "failed", error_text}` and emit a baseline report noting detection did not complete. Never invent findings to fill the gap.

### 2.5. Open-ticket cross-reference scan

BEFORE composition, build an open-ticket map so the audit can link findings to existing tickets instead of drafting duplicates.

- Glob `.tickets/{0-backlog,1-staging,2-stuck,3-building,4-testing,5-validating}/TKT-*.md` (NOT `6-complete` or `7-archive` — those are closed work).
- For each ticket, parse frontmatter: read `tags`. If `tags` contains `security`, extract `id` (TKT-NNN) and the ticket title.
- Read the ticket body's `### Context` section; grep for `CWE-NNN` mentions and file paths cited.
- Build a map: `{(cwe, normalized_resource_glob)} → TKT-NNN`.

When a finding's `(cwe, normalized_resource)` matches an open-ticket entry, stamp the finding with `related_tickets: [TKT-NNN]` and skip auto-draft in step 3e.

### 3. Composition — five responsibilities, applied in order

**3a. Scoring normalization (CVSS-anchored).** Look up each finding's severity band in `references/CVSS_SCORING.md`. If the engine supplied a `cvss` vector, preserve it. Never fabricate. If the same finding surfaces twice with different severities post-dedup, take the higher and emit an informational note ("severity mismatch on `<id>`").

**3b. Deduplication.** Findings sharing `(cwe, normalized_resource)` collapse to ONE entry. Worked example (stack-neutral): one finding flags an order-lookup handler that reads an ownership flag from the datastore as truth; another flags the same handler's missing object-level authorization check — both CWE-285 on the same resource → merge to one entry. **Normalized resource** = strip line ranges (`orders.py:106-156` → `orders.py`), strip a leading source-root prefix (`src/`, `app/`, `backend/`, `frontend/`, …), lowercase. Never collapse across distinct CWE IDs.

**3c. Suppression.** Apply `suppressions.yaml` post-dedup:
- Match + future expiry → "Suppressed" section
- Match + past expiry → emit at normal severity + separate P2 "expired suppression — review or renew"
- No match → emit at normal severity
- Never silently drop

**3d. Snapshot diff.** Load the most-recent prior snapshot from `.skua/cache/security-runs/<latest>.json` (use `since=<ISO-date>` if provided). For each finding (post-dedup, post-suppression):
- Present this run AND last run, same `id` → `PERSISTENT` with `days_open = now - first_surfaced` (carry `first_surfaced` forward across snapshots)
- Present this run, absent last run → `NEW` (`first_surfaced = now`)
- Absent this run, present last run → `RESOLVED` (lift entry from last snapshot for the report; remove from this snapshot)

**Stable finding `id` derivation:** `id = "<cwe-lower>-<resource-slug>"` where `resource-slug` is the normalized resource with `/.,:_` → `-` and lowercased. Example: `cwe-285-orders-handler`. **Limitation:** if a file is renamed or moved, the id changes and the finding flips NEW. Documented known limitation; mitigate by keeping fix sketches stable so a renamed-file finding is recognizably the same to a reader.

If no prior snapshot exists: emit baseline (no diff section).

**3e. Auto-draft tickets.** For every NEW P0 finding WITHOUT a matching open ticket (per step 2.5 map):
- Emit a draft ticket body per `references/DRAFT_TICKET_TEMPLATE.md`
- If `drafts_to=inline` (default): include in the "Draft tickets" report section
- If `drafts_to=scratch`: write to `.tickets/scratch/draft-security-<finding-id>-<ISO-date>.md` and emit the path in the report

NEW P0 findings WITH a matching open ticket get a "Related ticket: TKT-NNN" line in the main entry and are NOT drafted. This prevents duplicate-ticket spam from already-known issues.

### 4. Persist snapshot

Write findings to `.skua/cache/security-runs/<ISO-timestamp>.json`. Schema in `references/MERGED_OUTPUT_FORMAT.md`.

**Auto-prune:** after writing the new snapshot, if more than 30 snapshots exist, delete the oldest until 30 remain. (Writes are 1 snapshot create + N old-snapshot deletes, all confined to `.skua/cache/security-runs/`.)

### 5. Emit report

Format per `references/MERGED_OUTPUT_FORMAT.md`. Order: header (summary + diff) → P0 → P1 → P2 → Suppressed → Resolved → Persistent → Engine failure (if any) → Draft tickets (if any).

### 6. Always-run wrap-up

- **Suppression hygiene:** expired suppressions → surface prominently.
- **Engine recap:** if the engine failed or was absent (fallback used), say so and how to fix (install / vendor `/security-review`).
- **Diff teaser:** if `op=full-sweep`, suggest re-running with `op=diff` to see what changed.
- **Schedule suggestion:** if more than 14 days since the last full-sweep, suggest configuring a recurring run via `/schedule` or `/loop`.

## Engine output contract (markdown)

The orchestrator parses the `/security-review` engine's markdown output. Each finding block carries, at minimum:

- a `file:line` citation,
- a severity (`HIGH` / `MEDIUM` / `LOW`),
- a category string (e.g. `sql_injection`, `xss`, `auth_bypass`, `ssrf`, `hardcoded_secret`),
- a description + exploit scenario,
- a recommended fix.

The orchestrator maps category→CWE when a CWE isn't explicit, handles missing keys gracefully (default to empty string), and normalizes severity to P0/P1/P2. If a future engine version emits JSON/SARIF, switch to schema parsing and pass `format=json`; until then, markdown parsing is canonical.

## Suppression scope

One layer: `${CLAUDE_SKILL_DIR}/suppressions.yaml` — the audit-wide allowlist for known, intentional non-findings (e.g. an intentionally-public client SDK config, a dev-only placeholder secret). Every entry carries a mandatory `expires` date; the suppression scan runs AFTER dedup, so a suppression matches the merged entry. Never silently drop a finding — suppressed items appear in their own report section.

## Output format

See `references/MERGED_OUTPUT_FORMAT.md` for the full markdown + JSON schema. Top-level sections in order:

1. Header (project, scope, totals, diff summary, snapshot path)
2. `## P0 — Immediate` — one block per merged finding
3. `## P1 — Soon`
4. `## P2 — Defense in depth`
5. `## Suppressed (N)` — per-suppression breakdown
6. `## Resolved since last run (N)` — lifted from last snapshot
7. `## Persistent (N findings, avg days_open: X)` — table form
8. `## Engine failure` — only if detection did not complete
9. `## Draft tickets (M NEW P0 findings)` — only if any NEW P0 lacks an open ticket

JSON mode emits the same fields as one document with top-level `findings`, `suppressed`, `resolved_since_last_run`, `draft_tickets` arrays plus `scope` + `diff` metadata.

## Coexistence with /security-review

- **`/security-review`** (built-in) on its own — fast, change-scoped review of `git diff`. No dedup, no ticket linking, no history. Reach for it for a quick pre-push check.
- **`security`** (this skill) — wraps the same engine for a **proactive, whole-repo** audit, then adds skua's composition: dedup, CVSS bands, open-ticket linking, snapshot diff, suppressions, and auto-draft into `.tickets/`.

Same detection engine underneath; this skill adds the posture-tracking + board integration. For "diff since last system audit," use `op=diff` here.

## Prerequisites

- The **`/security-review`** command is available. skua vendors it into `.claude/commands/security-review.md` at setup (from [`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review), MIT); it is also a Claude Code built-in. If absent, this skill falls back to an inline semantic review.
- `.skua/cache/` exists (the dashboard creates it; this skill creates `security-runs/` lazily).
- `${CLAUDE_SKILL_DIR}/references/{CVSS_SCORING,MERGED_OUTPUT_FORMAT,DRAFT_TICKET_TEMPLATE}.md` + `suppressions.yaml` ship with this skill.

## References

- `${CLAUDE_SKILL_DIR}/references/CVSS_SCORING.md` — score band → severity mapping.
- `${CLAUDE_SKILL_DIR}/references/MERGED_OUTPUT_FORMAT.md` — exact merged-report schema (markdown + JSON), finding shape, stable-id rule, snapshot file format.
- `${CLAUDE_SKILL_DIR}/references/DRAFT_TICKET_TEMPLATE.md` — auto-drafted ticket body template. Mirrors `ticket-manager/templates/ticket-template.md`.
- `${CLAUDE_SKILL_DIR}/suppressions.yaml` — audit-wide suppression allowlist.

External:
- `/security-review` engine — https://github.com/anthropics/claude-code-security-review
- CVSS v3.1 — https://www.first.org/cvss/v3-1/specification-document
- CWE Top 25 (2023) — https://cwe.mitre.org/top25/archive/2023/2023_top25_list.html

In-repo:
- `.claude/skills/ticket-manager/templates/ticket-template.md` — base template for draft conformance.

## After every operation

1. **Suppression hygiene:** expired suppressions → surface prominently.
2. **Cache hygiene:** auto-prune kept `.skua/cache/security-runs/` at ≤30 snapshots; mention how many were pruned this run.
3. **Engine recap:** if `/security-review` failed or was absent, state the fix (install / vendor it).
4. **Open-ticket alignment:** if any NEW P0 lacked a matching open ticket (and was auto-drafted), recommend filing via `ticket-manager` or the dashboard's scratch-pad quick-create.
5. **Read-only invariant:** writes are confined to `.skua/cache/security-runs/` (snapshot + auto-prune deletes) AND optionally `.tickets/scratch/` (only if `drafts_to=scratch`). NEVER mutate cloud/infrastructure, NEVER auto-file tickets to `0-backlog`, NEVER edit source code.
