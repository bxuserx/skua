Check matrix for `validate-adr`. The lib (`.skua/lib/adrs.ts:validateAdr`)
implements these; this file is the human-readable spec.

| dimension | what passes |
|---|---|
| **Schema** | All required frontmatter fields present (`id`, `title`, `status`, `created`, `deciders` non-empty). `decided` set iff status ∈ `{accepted, rejected}`. |
| **FSM** | Current status ∈ valid enum. `superseded_by` set iff status = `superseded`. |
| **References** | Every `supersedes[]` ID exists in `.tickets/ADRs/`. Every `related_tickets[]` ID exists in `.tickets/`. Every `materialized_tickets[].ticket_id` exists. |
| **Body** | TL;DR block present. Has at least one of Context / Decision / Consequences. Alternatives considered present unless trivially-single-option decision. |
| **Draft graph integrity** | `proposed_tickets[]` entries have unique `draft_id` within this ADR. `depends_on` entries are either `DRAFT-N` (within same ADR) or existing `TKT-NNN`. |

Severities:

- **P0** — blocks transition (schema / FSM violation).
- **P1** — reference drift (warning; transition proceeds with flag).
- **P2** — body completeness suggestion (advisory; never blocking).
