# Merged Output Format

Canonical schema for the `security` skill's output. Both markdown (user-facing) and JSON (snapshot persistence, future tooling).

Detection comes from the stack-agnostic `/security-review` engine; this skill composes the engine's raw findings (dedup, severity, snapshot diff, suppressions, drafts). All examples below are **stack-neutral illustrations** — substitute whatever the audited repo actually is.

## Markdown format

```markdown
# Security Posture Report — YYYY-MM-DD HH:MM

**Project:** <project>
**Scope:** whole repo  (or: `git diff <ref>`)
**Total findings:** N (P0: X, P1: Y, P2: Z, suppressed: W)
**Diff vs last run (<ISO-date>, <N> days ago):** +A new, -B resolved, =C persistent
**Snapshot saved:** .skua/cache/security-runs/<ISO-timestamp>.json

## P0 — Immediate

### Missing object-level authorization on the order-lookup handler
- **CWE:** CWE-285 Improper Authorization
- **OWASP:** A01 Broken Access Control
- **CVSS:** 8.8 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H)
- **Cite:** `<orders-handler>:88` — reads an ownership flag from the datastore but never checks the requester owns the record
- **Status:** PERSISTENT (3 days open, first surfaced 2026-05-20)
- **Suggested fix:** Enforce object-level authorization server-side (verify `record.owner == requester`); do not trust a client-writable field as the authorization source of truth.
- **Related tickets:** TKT-NNN (if one exists)
- **Draft ticket:** see "Draft tickets" section (NEW P0s only)

### Webhook handler does not verify the payload signature
...

## P1 — Soon

### No security response headers configured
...

## P2 — Defense in depth

### Verbose error responses leak stack traces
...

## Suppressed (N findings)

- `client-sdk-config-public` × 6 — client SDK config is public-by-design per the vendor's docs; the security boundary is server-side rules. Expires 2026-11-22.
- `service-public-ingress` — public ingress is intentional; auth is enforced at the app layer. Expires 2026-11-23.
- `dev-shared-secret-placeholder` — dev-mode placeholder; production injects the real value from the secret store. Expires 2026-08-01.

## Resolved since last run (N)

- `Secret key in client bundle` — was P0 on 2026-05-15; absent in this run. Likely fixed in TKT-XXX.

## Persistent (N findings, avg days_open: X)

| Finding | Cite | Severity | Days open | Related ticket |
|---|---|---|---|---|
| Missing object-level authz | `<orders-handler>` | P0 | 3 | TKT-NNN |
| Missing security headers | `<server-config>` | P1 | 1 | TKT-NNN |
| ... | | | | |

## Engine failure (if any)

- `/security-review` did not complete: `<error_text>`. Detection is incomplete for this run; re-run after resolving, or rely on the fallback inline review noted in the header.

## Draft tickets (NEW P0 findings only)

<one block per draft, formatted per references/DRAFT_TICKET_TEMPLATE.md>

User reviews each draft and files via `ticket-manager`. The skill does NOT auto-file to a lifecycle bucket.
```

## JSON format

The snapshot file `.skua/cache/security-runs/<ISO-timestamp>.json` has this schema:

```json
{
  "schema_version": "1.0",
  "run_timestamp": "2026-05-23T00:15:00Z",
  "project": "<project>",
  "scope": "whole-repo",
  "engine": {"name": "security-review", "status": "ok"},
  "totals": {"p0": 1, "p1": 4, "p2": 5, "suppressed": 8},
  "diff_vs": "2026-05-22T00:00:00Z",
  "diff": {"new": 0, "resolved": 1, "persistent": 9},
  "findings": [
    {
      "id": "cwe-285-orders-handler",
      "severity": "P0",
      "cwe": "CWE-285",
      "owasp": "A01",
      "category": "auth_bypass",
      "cvss": {"vector": "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", "score": 8.8},
      "sources": [
        {"cite": "<orders-handler>:88", "category": "auth_bypass", "detail": "..."}
      ],
      "status": "PERSISTENT",
      "first_surfaced": "2026-05-20T00:00:00Z",
      "days_open": 3,
      "suggested_fix": "...",
      "related_tickets": ["TKT-NNN"]
    }
  ],
  "suppressed": [
    {
      "id": "client-sdk-config-public",
      "matched_findings": 6,
      "reason": "...",
      "expires": "2026-11-22"
    }
  ],
  "resolved_since_last_run": [
    {"id": "cwe-798-client-bundle", "was_severity": "P0", "last_seen": "2026-05-15T00:00:00Z"}
  ],
  "draft_tickets": [
    {"finding_id": "...", "body": "<markdown ticket template>"}
  ]
}
```

