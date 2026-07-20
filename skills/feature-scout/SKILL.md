---
name: feature-scout
description: "The generative counterpart to `bug-scan`: invents NEW features the user would value, grounded in the actual codebase. Fans out divergent 'product lens' agents (power-user, onboarding, adjacent-workflow, data-leverage, delight, integration), each proposing concrete features with a value hypothesis and a where-it-plugs-in citation; a judge panel scores them on value × fit × feasibility × novelty, de-dupes against the existing board + ADRs, and files the survivors as `ai-proposed` backlog tickets. Runs with ponytail OFF (diverge boldly — minimalism is for build time). Used on demand (`/feature-scout`) and auto-invoked by the chaos supervisor when the backlog drains."
when_to_use: "User says 'invent features', 'what should we build next', 'feature ideas', 'scout for features', '/feature-scout'. Also run automatically by the chaos supervisor when the backlog runs dry, so a self-sustaining run keeps finding work."
connects_to:
  - handoff:ticket-manager
kind: workflow
---

# Feature Scout

Skua seeds the backlog with **defects** (`bug-scan`). This is the missing **generative** seam: invent **features** worth building. Scan for bugs → *scout* for opportunity.

> **Ponytail is OFF here.** Your job is to *diverge* and maximize imagined product value. Ponytail governs implementation minimalism (HOW), never feature suppression (WHAT). Do NOT YAGNI-away ideas at this stage — propose boldly; leanness is applied later, at build time. Imagine expansively, build minimally.

The product contract (same discipline as `bug-scan`): every filed ticket is a **real, grounded** opportunity — cited to where it plugs into the actual code — never vague "wouldn't it be nice" filler. A backlog of phantom features is worse than an empty one.

## Arguments

`/feature-scout [N]` — file up to `N` features (default 5; the chaos supervisor passes its `max_generated_features` cap). Also honors a focus hint, e.g. `/feature-scout onboarding`.

## Procedure

### 1. Read the intent surface
Understand what this product *is* before imagining what it *could be*:
- `README.md`, `CLAUDE.md`, and the top-level layout.
- The dashboard's built **graphs** — `.skua/cache/*graph*.json` / `/graphs/dataflow`, `/graphs/ai-ecosystem`, `/graphs/schemas` — they map what the app does and what its data model already enables but no UI exposes (rich ground for "what it could do").
- Existing tickets across all `.tickets/*` buckets + `.tickets/ADRs/` — so you know what's already planned/built/decided.

### 2. Diverge (fan-out)
Spawn **3–5 fresh `Agent` subagents in parallel**, each a distinct **product lens**. Give each the intent-surface summary and ask for 2–4 concrete feature ideas, each with: a one-line **value hypothesis** ("users will find this useful because…"), and a **where-it-plugs-in** citation (`file:line` or the component/endpoint it extends).

Lenses (pick the ones that fit the product):
- **Power-user** — what would a daily heavy user want that doesn't exist yet?
- **New-user onboarding** — what smooths the first 10 minutes?
- **Adjacent-workflow** — the natural next step after what the app already does.
- **Data-leverage** — what does the schema/data already support that no feature surfaces?
- **Delight / polish** — small high-ratio touches that make it feel cared-for.
- **Integration / ecosystem** — connect to a tool the user clearly already uses.

These agents are read-only (propose, don't edit).

### 3. Converge (judge panel)
Score every candidate on four axes — **value** (to this user), **fit** (with the product's intent), **feasibility** (effort/risk), **novelty** (vs. what's already on the board). Then:
- **Adversarially de-dupe** against every existing ticket + ADR. If an idea overlaps something already in `0-backlog`…`7-archive` or an ADR, drop it. Re-runs must never refile.
- Keep the top **N** survivors (the arg / cap). If a candidate scores low on fit or feasibility, cut it — a smaller set of strong ideas beats a long thin list.
- **Saturation:** if nothing clears the bar (everything is duplicate or weak), say so explicitly and file nothing. This is the signal the chaos supervisor uses to stop generating.

### 4. File the survivors
For each, create a backlog ticket via the CLI (the same allocator the board uses):

```bash
bun .skua/scripts/ticket-cli.ts create \
  --title "<concise feature title>" --domain <app|infra|docs|meta> \
  --priority <High|Medium|Low> --complexity <1-5> \
  --tags feature,ai-proposed \
  --body-file <tmp.md>
```

The body (`--body-file`) must contain the standard **Objective** + **Context** (with the where-it-plugs-in `file:line`) + **Acceptance Criteria**, plus a **`### Value Hypothesis`** block:

```markdown
### Value Hypothesis
**Lens:** <which product lens surfaced this>
**Who benefits:** <the user / persona>
**Why useful:** <one or two sentences — the bet>
**Plugs in at:** <file:line or component/endpoint>
**Score:** value <h/m/l> · fit <h/m/l> · feasibility <h/m/l> · novelty <h/m/l>
```

The **`ai-proposed`** tag is mandatory — it lets the human filter "what the AI invented" from human-requested work, even though chaos will build it.

### 4a. Full-stack features → propose contract-first

If a proposed feature spans the stack (DB + API + UI) and shares a contract with other work, don't file it as one vague xl ticket — propose it the way chaos will build it:
- A **foundation ticket** (tags `feature,ai-proposed,architecture`) for the shared contract — the data model / API surface / shared types — noted to carry an ADR. The `architecture` tag makes the supervisor build it **alone, first**.
- **Loosely-coupled feature tickets** that `depends_on` the foundation, each an internally-coherent slice (its own coupled layers together), each **≤ complexity 3**.

Tightly-coupled layers that change as a unit stay in ONE ticket. If you can't see a clean seam, file the single coherent ticket and let the chaos worker decompose it at build time.

### 5. Report
List what was filed (id · title · one-line value), what was de-duped, and whether the pass saturated. Don't paste full bodies.

## Honesty rules
- Every idea cites where it plugs in. If you can't ground it in the code, it's not ready — drop it.
- De-dupe is the whole game. Refiling an existing idea pollutes the backlog; check all buckets + ADRs before filing.
- Saturation is a valid (and common) outcome. Say "nothing novel this pass" rather than padding with weak ideas.
- You file backlog tickets only — never write code, never build. Chaos (or a human) decides what to build.
