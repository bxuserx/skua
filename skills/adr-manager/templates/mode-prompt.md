Verbatim mode prompt used by `create-adr` and `enrich-adr`. Ask exactly
this; wait for the answer; do not pick silently.

> **Researcher / User-Driven / Agentic? (R / U / A)**
>
> **R** — I'll WebSearch reputable sources (Nygard, Fowler, AWS/GCP/Azure
> architecture frameworks, OWASP, pattern catalogs, vendor docs), read
> every relevant `plans/`, `CLAUDE.md`, and
> sibling ADR, then synthesize Context / Decision / Consequences /
> Alternatives + draft a `proposed_tickets[]` fan-out. Stops at
> "enriched, status=proposed" — you review and decide.
>
> **U** — User-Driven. Codebase-only. I'll read `.tickets/ADRs/` for
> prior art, scan the relevant code paths, walk the ticket history, and
> synthesize from what's already known internally. No web fetches.
> Stops at "enriched, status=proposed" — you review and decide. Faster,
> used when you've already done the external thinking.
>
> **A** — Agentic. Runs the R-mode synthesis end-to-end, AND continues
> past enrichment without further prompts: validates, transitions
> `proposed → accepted` (which auto-fires `promote-draft-tickets`),
> reports the freshly-minted `TKT-NNN` IDs. No mid-flow gates. Use when
> you're delegating the decision.

Acceptable replies: `R` / `researcher`, `U` / `user-driven` / `user`,
`A` / `agentic` / `auto`. Anything else → re-ask.