## Finding shape (canonical)

Every finding object MUST have:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier — derivation rule below. Used for dedup + diff. |
| `severity` | `P0` / `P1` / `P2` | Severity band (per `CVSS_SCORING.md`), mapped from the engine's HIGH/MEDIUM/LOW. |
| `cwe` | string | `CWE-NNN` if assignable (map from the engine's category when not explicit). |
| `owasp` | string | `API #N` (2023) / `A0N` (2021), if assignable. |
| `category` | string | The engine's category string (e.g. `sql_injection`, `xss`, `auth_bypass`). |
| `cvss` | object | `{vector, score}` if the engine supplied one; otherwise omit. |
| `sources` | array | One or more cites that merged into this finding. Each has `cite`, `category`, `detail`. (Usually one; >1 after dedup.) |
| `status` | `NEW` / `PERSISTENT` / `RESOLVED` | Set by the snapshot-diff step. |
| `first_surfaced` | ISO date | When this finding first appeared across runs. |
| `days_open` | int | `now - first_surfaced` in days. |
| `suggested_fix` | string | The engine's recommendation (synthesized if multiple sources). |
| `related_tickets` | array of TKT-NNN | Cross-references. Populated by the open-ticket lookup (SKILL.md procedure 2.5). |
| `has_open_ticket` | bool | Convenience: any related ticket is in `0-backlog`/`1-staging`/`2-stuck`/`3-building`/`4-testing`/`5-validating`. Drives auto-draft skip in step 3e. |

## Stable id derivation

`id = "<cwe-lower>-<resource-slug>"` where:
- `cwe-lower` = `"cwe-285"` (the digits, lowercased)
- `resource-slug` = the **normalized resource** with `/`, `.`, `,`, `:`, `_` → `-`, lowercased, with a leading source-root prefix (`src-`, `app-`, `backend-`, `frontend-`, …) stripped (matches the dedup normalization in SKILL.md step 3b)

Examples (stack-neutral):
- `src/orders/handler.py:88` → normalized `orders/handler.py` → slug `orders-handler-py` → id `cwe-285-orders-handler-py`
- `app/api/orders.ts:42` → normalized `api/orders.ts` → slug `api-orders-ts` → id `cwe-285-api-orders-ts`

Dedup uses the `(cwe, normalized_resource)` pair: two findings with the same CWE on the same normalized resource merge into one entry with multiple `sources`. Findings with the same CWE on *different* resources stay separate.

**Limitation:** if a file is renamed or moved, the id changes and the finding flips NEW in the next snapshot. Known weakness. Mitigate by keeping `suggested_fix` text stable across renames (so a reader recognizes the finding), or accept one cycle of NEW/RESOLVED churn on a real rename.

## Engine output contract (markdown)

The `/security-review` engine emits markdown findings; this skill parses them. Per finding:
- Sections delimited by severity (`HIGH` / `MEDIUM` / `LOW`), mapped to `P0` / `P1` / `P2`.
- Each finding carries a `file:line` cite, a category (e.g. `sql_injection`, `xss`, `auth_bypass`, `ssrf`, `hardcoded_secret`), a description + exploit scenario, and a recommended fix.
- The parser maps category→CWE when no CWE is explicit, and handles missing fields gracefully (default to empty string).

If a future engine version emits JSON/SARIF, switch this contract to schema parsing and pass `format=json`; until then, markdown is canonical.

## Snapshot retention

- Snapshots in `.skua/cache/security-runs/` accumulate over time.
- The skill **auto-prunes** to keep the latest 30 snapshots after each new write (oldest first by ISO timestamp).
- `diff` op uses the most-recent prior snapshot by default; `since=<ISO-date>` selects an earlier snapshot (if still retained).
- Snapshots contain NO PII beyond repo-relative resource paths and CWE IDs.
- Snapshot file size: roughly 5–20 KB per run; 30 snapshots × ~15 KB ≈ ~450 KB total — small.

## What this file does NOT specify

- A JSON/SARIF engine output schema (when the engine supports it) — switch the parser when it lands.
- Markdown rendering details (header styling, etc.) — structure matters more than typography.
- Tooling that reads these snapshots — none today; the format is future-proofed for a `.skua/` dashboard view if/when added.

## Snapshot file format (`.skua/cache/security-runs/<ISO>.json`)

The on-disk snapshot is the JSON document shown above, written verbatim. Filename = `YYYY-MM-DDTHH-MM-SSZ.json` (ISO 8601 with `-` instead of `:` for filesystem safety). Top-level `schema_version: "1.0"`; bump + add a migration note here if the schema ever breaks compatibility.
